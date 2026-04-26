// Global mocks installed before any test file imports the extension sources.
// content.js / background.js have top-level side effects (chrome.* listener
// registration, window keydown listener, console.info logs) that need a
// browser-shaped global environment to evaluate without throwing.

import { vi } from 'vitest';

// ---------- IntersectionObserver mock --------------------------------------
class IntersectionObserverMock {
  static instances = [];

  constructor(cb, opts = {}) {
    this.cb = cb;
    this.opts = opts;
    this.observed = new Set();
    IntersectionObserverMock.instances.push(this);
  }

  observe(el) {
    this.observed.add(el);
  }
  unobserve(el) {
    this.observed.delete(el);
  }
  disconnect() {
    this.observed.clear();
  }

  // ---- Test-only helpers ----
  trigger(elements, isIntersecting = true) {
    const list = Array.isArray(elements) ? elements : [elements];
    const entries = list.map((target) => ({ target, isIntersecting }));
    this.cb(entries, this);
    if (isIntersecting) {
      for (const el of list) this.observed.delete(el);
    }
  }
  triggerObserved() {
    this.trigger([...this.observed]);
  }
}
globalThis.IntersectionObserver = IntersectionObserverMock;
globalThis.__IntersectionObserverMock = IntersectionObserverMock;

// ---------- Translator API mock --------------------------------------------
function makeTranslatorInstance() {
  return {
    translate: vi.fn(async (text) => `[ja]${text}`),
  };
}

const TranslatorMock = {
  availability: vi.fn(async () => 'available'),
  create: vi.fn(async () => makeTranslatorInstance()),
};
globalThis.Translator = TranslatorMock;
globalThis.__TranslatorMock = TranslatorMock;
globalThis.__makeTranslatorInstance = makeTranslatorInstance;

// ---------- chrome.* mock --------------------------------------------------
globalThis.chrome = {
  runtime: {
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    lastError: null,
  },
  tabs: {
    sendMessage: vi.fn(async () => undefined),
    query: vi.fn(async () => [{ id: 1 }]),
  },
  action: {
    onClicked: { addListener: vi.fn() },
  },
  commands: {
    onCommand: { addListener: vi.fn() },
    getAll: vi.fn(async () => [
      { name: 'toggle-translation', shortcut: 'Cmd+Shift+Y' },
    ]),
  },
};

// ---------- requestIdleCallback mock ---------------------------------------
// jsdom does not provide rIC; mirror it onto setTimeout so MutationObserver
// driven processing can be exercised by awaiting microtasks/timeouts.
globalThis.requestIdleCallback = (cb) =>
  setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0);
globalThis.cancelIdleCallback = (id) => clearTimeout(id);

// ---------- Helpers exposed to tests ---------------------------------------
// Drains microtasks + a few macrotask ticks. Useful when test code triggers
// an async pipeline (handleToggle -> ensureTranslator -> drainQueue ->
// translateOne -> replaceLoadingWithTranslation) and we need the DOM to
// stabilise before assertions.
globalThis.__flushAsync = async function flushAsync(ticks = 5) {
  for (let i = 0; i < ticks; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
};
