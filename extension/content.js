const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'PRE', 'TEXTAREA', 'INPUT',
  // Form controls whose text is the submitted value or a label attribute;
  // injecting child spans into <option> would corrupt form submissions.
  'SELECT', 'OPTION', 'OPTGROUP',
]);

// Inline code-like elements: their text contributes to the surrounding
// sentence so the translator sees a coherent input (e.g. inline backticks in
// markdown produce <code>foo</code> mid-prose; without this, "Use the foo
// command." would split into "Use the" and "command." and translate as two
// fragments). The element itself is not modified, so the code text stays
// verbatim. <pre> remains in SKIP_TAGS, so block code (<pre><code>…</code>
// </pre>) is still skipped wholesale — the <pre> ancestor short-circuits
// before its <code> child is ever visited.
const INLINE_TRANSPARENT_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR']);

const BUTTON_LIKE_TAGS = new Set(['A', 'LABEL', 'SUMMARY']);
const BUTTON_LIKE_ROLES = new Set([
  'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'link', 'switch', 'checkbox', 'radio',
]);

// Block-level boundaries used when aggregating inline-spanning sentences.
// Anything not in this set (and not in SKIP_TAGS) is treated as inline and its
// text contributes to the parent block's flat sentence buffer.
const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'BODY', 'BR', 'BUTTON',
  'CAPTION', 'DD', 'DETAILS', 'DIALOG', 'DIV', 'DL', 'DT',
  'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM',
  'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'HEADER', 'HGROUP', 'HR', 'HTML', 'LABEL', 'LI', 'MAIN',
  'NAV', 'OL', 'P', 'SECTION', 'SUMMARY',
  'TABLE', 'TBODY', 'TD', 'TFOOT', 'TH', 'THEAD', 'TR',
  'UL',
]);

const MIN_WORD_COUNT = 3;
const SHORT_LINK_WORD_THRESHOLD = 3;
const MAX_CONCURRENCY = 4;
const VIEWPORT_MARGIN = '200px';
const MUTATION_BATCH_DELAY = 100;

const cache = new Map();
const queue = [];
const ownInsertions = new WeakSet();
// Text nodes we have already passed through processTextNode. Walker rejects
// these so that re-scans (e.g. when a SPA reparents an existing subtree, or
// when the very first toggle injected nothing and MutationObserver later
// added content) do not insert duplicate subtitles.
const processedTextNodes = new WeakSet();
const state = {
  injected: false,
  visible: false,
  running: false,
};
let translator = null;
let translatorPromise = null;
let intersectionObserver = null;
let mutationObserver = null;
let activeTranslations = 0;
let mutationPending = [];
let mutationScheduled = false;

const segmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

const scheduleIdle = (cb) => {
  if (typeof window.requestIdleCallback === 'function') {
    return window.requestIdleCallback(cb, { timeout: 500 });
  }
  return setTimeout(cb, MUTATION_BATCH_DELAY);
};

console.info('[subtitler] content script loaded. Trigger via the configured shortcut or the toolbar icon.');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TOGGLE') handleToggle();
});

// Fallback shortcut handler: chrome.commands sometimes fails to wake the
// service worker (notably in Arc), so capture the key directly in the page.
// The matcher is built from the user's currently-configured shortcut so that
// any combination set via chrome://extensions/shortcuts works.
let toggleShortcut = null;

async function loadToggleShortcut() {
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'GET_TOGGLE_SHORTCUT' });
    toggleShortcut = parseChromeShortcut(reply?.shortcut || '');
  } catch {
    toggleShortcut = null;
  }
}

loadToggleShortcut();

// Refresh after the user updates the shortcut and returns to the tab, so the
// new binding takes effect without a page reload.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') loadToggleShortcut();
});

