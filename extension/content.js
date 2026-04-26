const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE',
  'CODE', 'PRE', 'TEXTAREA', 'INPUT', 'KBD', 'SAMP', 'VAR',
  // Form controls whose text is the submitted value or a label attribute;
  // injecting child spans into <option> would corrupt form submissions.
  'SELECT', 'OPTION', 'OPTGROUP',
]);

const BUTTON_LIKE_TAGS = new Set(['A', 'LABEL', 'SUMMARY']);
const BUTTON_LIKE_ROLES = new Set([
  'button', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'link', 'switch', 'checkbox', 'radio',
]);

const MIN_WORD_COUNT = 3;
const SHORT_LINK_WORD_THRESHOLD = 6;
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

console.info('[subtitler] content script loaded. Trigger via Cmd+Shift+Y or the toolbar icon.');

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'TOGGLE') handleToggle();
});

// Fallback shortcut handler: chrome.commands sometimes fails to wake the
// service worker (notably in Arc), so capture the key directly in the page.
function isOnMac() {
  return /mac|iphone|ipad|ipod/i.test(
    navigator.userAgentData?.platform || navigator.platform || ''
  );
}

function isToggleShortcut(e) {
  if (typeof e.key !== 'string') return false;
  if (e.key.toLowerCase() !== 'y') return false;
  if (!e.shiftKey || e.altKey) return false;
  return isOnMac()
    ? e.metaKey && !e.ctrlKey
    : e.ctrlKey && !e.metaKey;
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
                showBanner(`Downloading translation model... ${pct}%`);
              });
            },
          });
        } catch (e) {
          hideBanner();
          reject(e);
          return;
        }
        showBanner('Downloading translation model... 0%');
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
      collectFromTextNode(node);
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

function collectAndInject(root) {
  if (!root || !root.nodeType) return 0;
  if (
    root.nodeType === Node.ELEMENT_NODE &&
    (SKIP_TAGS.has(root.tagName) || root.dataset?.subtitlerInjected === 'true')
  ) {
    return 0;
  }

  let injected = 0;
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (processedTextNodes.has(node)) return NodeFilter.FILTER_REJECT;
        if (!node.textContent || !node.textContent.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        let p = node.parentElement;
        while (p) {
          if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
          if (p.dataset && p.dataset.subtitlerInjected === 'true') {
            return NodeFilter.FILTER_REJECT;
          }
          if (isContentEditableNode(p)) return NodeFilter.FILTER_REJECT;
          p = p.parentElement;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const targets = [];
  let node;
  while ((node = walker.nextNode())) {
    targets.push(node);
  }
  for (const textNode of targets) {
    injected += processTextNode(textNode);
  }
  return injected;
}

function collectFromTextNode(textNode) {
  if (!textNode.parentNode) return 0;
  if (processedTextNodes.has(textNode)) return 0;
  let p = textNode.parentElement;
  while (p) {
    if (SKIP_TAGS.has(p.tagName)) return 0;
    if (p.dataset && p.dataset.subtitlerInjected === 'true') return 0;
    if (isContentEditableNode(p)) return 0;
    p = p.parentElement;
  }
  return processTextNode(textNode);
}

function isContentEditableNode(el) {
  // Browsers expose .isContentEditable, which considers inheritance. jsdom
  // does not implement it, so fall back to the attribute for testability.
  if (el.isContentEditable) return true;
  const attr = el.getAttribute && el.getAttribute('contenteditable');
  return attr === 'true' || attr === 'plaintext-only';
}

function processTextNode(textNode) {
  if (!textNode.parentNode) return 0;
  const text = textNode.textContent;
  if (!hasLatinLetter(text)) {
    processedTextNodes.add(textNode);
    return 0;
  }

  const segments = [...segmenter.segment(text)];
  if (segments.length === 0) {
    processedTextNodes.add(textNode);
    return 0;
  }

  const fragment = document.createDocumentFragment();
  const newNodes = [];
  const newTextNodes = [];
  const loadings = [];

  for (const seg of segments) {
    const original = seg.segment;
    const trimmed = original.trim();
    const tn = document.createTextNode(original);
    fragment.appendChild(tn);
    newNodes.push(tn);
    newTextNodes.push(tn);

    if (!trimmed || !hasLatinLetter(trimmed)) continue;
    if (!shouldTranslate(trimmed, textNode.parentElement)) continue;

    const loading = document.createElement('span');
    loading.className = 'subtitler-loading';
    loading.dataset.subtitlerInjected = 'true';
    loading.dataset.subtitlerSentence = trimmed;
    loading.textContent = 'Translating...';
    if (!state.visible) loading.style.display = 'none';
    fragment.appendChild(loading);
    newNodes.push(loading);
    loadings.push(loading);
  }

  if (loadings.length === 0) {
    processedTextNodes.add(textNode);
    return 0;
  }

  for (const n of newNodes) ownInsertions.add(n);
  for (const tn of newTextNodes) processedTextNodes.add(tn);
  textNode.parentNode.replaceChild(fragment, textNode);
  if (intersectionObserver) {
    for (const l of loadings) intersectionObserver.observe(l);
  }
  // Mark globally so that a later toggle does not re-walk the document and
  // duplicate subtitles. This matters when the very first toggle injected
  // nothing and MutationObserver added content afterwards.
  state.injected = true;
  return loadings.length;
}

function hasLatinLetter(text) {
  return /[A-Za-z]/.test(text);
}

function shouldTranslate(sentence, parentEl) {
  const wordCount = sentence.split(/\s+/).filter(Boolean).length;
  if (wordCount < MIN_WORD_COUNT) return false;

  let p = parentEl;
  while (p && p !== document.body && p !== document.documentElement) {
    const role = p.getAttribute && p.getAttribute('role');
    if (p.tagName === 'BUTTON' || (role && BUTTON_LIKE_ROLES.has(role))) {
      return false;
    }
    if (
      BUTTON_LIKE_TAGS.has(p.tagName) &&
      wordCount < SHORT_LINK_WORD_THRESHOLD
    ) {
      return false;
    }
    p = p.parentElement;
  }
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
  label.textContent = 'subtitler: Translation model needs to be downloaded.';

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'subtitler-banner-btn';
  downloadBtn.textContent = 'Download';
  downloadBtn.dataset.subtitlerInjected = 'true';

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'subtitler-banner-btn';
  cancelBtn.textContent = 'Cancel';
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
    isOnMac,
    isToggleShortcut,
    shouldTranslate,
    hasLatinLetter,
    setVisibility,
    processTextNode,
    collectAndInject,
    collectFromTextNode,
    replaceLoadingWithTranslation,
    runTranslation,
    drainQueue,
    SKIP_TAGS,
    BUTTON_LIKE_TAGS,
    BUTTON_LIKE_ROLES,
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
