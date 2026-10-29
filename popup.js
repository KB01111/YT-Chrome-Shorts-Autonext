/* Shorts AutoNext — popup. Single cfg object, one read, debounced writes. */
"use strict";

const DEFAULTS = (typeof SHORTS_AUTONEXT_DEFAULTS !== "undefined")
  ? SHORTS_AUTONEXT_DEFAULTS
  : {
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

function parseCompact(t) {
  // Strict input parser: "12.3k"/"4m"/"1,234" -> number, NaN if not numeric.
  if (t == null) return NaN;
  if (typeof t === "number") return t;
  let s = String(t).trim().toLowerCase().replace(/,/g, "");
  if (!s || s === "none") return NaN;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[kmb]?$/.test(s)) return NaN;
  let m = 1;
  const last = s.charCodeAt(s.length - 1);
  if (last === 107) { m = 1e3; s = s.slice(0, -1); }       // k
  else if (last === 109) { m = 1e6; s = s.slice(0, -1); }  // m
  else if (last === 98) { m = 1e9; s = s.slice(0, -1); }   // b
  const n = Number(s) * m;
  return Number.isFinite(n) ? n : NaN;
}

function isValidCombo(s) {
  return /^(shift\+|ctrl\+|alt\+|meta\+)*([a-z0-9]|f\d{1,2}|arrow(up|down|left|right)|space|enter|escape|tab|[\/\-\=\[\]\\;',\.])$/i.test(String(s || "").trim());
}

function validKey(raw, fb) {
  const v = String(raw || "").trim().toLowerCase();
  if (!v) return fb;
  return isValidCombo(v) ? v : fb;
}

function setStatus(msg, isErr) {
  statusEl.textContent = msg;
  statusEl.style.color = isErr ? "red" : "";
}

function clearMarks() {
  for (const id of ["minLen", "maxLen", "minViews", "maxViews",
                    "minLikes", "maxLikes", "minComments", "maxComments",
                    "toggleKey", "likeKey"]) {
    const el = $(id);
    if (el) el.style.borderColor = "";
  }
}

// Validates min>max pairs and malformed numbers, marks offending fields red.
function validateRanges(cfg) {
  clearMarks();
  const bad = [];
  const invalid = [];
  if (cfg.minLen !== "none" && cfg.maxLen !== "none") {
    const a = parseInt(cfg.minLen, 10), b = parseInt(cfg.maxLen, 10);
    if (Number.isFinite(a) && Number.isFinite(b) && a > b) bad.push(["minLen", "maxLen", "length"]);
  }
  for (const [field, label] of [["minViews", "views"], ["maxViews", "views"],
                                ["minLikes", "likes"], ["maxLikes", "likes"],
                                ["minComments", "comments"], ["maxComments", "comments"]]) {
    if (cfg[field] !== "none" && Number.isNaN(parseCompact(cfg[field]))) {
      $(field).style.borderColor = "red";
      invalid.push([field, label]);
    }
  }
  for (const [lo, hi, label] of [["minViews", "maxViews", "views"],
                                 ["minLikes", "maxLikes", "likes"],
                                 ["minComments", "maxComments", "comments"]]) {
    if (cfg[lo] !== "none" && cfg[hi] !== "none") {
      const a = parseCompact(cfg[lo]), b = parseCompact(cfg[hi]);
      if (Number.isFinite(a) && Number.isFinite(b) && a > b) bad.push([lo, hi, label]);
    }
  }
  for (const [lo, hi] of bad) { $(lo).style.borderColor = "red"; $(hi).style.borderColor = "red"; }
  if (invalid.length) return `Invalid ${invalid[0][1]} number — check filters`;
  if (!bad.length) return "";
  return bad[0][2] === "length"
    ? "Min length > max — check filters"
    : `Min ${bad[0][2]} > max — check filters`;
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
    toggleKey: validKey($("toggleKey").value, DEFAULTS.toggleKey),
    likeKey: validKey($("likeKey").value, DEFAULTS.likeKey),
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
  saveTimer = 0;
  const write = () => {
    saveTimer = 0;
    const cfg = readUI();
    const rangeWarn = validateRanges(cfg);
    // Key validation: fall back to defaults (done in readUI), warn here.
    let keyWarn = "";
    for (const [id] of [["toggleKey"], ["likeKey"]]) {
      const raw = $(id).value.trim();
      if (raw && !isValidCombo(raw)) {
        $(id).style.borderColor = "red";
        keyWarn = "Invalid shortcut, use e.g. shift+d";
      }
      if (/shift\+.*\d/i.test(raw)) {
        $(id).style.borderColor = "red";
        const shiftWarn = "Shift+digit never matches (browser reports !, use another key)";
        keyWarn = keyWarn ? keyWarn + " • " + shiftWarn : shiftWarn;
      }
    }
    const warn = [rangeWarn, keyWarn].filter(Boolean).join(" • ");
    if (rangeWarn) {
      setStatus(warn, true);
      return;
    }
    chrome.storage.local.set({ cfg }, () => {
      if (warn) {
        setStatus(warn, true);
      } else {
        setStatus("Saved ✓", false);
        setTimeout(() => { statusEl.textContent = ""; statusEl.style.color = ""; }, 1200);
      }
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
  // Checkbox/select save immediately (no data loss on fast close);
  // text/number/textarea are debounced to avoid a write per keystroke.
  const instant = el.type === "checkbox" || el.tagName === "SELECT";
  el.addEventListener(instant ? "change" : "input", () => save(instant));
});

// Flush a pending debounced write synchronously on fast close.
window.addEventListener("pagehide", () => {
  if (saveTimer) {
    save(true);
  }
});

$("reset").addEventListener("click", () => {
  clearTimeout(saveTimer);
  saveTimer = 0;
  clearMarks();
  paintUI({ ...DEFAULTS });
  chrome.storage.local.set({ cfg: { ...DEFAULTS } }, () => setStatus("Reset to defaults ✓", false));
});

// Reflect outside changes (e.g. Shift+D hotkey) while popup is open.
// Active-element guard: never clobber the text field the user is editing —
// snapshot the focused text field's value before repaint, restore it after.
chrome.storage.onChanged.addListener((chg, area) => {
  if (area === "local" && chg.cfg?.newValue) {
    const active = document.activeElement;
    const editing = !!active && (active.tagName === "TEXTAREA" ||
      (active.tagName === "INPUT" && active.type !== "checkbox" && active.type !== "radio"));
    const activeId = editing ? active.id : null;
    const savedValue = editing ? active.value : null;
    paintUI({ ...DEFAULTS, ...chg.cfg.newValue });
    if (activeId && savedValue !== null) {
      const el = $(activeId);
      if (el) el.value = savedValue;
    }
  }
});