// Parse a Chrome shortcut string into a normalized matcher.
//   macOS:  glyphs concatenated, e.g. "⌘⇧Y" or "⌃⌥F1"
//   Other:  plus-separated tokens, e.g. "Ctrl+Shift+Y" / "Alt+Shift+Y"
function parseChromeShortcut(s) {
  if (!s) return null;
  const desc = { meta: false, ctrl: false, alt: false, shift: false, code: null };
  if (/[⌘⌥⇧⌃]/.test(s)) {
    // Modifier glyphs always precede the key. Consume them off the front, then
    // treat the remainder as a single key token (handles "F1", "Space", etc.).
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '⌘') desc.meta = true;
      else if (ch === '⌥') desc.alt = true;
      else if (ch === '⇧') desc.shift = true;
      else if (ch === '⌃') desc.ctrl = true;
      else if (ch === ' ' || ch === '+') {
        // skip separator
      } else break;
      i++;
    }
    desc.code = chromeKeyToCode(s.slice(i).trim());
  } else {
    for (const part of s.split('+')) {
      const t = part.trim();
      const lc = t.toLowerCase();
      if (lc === 'ctrl' || lc === 'macctrl') desc.ctrl = true;
      else if (lc === 'shift') desc.shift = true;
      else if (lc === 'alt' || lc === 'option') desc.alt = true;
      else if (lc === 'command' || lc === 'cmd' || lc === 'meta') desc.meta = true;
      else if (t) desc.code = chromeKeyToCode(t);
    }
  }
  return desc.code ? desc : null;
}

function chromeKeyToCode(key) {
  if (!key) return null;
  if (/^[A-Za-z]$/.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (/^F([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  const map = {
    ' ': 'Space',
    Space: 'Space',
    Tab: 'Tab',
    Up: 'ArrowUp',
    Down: 'ArrowDown',
    Left: 'ArrowLeft',
    Right: 'ArrowRight',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Insert: 'Insert',
    Delete: 'Delete',
    ',': 'Comma',
    '.': 'Period',
    '/': 'Slash',
    ';': 'Semicolon',
    "'": 'Quote',
    '[': 'BracketLeft',
    ']': 'BracketRight',
    '\\': 'Backslash',
    '`': 'Backquote',
    '-': 'Minus',
    '=': 'Equal',
  };
  return map[key] ?? null;
}

function isToggleShortcut(e) {
  if (!toggleShortcut) return false;
  const t = toggleShortcut;
  if (e.code !== t.code) return false;
  if (Boolean(e.shiftKey) !== t.shift) return false;
  if (Boolean(e.altKey) !== t.alt) return false;
  if (Boolean(e.metaKey) !== t.meta) return false;
  if (Boolean(e.ctrlKey) !== t.ctrl) return false;
  return true;
}

window.addEventListener(
  'keydown',
  (e) => {
    if (!isToggleShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    console.info('[subtitler] shortcut captured in content script');
    handleToggle();
  },
  true
);

async function handleToggle() {
  if (state.running) return;
  // SPA navigation can leave state.injected=true while the actual injected
  // nodes have been swapped out of the document. Treat the page as fresh so
  // the next press translates instead of silently no-op'ing.
  if (state.injected && !hasLiveInjections()) {
    state.injected = false;
    state.visible = false;
  }
  if (state.injected) {
    state.visible = !state.visible;
    setVisibility(state.visible);
    return;
  }
  state.running = true;
  try {
    state.visible = true;
    const ok = await runTranslation();
    if (ok) {
      state.injected = true;
    } else {
      state.visible = false;
    }
  } catch (e) {
    state.visible = false;
    console.warn('[subtitler] Toggle failed:', e);
  } finally {
    state.running = false;
  }
}

function setVisibility(visible) {
  const display = visible ? '' : 'none';
  document
    .querySelectorAll('[data-subtitler-injected="true"]')
    .forEach((el) => {
      el.style.display = display;
    });
}

function hasLiveInjections() {
  return !!document.querySelector('[data-subtitler-injected="true"]');
}

async function ensureTranslator() {
  if (translator) return translator;
  if (translatorPromise) return translatorPromise;
  if (typeof Translator === 'undefined') {
    throw new Error(
      'Translator API is not available. Requires Chrome 138+ with the Translator API enabled.'
    );
  }
  translatorPromise = (async () => {
    try {
      const availability = await Translator.availability({
        sourceLanguage: 'en',
        targetLanguage: 'ja',
      });
      console.info('[subtitler] availability =', availability);
      if (availability === 'unavailable') {
        throw new Error(
          'en->ja translation model is unavailable. Check Chrome settings > AI for the language pack.'
        );
      }
      if (availability === 'downloadable' || availability === 'downloading') {
        translator = await waitForGestureAndCreate();
        return translator;
      }
      translator = await Translator.create({
        sourceLanguage: 'en',
        targetLanguage: 'ja',
      });
      console.info('[subtitler] Translator ready');
      return translator;
    } catch (e) {
      translatorPromise = null;
      throw e;
    }
  })();
  return translatorPromise;
}

function waitForGestureAndCreate() {
  return new Promise((resolve, reject) => {
    showDownloadBanner(
      () => {
        // User gesture is alive here. Call Translator.create() synchronously
        // (no awaits before it) so the gesture is preserved by the API.
        let createPromise;
        try {
          createPromise = Translator.create({
            sourceLanguage: 'en',
            targetLanguage: 'ja',
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                const pct = Math.round((e.loaded ?? 0) * 100);
                console.info('[subtitler] Model download progress:', pct + '%');
                showBanner(`翻訳モデルをダウンロード中... ${pct}%`);
              });
            },
          });
        } catch (e) {
          hideBanner();
          reject(e);
          return;
        }
        showBanner('翻訳モデルをダウンロード中... 0%');
        createPromise
          .then((t) => {
            console.info('[subtitler] Translator ready');
            hideBanner();
            resolve(t);
          })
          .catch((e) => {
            hideBanner();
            reject(e);
          });
      },
      () => {
        hideBanner();
        reject(new Error('Cancelled by user'));
      }
    );
  });
}

async function runTranslation() {
  try {
    await ensureTranslator();
  } catch (e) {
    console.warn('[subtitler]', e.message);
    return false;
  }
  startObservers();
  const injected = collectAndInject(document.body);
  console.info('[subtitler] Sentences queued for lazy translation:', injected);
  return injected > 0;
}

function startObservers() {
  if (!intersectionObserver) {
    intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const el = entry.target;
          intersectionObserver.unobserve(el);
          const sentence = el.dataset.subtitlerSentence;
          if (sentence && el.isConnected) {
            queue.push({ loading: el, sentence });
          }
        }
        drainQueue();
      },
      { rootMargin: VIEWPORT_MARGIN }
    );
  }
  if (!mutationObserver) {
    mutationObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const added of m.addedNodes) {
          if (ownInsertions.has(added)) continue;
          if (
            added.nodeType !== Node.ELEMENT_NODE &&
            added.nodeType !== Node.TEXT_NODE
          ) {
            continue;
          }
          mutationPending.push(added);
        }
      }
      if (mutationPending.length > 0 && !mutationScheduled) {
        mutationScheduled = true;
        scheduleIdle(processMutations);
      }
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
  }
}

