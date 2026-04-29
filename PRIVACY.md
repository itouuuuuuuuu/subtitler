# Privacy Policy — subtitler

_Last updated: 2026-04-30_

`subtitler` is a Chrome extension that displays Japanese translations directly beneath English sentences on the web page you are reading.

## Summary

**The extension does not collect, store, or transmit any user data.**

## What data is processed

To render subtitles, the extension reads the visible text of the page you have actively enabled it on. That text is passed to Chrome's built-in [Translator API](https://developer.chrome.com/docs/ai/translator-api), which runs the translation model **locally on your device**.

- No page content is sent to the author of this extension.
- No page content is sent to any third-party server by this extension.
- The translation model itself is downloaded by Chrome — not by this extension — and cached by the browser. After the initial download, translation runs entirely offline.

## What data is stored

None. The extension does not use `chrome.storage`, cookies, `localStorage`, IndexedDB, or any other persistence mechanism. The only state is in-memory and is discarded as soon as the page is closed.

## What data is shared

None. The extension makes no network requests of its own.

## Permissions

The extension declares only the permissions necessary to display subtitles on the page you are reading:

- **Content script injection on `<all_urls>`** — required to insert translation `<span>` elements next to the original sentences. Translation only runs when you explicitly enable it via the keyboard shortcut (default `Alt+Shift+Y`) or by clicking the toolbar icon.

There is no use of `tabs`, `storage`, `cookies`, `webRequest`, `scripting`, or any remote-host permission.

## Children's privacy

The extension does not knowingly collect any information from anyone, including children under 13.

## Changes to this policy

If the data practices ever change, this file will be updated and the "Last updated" date above will be revised. Significant changes will also be noted in the GitHub release notes.

## Contact

Issues and questions: <https://github.com/itouuuuuuuuu/subtitler/issues>
