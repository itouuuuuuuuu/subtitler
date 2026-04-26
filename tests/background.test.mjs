import { describe, it, expect, beforeEach } from 'vitest';

// Importing background.js registers chrome.commands / chrome.action /
// chrome.runtime.onInstalled listeners against the mocked chrome API.
import bg from '../extension/background.js';

describe('sendToggle', () => {
  beforeEach(() => {
    chrome.tabs.sendMessage.mockClear();
  });

  it('sends a TOGGLE message to the given tab', async () => {
    await bg.sendToggle(42);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(42, { type: 'TOGGLE' });
  });

  it('swallows errors so a missing content script does not throw', async () => {
    chrome.tabs.sendMessage.mockRejectedValueOnce(new Error('No receiving end'));
    await expect(bg.sendToggle(7)).resolves.toBeUndefined();
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