function processMutations() {
  mutationScheduled = false;
  const batch = mutationPending;
  mutationPending = [];
  for (const node of batch) {
    if (!node.isConnected) continue;
    if (node.nodeType === Node.ELEMENT_NODE) {
      collectAndInject(node);
    } else if (node.nodeType === Node.TEXT_NODE) {
      collectFromTextNode(node, { deferIncompleteFinal: true });
    }
  }
}

function drainQueue() {
  if (!translator) return;
  while (queue.length > 0 && activeTranslations < MAX_CONCURRENCY) {
    const item = queue.shift();
    activeTranslations++;
    translateOne(item).finally(() => {
      activeTranslations--;
      if (queue.length > 0) drainQueue();
    });
  }
}

async function translateOne({ loading, sentence }) {
  if (!loading.isConnected) return;
  try {
    let translated;
    if (cache.has(sentence)) {
      translated = cache.get(sentence);
    } else {
      translated = await translator.translate(sentence);
      cache.set(sentence, translated);
    }
    replaceLoadingWithTranslation(loading, translated);
  } catch (e) {
    console.warn('[subtitler] Failed to translate sentence:', sentence.slice(0, 40), e);
    loading.remove();
  }
}

function collectAndInject(root, options = {}) {
  if (!root || !root.nodeType) return 0;
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (shouldSkipElement(root)) return 0;
    // MutationObserver may hand us a freshly-added element that is itself
    // benign but lives inside an excluded subtree (a code highlighter span
    // appearing inside <code>, a node added inside a contenteditable region,
    // a sub-element of an already-translated subtitler block). Walk the
    // ancestor chain so we don't drop translation spans into those.
    let p = root.parentElement;
    while (p) {
      if (shouldSkipElement(p)) return 0;
      p = p.parentElement;
    }
  }
  return processBlock(processingBlockFor(root), {
    deferIncompleteFinal: shouldDeferIncompleteFinal(root, options),
  });
}

function collectFromTextNode(textNode, options = {}) {
  if (!textNode.parentNode) return 0;
  if (processedTextNodes.has(textNode)) return 0;
  let p = textNode.parentElement;
  while (p) {
    if (shouldSkipElement(p)) return 0;
    p = p.parentElement;
  }
  return processBlock(processingBlockFor(textNode), {
    deferIncompleteFinal: options.deferIncompleteFinal === true,
  });
}

