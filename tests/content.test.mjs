import { describe, it, expect, beforeEach, vi } from 'vitest';

// Importing content.js triggers its top-level side effects (registering
// chrome.runtime.onMessage and a keydown listener on window). The mocks set
// up in tests/setup.mjs make those calls no-ops.
import subtitler from '../extension/content.js';

const {
  handleToggle,
  isToggleShortcut,
  parseChromeShortcut,
  chromeKeyToCode,
  shouldTranslate,
  hasLatinLetter,
  isAddressLike,
  setVisibility,
  processTextNode,
  processBlock,
  collectAndInject,
  collectFromTextNode,
  replaceLoadingWithTranslation,
  state,
  __test,
} = subtitler;

beforeEach(() => {
  __test.reset();
  document.body.innerHTML = '';
  globalThis.__IntersectionObserverMock.instances.length = 0;
  globalThis.__TranslatorMock.availability.mockReset().mockResolvedValue('available');
  globalThis.__TranslatorMock.create
    .mockReset()
    .mockImplementation(async () => globalThis.__makeTranslatorInstance());
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe('isAddressLike', () => {
  it('detects http(s) and ftp URLs', () => {
    expect(isAddressLike('https://example.com')).toBe(true);
    expect(isAddressLike('http://example.com/path?q=1')).toBe(true);
    expect(isAddressLike('ftp://files.example.com/x')).toBe(true);
  });

  it('detects www. and bare domains', () => {
    expect(isAddressLike('www.example.com')).toBe(true);
    expect(isAddressLike('docs.example.com/path')).toBe(true);
    expect(isAddressLike('example.com')).toBe(true);
  });

  it('rejects strings containing whitespace (real prose)', () => {
    expect(isAddressLike('https://example.com is great')).toBe(false);
    expect(isAddressLike('Visit example.com')).toBe(false);
    expect(isAddressLike('Read more docs')).toBe(false);
  });

  it('rejects empty / non-URL tokens', () => {
    expect(isAddressLike('')).toBe(false);
    expect(isAddressLike('   ')).toBe(false);
    expect(isAddressLike('hello')).toBe(false);
    expect(isAddressLike('Click')).toBe(false);
  });
});

describe('hasLatinLetter', () => {
  it('returns true when Latin letters are present', () => {
    expect(hasLatinLetter('Hello')).toBe(true);
    expect(hasLatinLetter('123 abc 456')).toBe(true);
    expect(hasLatinLetter('日本語 mixed text')).toBe(true);
  });

  it('returns false when no Latin letters', () => {
    expect(hasLatinLetter('こんにちは')).toBe(false);
    expect(hasLatinLetter('1234567890')).toBe(false);
    expect(hasLatinLetter('   ')).toBe(false);
    expect(hasLatinLetter('')).toBe(false);
  });
});

describe('parseChromeShortcut', () => {
  it('parses macOS glyph-form shortcuts', () => {
    expect(parseChromeShortcut('⌘⇧Y')).toEqual({
      meta: true, ctrl: false, alt: false, shift: true, code: 'KeyY',
    });
    expect(parseChromeShortcut('⌥⇧Y')).toEqual({
      meta: false, ctrl: false, alt: true, shift: true, code: 'KeyY',
    });
    expect(parseChromeShortcut('⌃⌥⇧F1')).toEqual({
      meta: false, ctrl: true, alt: true, shift: true, code: 'F1',
    });
  });

  it('parses plus-separated shortcuts', () => {
    expect(parseChromeShortcut('Ctrl+Shift+Y')).toEqual({
      meta: false, ctrl: true, alt: false, shift: true, code: 'KeyY',
    });
    expect(parseChromeShortcut('Alt+Shift+Y')).toEqual({
      meta: false, ctrl: false, alt: true, shift: true, code: 'KeyY',
    });
    expect(parseChromeShortcut('Command+Shift+Y')).toEqual({
      meta: true, ctrl: false, alt: false, shift: true, code: 'KeyY',
    });
    expect(parseChromeShortcut('MacCtrl+Shift+Y')).toEqual({
      meta: false, ctrl: true, alt: false, shift: true, code: 'KeyY',
    });
  });

  it('parses punctuation and digit keys', () => {
    expect(parseChromeShortcut('Ctrl+Shift+;')).toMatchObject({ code: 'Semicolon' });
    expect(parseChromeShortcut('Ctrl+Shift+0')).toMatchObject({ code: 'Digit0' });
    expect(parseChromeShortcut('⌘⇧/')).toMatchObject({ code: 'Slash' });
  });

  it('returns null for empty or unparseable strings', () => {
    expect(parseChromeShortcut('')).toBeNull();
    expect(parseChromeShortcut(null)).toBeNull();
    expect(parseChromeShortcut(undefined)).toBeNull();
    // Modifier-only is not a valid binding.
    expect(parseChromeShortcut('Ctrl+Shift')).toBeNull();
  });
});

describe('chromeKeyToCode', () => {
  it('maps letters to Key{X}', () => {
    expect(chromeKeyToCode('a')).toBe('KeyA');
    expect(chromeKeyToCode('Z')).toBe('KeyZ');
  });

  it('maps digits to Digit{N}', () => {
    expect(chromeKeyToCode('0')).toBe('Digit0');
    expect(chromeKeyToCode('9')).toBe('Digit9');
  });

  it('maps function keys verbatim', () => {
    expect(chromeKeyToCode('F1')).toBe('F1');
    expect(chromeKeyToCode('f12')).toBe('F12');
  });
});

describe('isToggleShortcut', () => {
  beforeEach(() => {
    // Default to a known shortcut for each test.
    __test.setToggleShortcut(parseChromeShortcut('Alt+Shift+Y'));
  });

  it('matches the configured shortcut', () => {
    expect(
      isToggleShortcut({
        code: 'KeyY',
        shiftKey: true, altKey: true, metaKey: false, ctrlKey: false,
      })
    ).toBe(true);
  });

  it('matches even when e.key is mangled (macOS Option produces a special char)', () => {
    expect(
      isToggleShortcut({
        code: 'KeyY', key: 'Á',
        shiftKey: true, altKey: true, metaKey: false, ctrlKey: false,
      })
    ).toBe(true);
  });

  it('rejects when no shortcut is configured', () => {
    __test.setToggleShortcut(null);
    expect(
      isToggleShortcut({
        code: 'KeyY',
        shiftKey: true, altKey: true, metaKey: false, ctrlKey: false,
      })
    ).toBe(false);
  });

  it('rejects mismatched code', () => {
    expect(
      isToggleShortcut({ code: 'KeyX', shiftKey: true, altKey: true, metaKey: false, ctrlKey: false })
    ).toBe(false);
  });

  it('rejects mismatched modifiers', () => {
    expect(
      isToggleShortcut({ code: 'KeyY', shiftKey: false, altKey: true, metaKey: false, ctrlKey: false })
    ).toBe(false);
    expect(
      isToggleShortcut({ code: 'KeyY', shiftKey: true, altKey: true, metaKey: true, ctrlKey: false })
    ).toBe(false);
  });

  it('matches a different user-configured shortcut (Cmd+Shift+;)', () => {
    __test.setToggleShortcut(parseChromeShortcut('⌘⇧;'));
    expect(
      isToggleShortcut({
        code: 'Semicolon',
        shiftKey: true, altKey: false, metaKey: true, ctrlKey: false,
      })
    ).toBe(true);
    // The previous Alt+Shift+Y should no longer fire.
    expect(
      isToggleShortcut({
        code: 'KeyY',
        shiftKey: true, altKey: true, metaKey: false, ctrlKey: false,
      })
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldTranslate
// ---------------------------------------------------------------------------
describe('shouldTranslate', () => {
  it('rejects fewer than 3 words', () => {
    document.body.innerHTML = '<div id="x">x</div>';
    const div = document.getElementById('x');
    expect(shouldTranslate('Hello world', div)).toBe(false);
    expect(shouldTranslate('Hi', div)).toBe(false);
    expect(shouldTranslate('Submit', div)).toBe(false);
  });

  it('accepts 3+ words inside a regular block element', () => {
    document.body.innerHTML = '<div id="x">x</div>';
    const div = document.getElementById('x');
    expect(shouldTranslate('Hello there friend.', div)).toBe(true);
    expect(shouldTranslate('This is a moderately long sentence in body text.', div)).toBe(true);
  });

  it('rejects content inside <button> regardless of length', () => {
    document.body.innerHTML = '<button id="b"><span id="s">x</span></button>';
    const span = document.getElementById('s');
    expect(shouldTranslate('Click here to do something now', span)).toBe(false);
  });

  it('rejects content with role="button" regardless of length', () => {
    document.body.innerHTML = '<div role="button"><span id="s">x</span></div>';
    const span = document.getElementById('s');
    expect(
      shouldTranslate('Click here to do something interesting and important now', span)
    ).toBe(false);
  });

  it('rejects content with role="link" when short', () => {
    document.body.innerHTML = '<div role="link"><span id="s">x</span></div>';
    const span = document.getElementById('s');
    expect(shouldTranslate('See more docs.', span)).toBe(false);
  });

  it('translates 3+ word text inside <a> now that the short-link threshold matches MIN_WORD_COUNT', () => {
    document.body.innerHTML = '<a href="#"><span id="s">x</span></a>';
    const span = document.getElementById('s');
    expect(shouldTranslate('See more docs.', span)).toBe(true);
    expect(shouldTranslate('Read full article today.', span)).toBe(true);
  });

  it('accepts long text inside <a>', () => {
    document.body.innerHTML = '<a href="#"><span id="s">x</span></a>';
    const span = document.getElementById('s');
    expect(
      shouldTranslate('This is a long article about TypeScript fundamentals today.', span)
    ).toBe(true);
  });

  it('translates 3+ word text inside <label>', () => {
    document.body.innerHTML = '<label><span id="s">x</span></label>';
    const span = document.getElementById('s');
    expect(shouldTranslate('Enter your email here.', span)).toBe(true);
  });

  it('translates 3+ word text inside <summary>', () => {
    document.body.innerHTML = '<details><summary><span id="s">x</span></summary></details>';
    const span = document.getElementById('s');
    expect(shouldTranslate('See more details please.', span)).toBe(true);
  });

  it('rejects URL-like link text inside <a> regardless of length', () => {
    // Defensive: a sentence-shaped URL shouldn't slip through even if it
    // somehow passes the word-count thresholds.
    document.body.innerHTML = '<a href="#"><span id="s">x</span></a>';
    const span = document.getElementById('s');
    // 1-word URL is rejected by MIN_WORD_COUNT, but isAddressLike is the
    // explicit guard for any future loosening of those thresholds.
    expect(shouldTranslate('https://example.com', span)).toBe(false);
    expect(shouldTranslate('docs.example.com/very/long/path', span)).toBe(false);
  });

  it('translates wording link text once it clears the short-link threshold', () => {
    document.body.innerHTML = '<a href="#"><span id="s">x</span></a>';
    const span = document.getElementById('s');
    expect(
      shouldTranslate('Read the full documentation here today please', span)
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// setVisibility
// ---------------------------------------------------------------------------
describe('setVisibility', () => {
  it('hides every data-subtitler-injected element', () => {
    document.body.innerHTML = `
      <span data-subtitler-injected="true">a</span>
      <span data-subtitler-injected="true">b</span>
      <span>c</span>
    `;
    setVisibility(false);
    const injected = document.querySelectorAll('[data-subtitler-injected="true"]');
    for (const el of injected) {
      expect(el.style.display).toBe('none');
    }
    const plain = document.querySelectorAll('span:not([data-subtitler-injected])');
    for (const el of plain) {
      expect(el.style.display).toBe('');
    }
  });

  it('clears the inline display when shown', () => {
    document.body.innerHTML = `
      <span data-subtitler-injected="true" style="display: none;">a</span>
    `;
    setVisibility(true);
    const el = document.querySelector('[data-subtitler-injected="true"]');
    expect(el.style.display).toBe('');
  });
});

// ---------------------------------------------------------------------------
// processTextNode
// ---------------------------------------------------------------------------
describe('processTextNode', () => {
  it('inserts loading spans for each translatable sentence', () => {
    document.body.innerHTML = '<p id="p">Hello world today. Goodbye yesterday already.</p>';
    state.visible = true;
    const tn = document.getElementById('p').firstChild;
    const count = processTextNode(tn);
    expect(count).toBe(2);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(2);
    expect(state.injected).toBe(true);
  });

  it('does not inject when the text has no Latin letters', () => {
    document.body.innerHTML = '<p id="p">こんにちは世界</p>';
    state.visible = true;
    const tn = document.getElementById('p').firstChild;
    const count = processTextNode(tn);
    expect(count).toBe(0);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });

  it('does not inject when shouldTranslate rejects every sentence', () => {
    document.body.innerHTML = '<button id="b">Click here to submit now.</button>';
    state.visible = true;
    const tn = document.getElementById('b').firstChild;
    const count = processTextNode(tn);
    expect(count).toBe(0);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });

  it('marks unprocessable text nodes so they are skipped on a re-walk', () => {
    document.body.innerHTML = '<button id="b">Click here to submit now.</button>';
    state.visible = true;
    const tn = document.getElementById('b').firstChild;
    processTextNode(tn);
    // collectFromTextNode would short-circuit even before SKIP_TAGS check
    expect(collectFromTextNode(tn)).toBe(0);
  });

  it('hides loading inline when state.visible is false at injection time', () => {
    document.body.innerHTML = '<p id="p">Hello world today.</p>';
    state.visible = false;
    const tn = document.getElementById('p').firstChild;
    processTextNode(tn);
    const loading = document.querySelector('.subtitler-loading');
    expect(loading).not.toBeNull();
    expect(loading.style.display).toBe('none');
  });

  it('returns 0 for an orphan text node (no parentNode)', () => {
    const orphan = document.createTextNode('Hello world today.');
    expect(processTextNode(orphan)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// processBlock — inline-spanning sentence aggregation
// ---------------------------------------------------------------------------
describe('processBlock (inline-spanning aggregation)', () => {
  it('aggregates a sentence split by an <a> into a single loading after the tail', () => {
    document.body.innerHTML =
      '<p id="p">For more information, visit the <a href="#">Amazon EC2 M8i instance</a> page.</p>';
    state.visible = true;
    const p = document.getElementById('p');
    const count = processBlock(p);
    expect(count).toBe(1);
    const loadings = p.querySelectorAll('.subtitler-loading');
    expect(loadings.length).toBe(1);
    expect(loadings[0].dataset.subtitlerSentence).toBe(
      'For more information, visit the Amazon EC2 M8i instance page.'
    );
    // The loading should appear after the link, not inside it.
    expect(p.querySelector('a').contains(loadings[0])).toBe(false);
    // The link's anchor text must be preserved verbatim.
    expect(p.querySelector('a').textContent).toBe('Amazon EC2 M8i instance');
  });

  it('aggregates across an inline <em>', () => {
    document.body.innerHTML =
      '<p id="p">This is <em>great</em> news for the team today.</p>';
    state.visible = true;
    const p = document.getElementById('p');
    const count = processBlock(p);
    expect(count).toBe(1);
    expect(p.querySelectorAll('.subtitler-loading').length).toBe(1);
  });

  it('does not translate a standalone <a> that is just a URL', () => {
    document.body.innerHTML = '<p id="p"><a href="https://example.com">https://example.com</a></p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });

  it('translates a 3-word standalone wording link with the lowered threshold', () => {
    document.body.innerHTML = '<p id="p"><a href="#">Read the docs</a></p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(1);
  });

  it('translates a long enough standalone wording link', () => {
    document.body.innerHTML =
      '<p id="p"><a href="#">Read the full documentation here today please</a></p>';
    state.visible = true;
    const count = processBlock(document.getElementById('p'));
    expect(count).toBe(1);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(1);
  });

  it('translates the surrounding sentence even when it embeds a URL link', () => {
    document.body.innerHTML =
      '<p id="p">For details please visit <a href="https://example.com">https://example.com</a> today.</p>';
    state.visible = true;
    const p = document.getElementById('p');
    const count = processBlock(p);
    expect(count).toBe(1);
    const loadings = p.querySelectorAll('.subtitler-loading');
    expect(loadings.length).toBe(1);
    expect(loadings[0].dataset.subtitlerSentence).toContain('https://example.com');
    // URL-as-link-text is preserved exactly.
    expect(p.querySelector('a').textContent).toBe('https://example.com');
  });

  it('does not merge prose across a nested block boundary', () => {
    document.body.innerHTML =
      '<div id="d">Hello world today. <p>Different paragraph entirely here.</p> Goodbye for now everyone.</div>';
    state.visible = true;
    processBlock(document.getElementById('d'));
    // Three separate sentences -> three loadings, not aggregated across <p>.
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(3);
  });

  it('rejects sentence-spanning aggregation inside <button>', () => {
    document.body.innerHTML =
      '<button id="b">Click <span>here</span> to submit now please.</button>';
    state.visible = true;
    processBlock(document.getElementById('b'));
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Codex review regressions
// ---------------------------------------------------------------------------
describe('processBlock (regression coverage)', () => {
  it('does not concatenate prose across an inline SKIP_TAG element', () => {
    // Without the run-flush fix, "Use the " and " command today please." were
    // joined as "Use the  command today please." with the <code> content
    // silently dropped from the translation input.
    document.body.innerHTML =
      '<p id="p">Use the <code>aws ec2</code> command today please.</p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    // The <code> body must be preserved verbatim.
    expect(document.querySelector('code').textContent).toBe('aws ec2');
    // Whatever sentences we queued, none of them may contain the corrupted
    // "Use the  command" form.
    const loadings = document.querySelectorAll('.subtitler-loading');
    for (const l of loadings) {
      expect(l.dataset.subtitlerSentence).not.toMatch(/Use the\s{2,}command/);
    }
  });

  it('does not concatenate words across <br>', () => {
    document.body.innerHTML = '<p id="p">Hello<br>world today everyone.</p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    const loadings = document.querySelectorAll('.subtitler-loading');
    for (const l of loadings) {
      expect(l.dataset.subtitlerSentence).not.toContain('Helloworld');
    }
  });

  it('translates a standalone wording link even when only punctuation lies outside <a>', () => {
    // The meaningful-segments fix still resolves the ancestor to <a>; with the
    // lowered threshold (== MIN_WORD_COUNT) a 3-word link now translates.
    document.body.innerHTML = '<p id="p"><a href="#">Read more docs</a>.</p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(1);
  });

  it('still translates an in-prose link followed by trailing punctuation', () => {
    document.body.innerHTML =
      '<p id="p">For more information, visit the <a href="#">Amazon EC2 instance</a>.</p>';
    state.visible = true;
    const count = processBlock(document.getElementById('p'));
    expect(count).toBe(1);
    const loading = document.querySelector('.subtitler-loading');
    expect(loading.dataset.subtitlerSentence).toBe(
      'For more information, visit the Amazon EC2 instance.'
    );
  });
});

describe('collectAndInject (regression coverage)', () => {
  it('reprocesses the parent block when MutationObserver receives an added inline element', () => {
    document.body.innerHTML =
      '<p id="p">For more information, visit the <a id="a" href="#">Amazon EC2 M8i instance</a> page.</p>';
    state.visible = true;

    const count = collectAndInject(document.getElementById('a'));

    expect(count).toBe(1);
    const p = document.getElementById('p');
    const loading = p.querySelector('.subtitler-loading');
    expect(loading).not.toBeNull();
    expect(loading.dataset.subtitlerSentence).toBe(
      'For more information, visit the Amazon EC2 M8i instance page.'
    );
    expect(p.querySelector('a').contains(loading)).toBe(false);
    expect(p.querySelector('a').textContent).toBe('Amazon EC2 M8i instance');
  });

  it('defers an added inline element until later tail text completes the sentence', () => {
    document.body.innerHTML =
      '<p id="p">For more information, visit the </p>';
    state.visible = true;
    const p = document.getElementById('p');
    const link = document.createElement('a');
    link.id = 'a';
    link.href = '#';
    link.textContent = 'Amazon EC2 M8i instance';
    p.appendChild(link);

    expect(collectAndInject(link)).toBe(0);
    expect(p.querySelectorAll('.subtitler-loading').length).toBe(0);

    const tail = document.createTextNode(' page.');
    p.appendChild(tail);

    expect(collectFromTextNode(tail)).toBe(1);
    const loading = p.querySelector('.subtitler-loading');
    expect(loading.dataset.subtitlerSentence).toBe(
      'For more information, visit the Amazon EC2 M8i instance page.'
    );
  });

  it('keeps staged MutationObserver text unprocessed until the sentence is complete', () => {
    document.body.innerHTML = '<p id="p"></p>';
    state.visible = true;
    const p = document.getElementById('p');
    const prefix = document.createTextNode('For more information, visit the ');
    p.appendChild(prefix);

    expect(collectFromTextNode(prefix, { deferIncompleteFinal: true })).toBe(0);

    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Amazon EC2 M8i instance';
    p.appendChild(link);

    expect(collectAndInject(link)).toBe(0);

    const tail = document.createTextNode(' page.');
    p.appendChild(tail);

    expect(collectFromTextNode(tail, { deferIncompleteFinal: true })).toBe(1);
    expect(p.querySelector('.subtitler-loading').dataset.subtitlerSentence).toBe(
      'For more information, visit the Amazon EC2 M8i instance page.'
    );
  });

  it('rejects an element added inside a SKIP_TAG ancestor', () => {
    // Simulates MutationObserver receiving a freshly-added <span> that lives
    // inside an existing <code>. The new pipeline must walk ancestors so the
    // span is not processed.
    document.body.innerHTML = '<pre><code><span id="s">aws ec2 describe-instances</span></code></pre>';
    state.visible = true;
    expect(collectAndInject(document.getElementById('s'))).toBe(0);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });

  it('rejects an element added inside a contenteditable ancestor', () => {
    document.body.innerHTML =
      '<div contenteditable="true"><p id="p">Hello world today is fine.</p></div>';
    state.visible = true;
    expect(collectAndInject(document.getElementById('p'))).toBe(0);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });

  it('translates both the standalone link and a sibling sentence when both clear MIN_WORD_COUNT', () => {
    // The meaningful-segments slicing still resolves sentence 1's ancestor to
    // <a> rather than <p> (so its filter walk still sees the link), but with
    // the lowered threshold the 3-word link itself now translates.
    document.body.innerHTML =
      '<p id="p"><a href="#">Read more docs</a>. More text follows today.</p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    const loadings = document.querySelectorAll('.subtitler-loading');
    expect(loadings.length).toBe(2);
    expect(loadings[0].dataset.subtitlerSentence).toBe('Read more docs.');
    expect(loadings[1].dataset.subtitlerSentence).toBe('More text follows today.');
    // The loading for sentence 1 lands in <p> (the period sits outside <a>),
    // so neither loading should be planted inside the link.
    expect(document.querySelector('a').querySelector('.subtitler-loading')).toBeNull();
  });

  it('lifts the loading span out of an <a> when the sentence ends inside it', () => {
    document.body.innerHTML =
      '<p id="p">For details please visit <a href="#">the Amazon EC2 instance page.</a></p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    const loading = document.querySelector('.subtitler-loading');
    expect(loading).not.toBeNull();
    // The translation span must not be a descendant of the <a>, otherwise
    // clicks on the subtitle would activate the link and the link's
    // styling/box would absorb the subtitle.
    expect(document.querySelector('a').contains(loading)).toBe(false);
    expect(loading.dataset.subtitlerSentence).toBe(
      'For details please visit the Amazon EC2 instance page.'
    );
  });

  it('lifts the loading even when only whitespace follows it inside <a>', () => {
    // Mirrors the SPA pattern where a link skeleton is rendered with a
    // whitespace-only child first, that whitespace gets marked processed,
    // and the body is dropped in afterwards. The trailing whitespace must
    // not block the lift, otherwise the subtitle stays a child of <a> and
    // the click-area regression returns.
    document.body.innerHTML = '<p id="p">Please visit <a id="link"> </a></p>';
    state.visible = true;
    processBlock(document.getElementById('p'));
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);

    const link = document.getElementById('link');
    const body = document.createTextNode(
      'the comprehensive documentation page available right now today please'
    );
    link.insertBefore(body, link.firstChild);

    processBlock(document.getElementById('p'));
    const loading = document.querySelector('.subtitler-loading');
    expect(loading).not.toBeNull();
    expect(link.contains(loading)).toBe(false);
  });

  it('treats already-processed text nodes as run boundaries when re-walking', () => {
    // Simulates a MutationObserver delivering a fresh prefix and suffix on
    // either side of a previously-translated middle text node. Without
    // flushing at processed boundaries, the prefix and suffix would join
    // (eliding the middle's content) and the translator would receive a
    // corrupted "Hello  world today everyone." sentence.
    document.body.innerHTML = '<p id="p"></p>';
    state.visible = true;
    const p = document.getElementById('p');
    const middle = document.createTextNode('In between sentence here.');
    p.appendChild(middle);
    // First pass: translate the middle, marking it processed.
    processBlock(p);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(1);

    // Now SPA-style additions arrive on either side of the (now processed)
    // middle text node.
    const prefix = document.createTextNode('Hello ');
    p.insertBefore(prefix, p.firstChild);
    const suffix = document.createTextNode(' world today everyone.');
    p.appendChild(suffix);
    processBlock(p);

    const loadings = document.querySelectorAll('.subtitler-loading');
    for (const l of loadings) {
      expect(l.dataset.subtitlerSentence || '').not.toMatch(/Hello\s{2,}world/);
      expect(l.dataset.subtitlerSentence || '').not.toBe('Hello  world today everyone.');
    }
  });

  it('keeps deferred trailing prose mergeable with later additions in the same node', () => {
    // The text node below holds a complete first sentence and a deferred
    // partial. Without preserving the tail as un-processed, the next batch
    // (which delivers the link and its trailing " page.") would only see
    // "Amazon EC2 M8i instance page." and translate that fragment instead of
    // the full sentence.
    document.body.innerHTML = '<p id="p"></p>';
    state.visible = true;
    const p = document.getElementById('p');
    const head = document.createTextNode(
      'First complete sentence here please. For more information, visit the '
    );
    p.appendChild(head);

    expect(collectFromTextNode(head, { deferIncompleteFinal: true })).toBe(1);

    const link = document.createElement('a');
    link.href = '#';
    link.textContent = 'Amazon EC2 M8i instance';
    p.appendChild(link);

    expect(collectAndInject(link)).toBe(0);

    const tail = document.createTextNode(' page.');
    p.appendChild(tail);

    expect(collectFromTextNode(tail, { deferIncompleteFinal: true })).toBe(1);

    const sentences = [...document.querySelectorAll('.subtitler-loading')].map(
      (l) => l.dataset.subtitlerSentence
    );
    expect(sentences).toContain('First complete sentence here please.');
    expect(sentences).toContain(
      'For more information, visit the Amazon EC2 M8i instance page.'
    );
  });

  it('rejects an element added inside an already-injected ancestor', () => {
    document.body.innerHTML =
      '<div data-subtitler-injected="true"><p id="p">Hello world today is fine.</p></div>';
    state.visible = true;
    expect(collectAndInject(document.getElementById('p'))).toBe(0);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// collectAndInject
// ---------------------------------------------------------------------------
describe('collectAndInject', () => {
  it('skips SCRIPT/STYLE/SELECT/OPTION/OPTGROUP subtrees', () => {
    document.body.innerHTML = `
      <script>var foo = "Hello world today. This is a test.";</script>
      <style>body { content: "Hello world today."; }</style>
      <select><option>Please select your preferred delivery method below today</option></select>
      <p>Hello world today.</p>
    `;
    state.visible = true;
    const count = collectAndInject(document.body);
    expect(count).toBe(1);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(1);
    expect(
      document.querySelector('option').querySelectorAll('.subtitler-loading').length
    ).toBe(0);
  });

  it('skips contenteditable subtree', () => {
    document.body.innerHTML = '<div contenteditable="true">Hello world today is fine.</div>';
    state.visible = true;
    const count = collectAndInject(document.body);
    expect(count).toBe(0);
  });

  it('skips already-injected subtrees', () => {
    document.body.innerHTML =
      '<p data-subtitler-injected="true">Hello world today is fine.</p>';
    state.visible = true;
    const count = collectAndInject(document.body);
    expect(count).toBe(0);
  });

  it('returns 0 when the root itself is in SKIP_TAGS', () => {
    document.body.innerHTML = '<select id="s"><option>Please choose something interesting now.</option></select>';
    state.visible = true;
    const select = document.getElementById('s');
    expect(collectAndInject(select)).toBe(0);
  });

  it('handles null / non-element roots gracefully', () => {
    expect(collectAndInject(null)).toBe(0);
    expect(collectAndInject(undefined)).toBe(0);
  });

  it('walks nested elements end-to-end', () => {
    document.body.innerHTML = `
      <article>
        <h1>This is the article title here.</h1>
        <p>First paragraph runs across this line.</p>
        <p>Second paragraph keeps going onward.</p>
      </article>
    `;
    state.visible = true;
    const count = collectAndInject(document.body);
    expect(count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// collectFromTextNode
// ---------------------------------------------------------------------------
describe('collectFromTextNode', () => {
  it('returns 0 when an ancestor is in SKIP_TAGS', () => {
    document.body.innerHTML =
      '<select><option id="o">Please choose your preferred delivery method.</option></select>';
    state.visible = true;
    const tn = document.getElementById('o').firstChild;
    expect(collectFromTextNode(tn)).toBe(0);
  });

  it('returns 0 when a parent is data-subtitler-injected', () => {
    document.body.innerHTML =
      '<span id="x" data-subtitler-injected="true">Hello world today is fine.</span>';
    state.visible = true;
    const tn = document.getElementById('x').firstChild;
    expect(collectFromTextNode(tn)).toBe(0);
  });

  it('processes a valid text node', () => {
    document.body.innerHTML = '<p id="p">Hello world today is fine.</p>';
    state.visible = true;
    const tn = document.getElementById('p').firstChild;
    expect(collectFromTextNode(tn)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleToggle state machine
// ---------------------------------------------------------------------------
describe('handleToggle', () => {
  it('the first toggle sets injected=true and visible=true', async () => {
    document.body.innerHTML = '<p>Hello world today. Another sentence here please.</p>';
    await handleToggle();
    expect(state.injected).toBe(true);
    expect(state.visible).toBe(true);
  });

  it('a second toggle hides every injected element', async () => {
    document.body.innerHTML = '<p>Hello world today. Another sentence here please.</p>';
    await handleToggle();
    await handleToggle();
    expect(state.visible).toBe(false);
    const injected = document.querySelectorAll('[data-subtitler-injected="true"]');
    for (const el of injected) expect(el.style.display).toBe('none');
  });

  it('a third toggle shows every injected element again', async () => {
    document.body.innerHTML = '<p>Hello world today. Another sentence here please.</p>';
    await handleToggle();
    await handleToggle();
    await handleToggle();
    expect(state.visible).toBe(true);
    const injected = document.querySelectorAll('[data-subtitler-injected="true"]');
    for (const el of injected) expect(el.style.display).toBe('');
  });

  it('rolls back visibility if the translator is unavailable', async () => {
    globalThis.__TranslatorMock.availability.mockResolvedValueOnce('unavailable');
    document.body.innerHTML = '<p>Hello world today is fine.</p>';
    await handleToggle();
    expect(state.injected).toBe(false);
    expect(state.visible).toBe(false);
  });

  it('rolls back visibility if the page contains no translatable text', async () => {
    document.body.innerHTML = '<p>こんにちは。</p>';
    await handleToggle();
    expect(state.injected).toBe(false);
    expect(state.visible).toBe(false);
  });

  it('drops re-entrant invocations while the first one is still running', async () => {
    document.body.innerHTML = '<p>Hello world today. Another sentence here please.</p>';
    const p1 = handleToggle();
    const p2 = handleToggle();
    await Promise.all([p1, p2]);
    // At most one initialization happened
    expect(globalThis.__TranslatorMock.create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// SPA navigation: stale state.injected after the previous page's nodes
// have been swapped out of the DOM.
// ---------------------------------------------------------------------------
describe('handleToggle after SPA navigation (stale injection state)', () => {
  it('treats the page as fresh when injected nodes are gone from the DOM', async () => {
    document.body.innerHTML = '<p>Hello world today. Another sentence here please.</p>';
    await handleToggle();
    expect(state.injected).toBe(true);

    // Simulate SPA navigation: a brand-new tree replaces the previous body.
    document.body.innerHTML = '<p>A second page with new translatable text here.</p>';
    expect(document.querySelectorAll('[data-subtitler-injected="true"]').length).toBe(0);

    await handleToggle();
    expect(state.injected).toBe(true);
    expect(state.visible).toBe(true);
    expect(document.querySelectorAll('.subtitler-loading').length).toBeGreaterThan(0);
  });

  it('does not get stuck hidden if the user had toggled off before navigating', async () => {
    document.body.innerHTML = '<p>Hello world today. Another sentence here please.</p>';
    await handleToggle();   // on
    await handleToggle();   // off
    expect(state.visible).toBe(false);

    document.body.innerHTML = '<p>A second page with new translatable text here.</p>';
    await handleToggle();   // should be ON again on the new page
    expect(state.visible).toBe(true);
    const loadings = document.querySelectorAll('.subtitler-loading');
    expect(loadings.length).toBeGreaterThan(0);
    for (const el of loadings) expect(el.style.display).toBe('');
  });
});

// ---------------------------------------------------------------------------
// IntersectionObserver-driven lazy translation
// ---------------------------------------------------------------------------
describe('lazy translation via IntersectionObserver', () => {
  it('only translates loadings that intersect the viewport', async () => {
    document.body.innerHTML = '<p>Hello world today. A second sentence appears here.</p>';
    await handleToggle();
    const loadings = document.querySelectorAll('.subtitler-loading');
    expect(loadings.length).toBe(2);

    const io = globalThis.__IntersectionObserverMock.instances[0];
    expect(io).toBeDefined();
    io.trigger(loadings[0]);
    await globalThis.__flushAsync();

    expect(document.querySelectorAll('.subtitler-ja').length).toBe(1);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(1);
  });

  it('translates remaining loadings when they enter the viewport later', async () => {
    document.body.innerHTML = '<p>Hello world today. A second sentence appears here.</p>';
    await handleToggle();
    const io = globalThis.__IntersectionObserverMock.instances[0];
    io.triggerObserved();
    await globalThis.__flushAsync();
    expect(document.querySelectorAll('.subtitler-ja').length).toBe(2);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(0);
  });

  it('stores translations in the cache after first lookup', async () => {
    document.body.innerHTML = '<p>Hello world today is fine.</p>';
    await handleToggle();
    const io = globalThis.__IntersectionObserverMock.instances[0];
    io.triggerObserved();
    await globalThis.__flushAsync();
    expect(__test.cache.has('Hello world today is fine.')).toBe(true);
    expect(__test.cache.get('Hello world today is fine.')).toBe(
      '[ja]Hello world today is fine.'
    );
  });

  it('reuses the cache instead of calling translator again', async () => {
    document.body.innerHTML = '<p>Hello world today is fine.</p>';
    await handleToggle();
    const io = globalThis.__IntersectionObserverMock.instances[0];
    io.triggerObserved();
    await globalThis.__flushAsync();

    const instance = await globalThis.__TranslatorMock.create.mock.results[0].value;
    expect(__test.cache.has('Hello world today is fine.')).toBe(true);
    instance.translate.mockClear();

    // Add a second occurrence of the same sentence. MutationObserver picks it
    // up and inserts a new loading; triggering IO drains it from the queue.
    const extra = document.createElement('p');
    extra.textContent = 'Hello world today is fine.';
    document.body.appendChild(extra);
    await globalThis.__flushAsync(10);

    const newLoadings = document.querySelectorAll('.subtitler-loading');
    expect(newLoadings.length).toBe(1);
    io.trigger(newLoadings[0]);
    await globalThis.__flushAsync();

    expect(instance.translate).not.toHaveBeenCalled();
    expect(document.querySelectorAll('.subtitler-ja').length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// replaceLoadingWithTranslation
// ---------------------------------------------------------------------------
describe('replaceLoadingWithTranslation', () => {
  it('replaces a loading span with a subtitler-ja span', () => {
    document.body.innerHTML =
      '<p><span id="l" class="subtitler-loading" data-subtitler-injected="true">Translating...</span></p>';
    state.visible = true;
    replaceLoadingWithTranslation(document.getElementById('l'), 'こんにちは');
    expect(document.querySelector('.subtitler-loading')).toBeNull();
    const ja = document.querySelector('.subtitler-ja');
    expect(ja).not.toBeNull();
    expect(ja.textContent).toBe('こんにちは');
    expect(ja.dataset.subtitlerInjected).toBe('true');
  });

  it('hides the new ja span when state.visible is false', () => {
    document.body.innerHTML =
      '<p><span id="l" class="subtitler-loading" data-subtitler-injected="true">Translating...</span></p>';
    state.visible = false;
    replaceLoadingWithTranslation(document.getElementById('l'), 'こんにちは');
    expect(document.querySelector('.subtitler-ja').style.display).toBe('none');
  });

  it('is a no-op for a detached loading element', () => {
    const detached = document.createElement('span');
    detached.className = 'subtitler-loading';
    replaceLoadingWithTranslation(detached, 'こんにちは');
    expect(document.querySelector('.subtitler-ja')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Idempotency / regression coverage
// ---------------------------------------------------------------------------
describe('idempotent re-scan (regression)', () => {
  it('does not duplicate subtitles when collectAndInject is called twice on the same root', () => {
    document.body.innerHTML = '<p>Hello world today. Goodbye for now everyone.</p>';
    state.visible = true;
    collectAndInject(document.body);
    const before = document.querySelectorAll('.subtitler-loading').length;
    collectAndInject(document.body);
    expect(document.querySelectorAll('.subtitler-loading').length).toBe(before);
  });

  it('does not duplicate when a translated subtree is reparented', () => {
    document.body.innerHTML =
      '<div id="src"><p>Hello world today. Another sentence here please.</p></div><div id="dst"></div>';
    state.visible = true;
    collectAndInject(document.body);
    const before = document.querySelectorAll('.subtitler-loading').length;

    const p = document.querySelector('#src p');
    document.getElementById('dst').appendChild(p);
    // Simulate the MutationObserver pathway calling collectAndInject on the
    // moved subtree.
    collectAndInject(p);

    expect(document.querySelectorAll('.subtitler-loading').length).toBe(before);
  });
});

describe('<option> regression', () => {
  it('skips long-text options unconditionally', () => {
    document.body.innerHTML =
      '<select><option>Please select your preferred delivery method below today</option></select>';
    state.visible = true;
    collectAndInject(document.body);
    const optionSpans = document
      .querySelector('option')
      .querySelectorAll('.subtitler-loading, .subtitler-ja');
    expect(optionSpans.length).toBe(0);
  });

  it('skips OPTGROUP descendants', () => {
    document.body.innerHTML =
      '<select><optgroup label="g"><option>Please pick your preferred delivery method below.</option></optgroup></select>';
    state.visible = true;
    collectAndInject(document.body);
    expect(
      document.querySelectorAll('.subtitler-loading').length
    ).toBe(0);
  });
});
