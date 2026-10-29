/* Shorts AutoNext — popup. Single cfg object, one read, debounced writes. */
"use strict";

const DEFAULTS = {
  on: true, dir: 1, plays: 1, delay: 0, waitForComments: true,
  minLen: "none", maxLen: "none",
  minViews: "none", maxViews: "none",
  minLikes: "none", maxLikes: "none",
  minComments: "none", maxComments: "none",
  blockAuthors: [], allowAuthors: [], blockTags: [],
  skipNoTags: false, allowSubs: false,
  toggleKey: "shift+d", likeKey: "shift+g",
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
let saveTimer = 0;

function listToText(a) { return (a || []).join(", "); }
function textToList(s) {
  return String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
}

function fillLengthSelect(el) {
  el.innerHTML = "";
  const opts = [["none", "none"]];
  for (let s = 5; s <= 60; s += 5) opts.push([String(s), s + "s"]);
  for (const [v, t] of opts) {
    const o = document.createElement("option");
    o.value = v; o.textContent = t;
    el.appendChild(o);
  }
}

function readUI() {
  const num = (id, fb) => {
    const v = parseInt($(id).value, 10);
    return Number.isFinite(v) && v >= 0 ? v : fb;
  };
  const txt = (id) => {
    const v = $(id).value.trim().toLowerCase();
    return v === "" || v === "none" ? "none" : v;
  };
  return {
    on: $("on").checked,
    dir: parseInt($("dir").value, 10) === -1 ? -1 : 1,
    plays: Math.min(10, Math.max(1, num("plays", 1))),
    delay: Math.min(30000, num("delay", 0)),
    waitForComments: $("waitForComments").checked,
    minLen: $("minLen").value, maxLen: $("maxLen").value,
    minViews: txt("minViews"), maxViews: txt("maxViews"),
    minLikes: txt("minLikes"), maxLikes: txt("maxLikes"),
    minComments: txt("minComments"), maxComments: txt("maxComments"),
    blockAuthors: textToList($("blockAuthors").value),
    allowAuthors: textToList($("allowAuthors").value),
    blockTags: textToList($("blockTags").value),
    skipNoTags: $("skipNoTags").checked,
    allowSubs: $("allowSubs").checked,
    toggleKey: $("toggleKey").value.trim().toLowerCase() || "shift+d",
    likeKey: $("likeKey").value.trim().toLowerCase() || "shift+g",
  };
}

function paintUI(cfg) {
  $("on").checked = !!cfg.on;
  $("dir").value = cfg.dir === -1 ? "-1" : "1";
  $("plays").value = cfg.plays;
  $("delay").value = cfg.delay;
  $("waitForComments").checked = !!cfg.waitForComments;
  $("minLen").value = cfg.minLen; $("maxLen").value = cfg.maxLen;
  $("minViews").value = cfg.minViews === "none" ? "" : cfg.minViews;
  $("maxViews").value = cfg.maxViews === "none" ? "" : cfg.maxViews;
  $("minLikes").value = cfg.minLikes === "none" ? "" : cfg.minLikes;
  $("maxLikes").value = cfg.maxLikes === "none" ? "" : cfg.maxLikes;
  $("minComments").value = cfg.minComments === "none" ? "" : cfg.minComments;
  $("maxComments").value = cfg.maxComments === "none" ? "" : cfg.maxComments;
  $("blockAuthors").value = listToText(cfg.blockAuthors);
  $("allowAuthors").value = listToText(cfg.allowAuthors);
  $("blockTags").value = listToText(cfg.blockTags);
  $("skipNoTags").checked = !!cfg.skipNoTags;
  $("allowSubs").checked = !!cfg.allowSubs;
  $("toggleKey").value = cfg.toggleKey;
  $("likeKey").value = cfg.likeKey;
}

function save(immediate) {
  clearTimeout(saveTimer);
  const write = () => {
    chrome.storage.local.set({ cfg: readUI() }, () => {
      statusEl.textContent = "Saved ✓";
      setTimeout(() => (statusEl.textContent = ""), 1200);
    });
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 350);
}

fillLengthSelect($("minLen"));
fillLengthSelect($("maxLen"));

chrome.storage.local.get("cfg", (res) => {
  paintUI({ ...DEFAULTS, ...(res && res.cfg) });
  // Persist defaults on first run so content script sees them immediately.
  if (!res || !res.cfg) chrome.storage.local.set({ cfg: { ...DEFAULTS } });
});

document.querySelectorAll("input, select, textarea").forEach((el) => {
  const instant = el.type === "checkbox" || el.tagName === "SELECT" || el.id === "on";
  el.addEventListener(instant ? "change" : "input", () => save(false));
});

// Reflect outside changes (e.g. Shift+D hotkey) while popup is open.
chrome.storage.onChanged.addListener((chg, area) => {
  if (area === "local" && chg.cfg?.newValue) paintUI({ ...DEFAULTS, ...chg.cfg.newValue });
});