function processingBlockFor(node) {
  const fallback =
    node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  let block = fallback;
  while (block && !BLOCK_TAGS.has(block.tagName)) {
    block = block.parentElement;
  }
  return block || fallback;
}

function shouldDeferIncompleteFinal(root, options) {
  if (typeof options.deferIncompleteFinal === 'boolean') {
    return options.deferIncompleteFinal;
  }
  return root.nodeType === Node.ELEMENT_NODE && !BLOCK_TAGS.has(root.tagName);
}

function isContentEditableNode(el) {
  if (!el || !el.getAttribute) return false;
  // Browsers expose .isContentEditable, which considers inheritance. jsdom
  // does not implement it, so fall back to the attribute for testability.
  if (el.isContentEditable) return true;
  const attr = el.getAttribute('contenteditable');
  return attr === 'true' || attr === 'plaintext-only';
}

// Containers whose descendants are UI affordances (menu items, listbox
// options, etc.) rather than prose. Their text is short action labels and
// translating them produces noisy duplicate Japanese next to controls.
const SELECTION_CONTAINER_ROLES = new Set([
  'menu', 'listbox', 'combobox', 'tree', 'grid',
]);

// Exact-match class names that hide text from sighted users but don't
// follow a generalizable suffix pattern. A translation span injected as a
// sibling does not inherit those rules and would become visible — the
// opposite of what the page intends. GitHub uses d-none for hotkey-only
// anchors like <a class="d-none" data-hotkey>...</a>, where the visible
// Japanese translation surfaces text the page hid.
const VISUALLY_HIDDEN_EXACT_CLASSES = new Set([
  'show-on-focus', // GitHub Primer
  'd-none',        // Bootstrap
  'hidden',        // Tailwind base / Bootstrap legacy
  'mw-jump-link',  // MediaWiki (Wikipedia) — focus-only "Jump to content" links
]);

// Screen-reader-only utility families. Patterns use `(^|[-:])` to capture
// vendor or Tailwind-prefixed variants (m-sr-only, tw-sr-only) and
// responsive/state variants (md:sr-only, focus:not-sr-only). `negation`
// pairs with `positive` so a framework's reverse helper (e.g. Tailwind
// not-sr-only) can't be missed when adding a new entry.
//
// Tailwind variant prefixes (md:, hover:, focus:, dark: …) only apply at
// matching breakpoints/states, but we treat them as if the variant is
// active without consulting the viewport. This is correct for desktop
// viewports — Subtitler's primary target — where md+ patterns dominate
// real-world responsive nav code (e.g. `sr-only md:not-sr-only` on a
// link that's a hamburger label on mobile and a visible nav link on
// desktop). Narrow viewports may produce reversed judgements; a
// getComputedStyle fallback would fix this at the cost of layout reflow
// on every element.
const VISUALLY_HIDDEN_UTILITIES = [
  // Tailwind / Bootstrap 4 / AWS m-sr-only
  { positive: /(^|[-:])sr-only(-focusable)?$/,
    negation: /(^|[-:])not-sr-only(-focusable)?$/ },
  // Bootstrap 5 / GOV.UK / WHATWG
  { positive: /(^|[-:])visually-hidden(-focusable)?$/,
    negation: /(^|[-:])not-visually-hidden(-focusable)?$/ },
  // WordPress (screen-reader-text), older themes
  { positive: /(^|[-:])screen-reader(-only|-text)?$/,
    negation: null },
];

// Combined alternation regexes built once at module load. Per-class cost
// drops from up to N positive + N negation tests to one each — meaningful
// on full DOM walks of large pages.
const VISUALLY_HIDDEN_POSITIVE_RE = new RegExp(
  VISUALLY_HIDDEN_UTILITIES.map((u) => u.positive.source).join('|')
);
const VISUALLY_HIDDEN_NEGATION_RE = new RegExp(
  VISUALLY_HIDDEN_UTILITIES
    .filter((u) => u.negation)
    .map((u) => u.negation.source)
    .join('|')
);

// Negations win and short-circuit: any matching reverse helper means the
// element is visible at the user's viewport regardless of sibling classes.
function isVisuallyHiddenByClass(classList) {
  let hasHidden = false;
  for (const cls of classList) {
    if (VISUALLY_HIDDEN_NEGATION_RE.test(cls)) return false;
    if (
      !hasHidden &&
      (VISUALLY_HIDDEN_EXACT_CLASSES.has(cls) || VISUALLY_HIDDEN_POSITIVE_RE.test(cls))
    ) {
      hasHidden = true;
    }
  }
  return hasHidden;
}

