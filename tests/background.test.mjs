import { describe, it, expect, beforeEach } from 'vitest';

// Importing background.js registers chrome.commands / chrome.action /
// chrome.runtime.onInstalled listeners against the mocked chrome API.
import bg from '../extension/background.js';

describe('sendToggle', () => {
  beforeEach(() => {
    chrome.tabs.sendMessage.mockClear();
    chrome.scripting.executeScript.mockClear();
    chrome.scripting.insertCSS.mockClear();
  });

  it('sends a TOGGLE message to the given tab without re-injecting when a content script already responds', async () => {
    await bg.sendToggle(42);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'TOGGLE' });
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(chrome.scripting.insertCSS).not.toHaveBeenCalled();
  });

  it('injects content.js + styles.css then retries TOGGLE when no listener exists yet', async () => {
    chrome.tabs.sendMessage
      .mockRejectedValueOnce(new Error('No receiving end'))
      .mockResolvedValueOnce(undefined);
    await bg.sendToggle(7);
    expect(chrome.scripting.insertCSS).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['styles.css'],
    });
    expect(chrome.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7 },
      files: ['content.js'],
    });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(2);
    expect(chrome.tabs.sendMessage).toHaveBeenLastCalledWith(7, { type: 'TOGGLE' });
  });

  it('swallows injection errors (e.g. chrome:// pages where scripting is forbidden)', async () => {
    chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('No receiving end'));
    chrome.scripting.executeScript.mockRejectedValueOnce(new Error('Cannot access a chrome:// URL'));
    await expect(bg.sendToggle(7)).resolves.toBeUndefined();
    // Only the initial TOGGLE attempt; the post-injection retry never runs.
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('swallows errors when the post-injection TOGGLE itself fails', async () => {
    chrome.tabs.sendMessage
      .mockRejectedValueOnce(new Error('No receiving end'))
      .mockRejectedValueOnce(new Error('Tab discarded'));
    await expect(bg.sendToggle(7)).resolves.toBeUndefined();
    expect(chrome.scripting.executeScript).toHaveBeenCalled();
  });
});

describe('chrome.commands.onCommand listener', () => {
  it('was registered at module load time', () => {
    expect(chrome.commands.onCommand.addListener).toHaveBeenCalled();
  });

  it('forwards "toggle-translation" to the active tab', async () => {
    chrome.tabs.sendMessage.mockClear();
    chrome.tabs.query.mockResolvedValueOnce([{ id: 99 }]);
    const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
    await handler('toggle-translation');
    expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(99, { type: 'TOGGLE' });
  });

  it('ignores other command names', async () => {
    chrome.tabs.sendMessage.mockClear();
    const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
    await handler('something-else');
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it('does not crash when chrome.tabs.query returns an empty list', async () => {
    chrome.tabs.sendMessage.mockClear();
    chrome.tabs.query.mockResolvedValueOnce([]);
    const handler = chrome.commands.onCommand.addListener.mock.calls[0][0];
    await handler('toggle-translation');
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('chrome.action.onClicked listener', () => {
  it('was registered at module load time', () => {
    expect(chrome.action.onClicked.addListener).toHaveBeenCalled();
  });

  it('forwards a click on the toolbar icon as TOGGLE', async () => {
    chrome.tabs.sendMessage.mockClear();
    const handler = chrome.action.onClicked.addListener.mock.calls[0][0];
    handler({ id: 17 });
    // sendToggle is async; await a microtask to let it resolve.
    await Promise.resolve();
    await Promise.resolve();
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(17, { type: 'TOGGLE' });
  });

  it('does nothing when the tab has no id', async () => {
    chrome.tabs.sendMessage.mockClear();
    const handler = chrome.action.onClicked.addListener.mock.calls[0][0];
    handler({});
    await Promise.resolve();
    expect(chrome.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('chrome.runtime.onInstalled listener', () => {
  it('was registered at module load time', () => {
    expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalled();
  });
});
