/* Shorts AutoNext — background: command relay only. Sleeps otherwise. */
"use strict";

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.includes("youtube.com")) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { type: cmd });
  } catch (_) {
    // content script not injected (not a Shorts page yet) — ignore
  }
});