// Single subtree-skip predicate. Bundling every "do not translate inside
// this element" rule here keeps each call site (collectAndInject root +
// ancestor walk, collectFromTextNode ancestor walk, processBlock per-child)
// to one branch and reads role= once per element on the hot DOM walk.
// Reasons inline:
//   <tool-tip> / role=tooltip — duplicates the trigger label.
//   subtitlerInjected         — our own injected nodes; never recurse in.
//   contenteditable           — mutating these breaks user input.
//   SELECTION_CONTAINER_ROLES — menu/listbox descendants are UI labels.
//   isVisuallyHiddenByClass   — would surface invisible text to sighted users.
function shouldSkipElement(el) {
  if (!el || !el.tagName) return false;
  if (el.hidden) return true;
  if (SKIP_TAGS.has(el.tagName)) return true;
  if (el.tagName === 'TOOL-TIP') return true;
  if (el.dataset && el.dataset.subtitlerInjected === 'true') return true;
  if (isContentEditableNode(el)) return true;
  if (el.getAttribute) {
    const role = el.getAttribute('role');
    if (role === 'tooltip') return true;
    if (role && SELECTION_CONTAINER_ROLES.has(role)) return true;
  }
  if (el.classList && isVisuallyHiddenByClass(el.classList)) return true;
  return false;
}

