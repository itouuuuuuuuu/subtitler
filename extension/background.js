async function sendToggle(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'TOGGLE' });
  } catch (e) {
    console.warn(
      '[subtitler/bg] Could not deliver TOGGLE to content script. ' +
        'Note: chrome:// pages and the Web Store are not supported.',
      e?.message
    );
  }
}

chrome.commands.onCommand.addListener(async (command) => {
  console.info('[subtitler/bg] command received:', command);
  if (command !== 'toggle-translation') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) sendToggle(tab.id);
});

chrome.action.onClicked.addListener((tab) => {
  console.info('[subtitler/bg] action clicked');
  if (tab?.id) sendToggle(tab.id);
});

chrome.runtime.onInstalled.addListener(async () => {
  try {
    const cmds = await chrome.commands.getAll();
    const target = cmds.find((c) => c.name === 'toggle-translation');
    if (target && !target.shortcut) {
      console.warn(
        '[subtitler/bg] No shortcut bound for toggle-translation. ' +
          'Set one manually at chrome://extensions/shortcuts.'
      );
    }
  } catch (e) {
    console.warn('[subtitler/bg] commands.getAll() failed:', e);
  }
});
