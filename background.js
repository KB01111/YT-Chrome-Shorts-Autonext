/* Shorts AutoNext — background: command relay only. Sleeps otherwise.
 * No "tabs" permission: chrome.tabs.query({active:true, currentWindow:true})
 * works for the action, but tab.url may be empty/undefined — handled below.
 */
"use strict";

// Mirrors SHORTS_AUTONEXT_DEFAULTS in config.js (service worker cannot see
// content-script globals; keep values in sync with config.js).
const DEFAULTS = {
  on: true,
  dir: 1,
  plays: 1,
  delay: 0,
  waitForComments: true,
  minLen: "none",
  maxLen: "none",
  minViews: "none",
  maxViews: "none",
  minLikes: "none",
  maxLikes: "none",
  minComments: "none",
  maxComments: "none",
  blockAuthors: [],
  allowAuthors: [],
  blockTags: [],
  skipNoTags: false,
  allowSubs: false,
  toggleKey: "shift+d",
  likeKey: "shift+g",
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get("cfg", (res) => {
    if (!res || res.cfg === undefined) {
      chrome.storage.local.set({ cfg: { ...DEFAULTS } });
    }
  });
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id == null) return;
  // Sharpened filter: require a Shorts URL when URL is visible.
  // Without "tabs" permission tab.url can be ""/undefined — then still try
  // sendMessage and let the try/catch below swallow the failure.
  if (typeof tab.url === "string" && tab.url) {
    if (!tab.url.includes("youtube.com") || !tab.url.includes("/shorts")) return;
  }
  try {
    await chrome.tabs.sendMessage(tab.id, { type: cmd });
  } catch (_) {
    // content script not injected (not a Shorts page yet) — ignore
  }
});