// Walk a block element, splitting its inline content into "runs" of adjacent
// text nodes. A nested block boundary flushes the current run so that
// sentence aggregation never crosses a block break (e.g. a <p> embedded in a
// <div> never merges its prose with the surrounding div text).
function processBlock(block, options = {}) {
  if (!block) return 0;
  let total = 0;
  let currentRun = [];

  function flushRun() {
    if (currentRun.length === 0) return;
    total += processRun(currentRun, options);
    currentRun = [];
  }

  function visit(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      // A previously-processed text node already contributed its own
      // translation segment. Treat it as a run boundary — concatenating
      // the new text on either side of it would silently drop its content
      // from the flat string and feed the translator a sentence with the
      // middle elided.
      if (processedTextNodes.has(node)) {
        flushRun();
      } else {
        currentRun.push(node);
      }
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    // Anything we don't translate must still break the surrounding sentence
    // run, otherwise the text on either side gets concatenated by join('')
    // and the translator receives a corrupted sentence with the skipped
    // content silently elided (e.g. a <textarea> between two prose halves
    // would produce "Type something  to continue please."). Inline code-like
    // tags are handled separately below: their text DOES join the run.
    if (shouldSkipElement(node)) {
      flushRun();
      return;
    }
    // Inline code-like elements stay in the sentence run: their text nodes
    // are visited (and so their content is included in the flat string fed
    // to the segmenter/translator), but we don't translate the code itself
    // because applyInsertions only attaches loading spans at sentence ends.
    if (INLINE_TRANSPARENT_TAGS.has(node.tagName)) {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (BLOCK_TAGS.has(node.tagName)) {
      flushRun();
      total += processBlock(node, options);
      return;
    }
    for (const child of node.childNodes) visit(child);
  }

  for (const child of block.childNodes) visit(child);
  flushRun();
  return total;
}

// Process a contiguous run of inline-adjacent text nodes as a single sentence
// stream. The flat text is segmented across the run, and each translatable
// sentence inserts a loading span at the offset where it ends — even if that
// offset lies in a different text node from where the sentence began.
function processRun(textNodes, options = {}) {
  const fresh = textNodes.filter(
    (n) => n.parentNode && !processedTextNodes.has(n) && n.textContent
  );
  if (fresh.length === 0) return 0;

  const segments = [];
  let cursor = 0;
  for (const node of fresh) {
    const len = node.textContent.length;
    segments.push({ start: cursor, end: cursor + len, node });
    cursor += len;
  }
  const flatText = segments.map((s) => s.node.textContent).join('');

  if (!hasLatinLetter(flatText) || isPredominantlyJapanese(flatText)) {
    for (const s of segments) processedTextNodes.add(s.node);
    return 0;
  }

  const sentences = [...segmenter.segment(flatText)];
  if (sentences.length === 0) {
    for (const s of segments) processedTextNodes.add(s.node);
    return 0;
  }

  // Per-segment list of insertion points (offset within the text node) and
  // the sentence string to attach there. We collect everything before mutating
  // the DOM so DOM surgery happens once per text node.
  const insertionsBySegment = new Map();
  for (const s of segments) insertionsBySegment.set(s, []);

  let count = 0;
  const deferredSegments = new Set();
  for (const sent of sentences) {
    const start = sent.index;
    const end = start + sent.segment.length;
    const trimmed = sent.segment.trim();
    if (!trimmed || !hasLatinLetter(trimmed) || isPredominantlyJapanese(trimmed)) continue;

    const covered = segments.filter((s) => s.end > start && s.start < end);
    if (covered.length === 0) continue;
    if (
      options.deferIncompleteFinal &&
      isTrailingIncompleteSentence(sent, flatText)
    ) {
      for (const s of covered) deferredSegments.add(s);
      continue;
    }

    // For ancestor-based rules (e.g. the standalone-link short-text filter),
    // ignore covered segments that contribute only punctuation/whitespace.
    // Otherwise `<a>Read more docs</a>.` would resolve to the surrounding
    // <p> and bypass the link-specific filter. Use the slice that overlaps
    // this sentence — looking at the full node would also include letters
    // from neighbouring sentences (e.g. ". More text follows today." after
    // `<a>Read more docs</a>`).
    const meaningful = covered.filter((s) => {
      const localStart = Math.max(start - s.start, 0);
      const localEnd = Math.min(end - s.start, s.node.textContent.length);
      return hasLatinLetter(s.node.textContent.slice(localStart, localEnd));
    });
    const ancestorSource = meaningful.length > 0 ? meaningful : covered;
    const ancestor = commonAncestorElement(ancestorSource.map((s) => s.node));
    if (!shouldTranslate(trimmed, ancestor)) continue;

    // Find the segment containing the sentence's exclusive end position.
    let endSeg = null;
    for (const s of segments) {
      if (end > s.start && end <= s.end) {
        endSeg = s;
        break;
      }
    }
    if (!endSeg) continue;

    const offsetInNode = end - endSeg.start;
    insertionsBySegment.get(endSeg).push({ offset: offsetInNode, sentence: trimmed });
    count++;
  }

  for (const seg of segments) {
    const inserts = insertionsBySegment.get(seg);
    if (inserts.length === 0) {
      if (!deferredSegments.has(seg)) processedTextNodes.add(seg.node);
      continue;
    }
    inserts.sort((a, b) => a.offset - b.offset);
    applyInsertions(seg.node, inserts, {
      deferredAtEnd: deferredSegments.has(seg),
    });
  }

  if (count > 0) state.injected = true;
  return count;
}

function isTrailingIncompleteSentence(segment, flatText) {
  const end = segment.index + segment.segment.length;
  if (end < flatText.length) return false;
  return !/[.!?]["')\]]*$/.test(segment.segment.trim());
}

// Replace a single text node with a fragment that splices loading spans in at
// the given offsets. Each offset corresponds to the *end* of one sentence; the
// span is inserted immediately after that point.
function applyInsertions(textNode, inserts, opts = {}) {
  if (!textNode.parentNode) return;
  const text = textNode.textContent;
  const fragment = document.createDocumentFragment();
  const newNodes = [];
  const loadings = [];
  let prev = 0;

  for (const ins of inserts) {
    const chunk = text.slice(prev, ins.offset);
    if (chunk) {
      const tn = document.createTextNode(chunk);
      fragment.appendChild(tn);
      newNodes.push(tn);
      processedTextNodes.add(tn);
    }
    const loading = document.createElement('span');
    loading.className = 'subtitler-loading';
    loading.dataset.subtitlerInjected = 'true';
    loading.dataset.subtitlerSentence = ins.sentence;
    loading.textContent = '翻訳中...';
    if (!state.visible) loading.style.display = 'none';
    fragment.appendChild(loading);
    newNodes.push(loading);
    loadings.push(loading);
    prev = ins.offset;
  }

  const tail = text.slice(prev);
  if (tail) {
    const tn = document.createTextNode(tail);
    fragment.appendChild(tn);
    newNodes.push(tn);
    // When the same text node also held a deferred (incomplete) trailing
    // sentence, the tail carries its prefix. Marking it processed would
    // prevent the next batch (which delivers the rest of the sentence) from
    // re-aggregating with it, and we'd translate only the suffix.
    if (!opts.deferredAtEnd) processedTextNodes.add(tn);
  }

  for (const n of newNodes) ownInsertions.add(n);
  processedTextNodes.add(textNode);
  textNode.parentNode.replaceChild(fragment, textNode);
  // If a loading landed at the very end of an <a>, lift it out so the
  // translation span stops being a child of the link. Without this, the
  // <a>'s clickable area absorbs the subtitle and (with display:block)
  // renders the translation on a new line *inside* the link box, which
  // visibly breaks link styling.
  for (const l of loadings) liftLoadingFromTrailingAnchor(l);
  if (intersectionObserver) {
    for (const l of loadings) intersectionObserver.observe(l);
  }
}

function liftLoadingFromTrailingAnchor(loading) {
  let anchor = null;
  let cursor = loading.parentElement;
  while (cursor) {
    if (cursor.tagName === 'A') {
      anchor = cursor;
      break;
    }
    cursor = cursor.parentElement;
  }
  if (!anchor) return;
  // Bail out if any meaningful sibling follows the loading anywhere up to
  // the anchor — otherwise we'd leave content stranded after we move it.
  let walker = loading;
  while (walker !== anchor) {
    let sib = walker.nextSibling;
    while (sib) {
      if (hasMeaningfulContent(sib)) return;
      sib = sib.nextSibling;
    }
    walker = walker.parentNode;
    if (!walker) return;
  }
  if (anchor.parentNode) {
    anchor.parentNode.insertBefore(loading, anchor.nextSibling);
  }
}

function hasMeaningfulContent(node) {
  // Whitespace-only text nodes must not block the lift: SPA frameworks often
  // render a link skeleton like `<a> </a>` first (whose " " gets marked
  // processed) and then drop the real body in. Without trimming here, the
  // trailing whitespace would force the loading to stay inside <a> after the
  // body is inserted, re-introducing the click-area regression Fix 3 closed.
  if (node.nodeType === Node.TEXT_NODE) return node.textContent.trim().length > 0;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  if (node.dataset && node.dataset.subtitlerInjected === 'true') return false;
  for (const child of node.childNodes) {
    if (hasMeaningfulContent(child)) return true;
  }
  return false;
}

function processTextNode(textNode) {
  if (!textNode || !textNode.parentNode) return 0;
  return processRun([textNode]);
}

function hasLatinLetter(text) {
  return /[A-Za-z]/.test(text);
}

// Filter out text that is already in Japanese. The Translator API is hard-wired
// to en→ja, so feeding it Japanese-dominant prose (e.g. a translated README
// paragraph that happens to contain identifiers like `IntersectionObserver`)
// produces garbled output. The hasLatinLetter gate alone is too permissive
// because a single Latin token in an otherwise Japanese sentence passes it.
function isPredominantlyJapanese(text) {
  const jp = text.match(/[぀-ゟ゠-ヿ一-鿿ｦ-ﾟ]/g);
  if (!jp) return false;
  // Compare against Latin *words*, not letters. Embedded Latin in Japanese
  // prose is almost always identifiers / proper nouns (`IntersectionObserver`,
  // `Translator API`), so character count overweights them — e.g. `Chrome の
  // Translator API` would beat the kana around it on raw letter count even
  // though the sentence is plainly Japanese narrative.
  const latinWords = text.match(/[A-Za-z]+/g) || [];
  return jp.length >= latinWords.length;
}

function isAddressLike(text) {
  const t = (text || '').trim();
  if (!t) return false;
  if (/\s/.test(t)) return false;
  if (/^https?:\/\/\S+$/i.test(t)) return true;
  if (/^ftp:\/\/\S+$/i.test(t)) return true;
  if (/^www\.\S+\.\S+/i.test(t)) return true;
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(t)) return true;
  return false;
}

function commonAncestorElement(nodes) {
  if (!nodes || nodes.length === 0) return null;
  let anc = nodes[0].parentElement;
  for (let i = 1; i < nodes.length && anc; i++) {
    while (anc && !anc.contains(nodes[i])) {
      anc = anc.parentElement;
    }
  }
  return anc;
}

function shouldTranslate(sentence, parentEl) {
  const wordCount = sentence.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) return false;

  let p = parentEl;
  let insideAnchor = false;
  while (p && p !== document.body && p !== document.documentElement) {
    const role = p.getAttribute && p.getAttribute('role');
    if (p.tagName === 'BUTTON' || (role && BUTTON_LIKE_ROLES.has(role))) {
      return false;
    }
    if (p.tagName === 'A') insideAnchor = true;
    if (
      BUTTON_LIKE_TAGS.has(p.tagName) &&
      wordCount < SHORT_LINK_WORD_THRESHOLD
    ) {
      return false;
    }
    p = p.parentElement;
  }

  // Link text that is just a URL/address should never be translated, even if
  // it would otherwise pass the word-count thresholds.
  if (insideAnchor && isAddressLike(sentence)) return false;

  return true;
}

