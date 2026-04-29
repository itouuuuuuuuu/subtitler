# subtitler

A Chrome extension that toggles subtitle-style Japanese translations under English sentences on any web page. The original text stays in place, and the translation is rendered just below it — sentence by sentence — so you can read both side by side.

Translation runs entirely on-device using Chrome's built-in Translator API. Nothing is sent to a remote server.

## Features

- **Toggle on/off with a shortcut** — show or hide translations instantly without reloading the page.
- **Sentence-level alignment** — translations are inserted right after each English sentence, not as a separate block at the bottom of the page.
- **Lazy translation via `IntersectionObserver`** — only sentences that enter the viewport are translated, keeping long pages fast and reducing model calls.
- **Concurrency-limited translation queue** — at most a few sentences are translated in parallel.
- **Dynamic content support** — a `MutationObserver` picks up text added by SPAs, infinite scroll, etc.
- **UI-label filtering** — short text inside `<button>`, `role="button"`, standalone `<a>`, `<label>`, `<summary>`, etc. is skipped, so navigation links and button labels stay clean. Hyperlinks whose text is just a URL are also skipped.
- **Inline-link sentence support** — when a link sits in the middle of a sentence (e.g. `For more information, visit the <a>EC2 M8i instance</a> page.`), the surrounding sentence is translated as a single unit instead of being broken into fragments.
- **On-device translation** — uses Chrome's `Translator` API (`en` → `ja`); the model is downloaded once on first use.

## Requirements

- Chrome **138+** (or any Chromium-based browser of equivalent version) with the Translator API available.
- The `en` → `ja` translation model. The first run prompts you to download it; subsequent runs use the cached model.

## Installation (unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions/` (or `arc://extensions/` in Arc).
3. Enable **Developer mode**.
4. Click **Load unpacked** and select the `extension/` directory.

## Usage

- **Keyboard shortcut**: `Cmd+Shift+Y` (macOS) / `Ctrl+Shift+Y` (Windows / Linux). Press once to translate the current page; press again to hide; press again to show.
- **Toolbar icon**: clicking the subtitler icon does the same thing as the shortcut.
- The first translation run on a fresh profile will display a banner asking you to confirm downloading the translation model. Click **Download**, or **Cancel** to abort.

### Customizing the shortcut

You can change the shortcut at `chrome://extensions/shortcuts` (`arc://extensions/shortcuts` in Arc).

> **Arc users**: the extension intentionally captures the shortcut inside the page (via `keydown` on `window`) in addition to registering it through `chrome.commands`. This is because Arc sometimes does not deliver `chrome.commands` events to the extension's service worker. If you change the shortcut in `arc://extensions/shortcuts`, also update the constants `IS_MAC` / `isToggleShortcut` in `extension/content.js` to match — otherwise only the toolbar icon will work for the new key.

### Pages where it does not run

Content scripts cannot be injected into:
- `chrome://` / `arc://` / `about:` pages
- The Chrome Web Store
- PDF viewers
- Pages with a strict CSP that blocks injected scripts

## How it works

1. On toggle, the content script ensures a `Translator` instance exists for `en` → `ja`. If the model is not downloaded yet, it shows a banner that asks for a user gesture to start the download.
2. It walks `document.body` block by block (`<p>`, `<li>`, `<div>`, etc.), skipping `<script>`, `<style>`, `<code>`, `<pre>`, contenteditable regions, and already-injected nodes.
3. Within each block, the text from adjacent text nodes and inline elements (`<a>`, `<em>`, …) is concatenated into a flat stream and split into sentences with `Intl.Segmenter`. Sentences that look like UI labels (short text inside buttons / standalone short links / labels / etc.) or whose link text is just a URL are filtered out.
4. A `<span class="subtitler-loading">Translating...</span>` placeholder is inserted after each remaining sentence.
5. An `IntersectionObserver` watches each placeholder. When it enters the viewport (with a 200px margin), the sentence is enqueued for translation.
6. A small queue drains the work with a concurrency cap of 4. Each translated sentence replaces its placeholder with `<span class="subtitler-ja">…</span>`.
7. A `MutationObserver` catches new DOM nodes added later (SPA navigation, lazy-loaded sections) and runs the same pipeline on them. Self-injected nodes are tracked in a `WeakSet` to avoid feedback loops.
8. Toggling visibility off/on simply flips inline `display` on every injected element; no re-translation is performed.

## File layout

```
extension/
  manifest.json   # MV3 manifest, commands, content_scripts
  background.js   # Service worker: relays the shortcut & toolbar click
  content.js      # Main logic: collection, translation, observers
  styles.css      # Subtitle, loading, and banner styles
tests/
  setup.mjs       # Browser-API mocks (chrome.*, Translator, IntersectionObserver, requestIdleCallback)
  content.test.mjs
  background.test.mjs
```

## Testing

The extension ships with a Vitest + jsdom test suite that covers the pure
helpers (`hasLatinLetter`, `isToggleShortcut`, `shouldTranslate`), the DOM
pipeline (`processTextNode`, `collectAndInject`, `collectFromTextNode`,
`replaceLoadingWithTranslation`, `setVisibility`), the toggle state machine
(`handleToggle`), the `IntersectionObserver`-driven lazy translation flow,
the in-memory translation cache, the `<option>` skip rule, and the
idempotent re-scan guarantee that prevents duplicate subtitles when a SPA
reparents an already-translated subtree.

```sh
npm install         # one-time
npm test            # run the suite once
npm run test:watch  # re-run on file changes
npm run test:coverage
```

Browser globals (`chrome.*`, `Translator`, `IntersectionObserver`,
`requestIdleCallback`) are mocked in `tests/setup.mjs`. Tests load the real
`extension/content.js` and `extension/background.js` modules; both files
expose a CommonJS `module.exports` block guarded by `typeof module`, which
is a no-op in the browser but makes the source units consumable from
`vitest`.

## Privacy

- All translation happens locally inside Chrome via the Translator API.
- The extension does not make any network requests of its own.
- The only `permissions`-relevant behavior is content script injection on `<all_urls>`, which is required to render translations on the page you are reading.

## Known limitations

- The translation cache is in-memory and unbounded for the lifetime of the page.
- Languages other than English → Japanese are not supported.