function replaceLoadingWithTranslation(loadingEl, translated) {
  if (!loadingEl.isConnected) return;
  const span = document.createElement('span');
  span.className = 'subtitler-ja';
  span.dataset.subtitlerInjected = 'true';
  span.textContent = translated;
  if (!state.visible) span.style.display = 'none';
  ownInsertions.add(span);
  loadingEl.replaceWith(span);
}

function showBanner(text) {
  document.getElementById('subtitler-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'subtitler-banner';
  banner.dataset.subtitlerInjected = 'true';
  ownInsertions.add(banner);
  banner.textContent = `subtitler: ${text}`;
  document.documentElement.appendChild(banner);
}

function showDownloadBanner(onDownload, onCancel) {
  document.getElementById('subtitler-banner')?.remove();
  const banner = document.createElement('div');
  banner.id = 'subtitler-banner';
  banner.dataset.subtitlerInjected = 'true';
  ownInsertions.add(banner);

  const label = document.createElement('span');
  label.textContent = 'subtitler: 翻訳モデルのダウンロードが必要です。';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'subtitler-banner-btn';
  downloadBtn.textContent = 'ダウンロード';
  downloadBtn.dataset.subtitlerInjected = 'true';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'subtitler-banner-btn';
  cancelBtn.textContent = 'キャンセル';
  cancelBtn.dataset.subtitlerInjected = 'true';

  downloadBtn.addEventListener('click', () => {
    downloadBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      onDownload();
    } catch (e) {
      console.warn('[subtitler] Action failed:', e);
    }
  });
  cancelBtn.addEventListener('click', () => {
    downloadBtn.disabled = true;
    cancelBtn.disabled = true;
    try {
      onCancel();
    } catch (e) {
      console.warn('[subtitler] Cancel failed:', e);
    }
  });

  banner.appendChild(label);
  banner.appendChild(downloadBtn);
  banner.appendChild(cancelBtn);
  document.documentElement.appendChild(banner);
}

function hideBanner() {
  document.getElementById('subtitler-banner')?.remove();
}

// Test-only exports. The condition is satisfied in Node (CommonJS) but not in
// the browser (where `module` is undefined), so this has no effect on the
// extension at runtime.
if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
  module.exports = {
    handleToggle,
    isToggleShortcut,
    parseChromeShortcut,
    chromeKeyToCode,
    shouldTranslate,
    hasLatinLetter,
    isPredominantlyJapanese,
    isAddressLike,
    setVisibility,
    processTextNode,
    processBlock,
    collectAndInject,
    collectFromTextNode,
    replaceLoadingWithTranslation,
    runTranslation,
    drainQueue,
    SKIP_TAGS,
    BUTTON_LIKE_TAGS,
    BUTTON_LIKE_ROLES,
    BLOCK_TAGS,
    state,
    __test: {
      get translator() { return translator; },
      set translator(v) { translator = v; },
      get translatorPromise() { return translatorPromise; },
      set translatorPromise(v) { translatorPromise = v; },
      get intersectionObserver() { return intersectionObserver; },
      get mutationObserver() { return mutationObserver; },
      get queue() { return queue; },
      get cache() { return cache; },
      get toggleShortcut() { return toggleShortcut; },
      setToggleShortcut(desc) { toggleShortcut = desc; },
      reset() {
        cache.clear();
        queue.length = 0;
        state.injected = false;
        state.visible = false;
        state.running = false;
        translator = null;
        translatorPromise = null;
        if (intersectionObserver && typeof intersectionObserver.disconnect === 'function') {
          intersectionObserver.disconnect();
        }
        if (mutationObserver && typeof mutationObserver.disconnect === 'function') {
          mutationObserver.disconnect();
        }
        intersectionObserver = null;
        mutationObserver = null;
        activeTranslations = 0;
        mutationPending.length = 0;
        mutationScheduled = false;
      },
    },
  };
}
