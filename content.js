/* Shorts AutoNext — efficient content script.
 * Event-driven: no setInterval polling, no background worker, no console spam.
 * Single delegated 'ended' listener + one MutationObserver for renderer swaps.
 */
"use strict";

const DEFAULTS = (typeof SHORTS_AUTONEXT_DEFAULTS !== "undefined")
  ? SHORTS_AUTONEXT_DEFAULTS
  : {
  on: true,
  dir: 1, // 1 = down/next, -1 = up/prev
  plays: 1, // replays before advancing
  delay: 0, // extra ms before advancing
  waitForComments: true, // if true, hold while comments panel is open
  minLen: "none", // seconds or "none"
  maxLen: "none",
  minViews: "none", // compact number string ("10k") or "none"
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

let S = { ...DEFAULTS };
let curKey = null; // active short identity
let curVideo = null;
let playCount = 0;
let navToken = 0;
let activeRenderer = null;
let mo = null; // renderer-swap observer
let commentsMo = null; // one-shot comments-close observer
let scheduled = 0;
let userPaused = false; // true when the user manually paused the current short
let lastGesture = 0; // timestamp of last user gesture (pointer/key); gates userPaused

/* Cached thresholds/sets: rebuilt via rebuildCache() after boot-load and
 * on every storage change, so shouldSkip() avoids parseCompact()/new Set()
 * work on each check. */
let C = {
  numMinViews: NaN, numMaxViews: NaN,
  numMinLikes: NaN, numMaxLikes: NaN,
  numMinComments: NaN, numMaxComments: NaN,
  blockTagsNorm: new Set(),
  blockAuthorsNorm: new Set(),
  allowAuthorsNorm: new Set(),
};

function rebuildCache() {
  C.numMinViews = S.minViews !== "none" ? parseCompact(S.minViews) : NaN;
  C.numMaxViews = S.maxViews !== "none" ? parseCompact(S.maxViews) : NaN;
  C.numMinLikes = S.minLikes !== "none" ? parseCompact(S.minLikes) : NaN;
  C.numMaxLikes = S.maxLikes !== "none" ? parseCompact(S.maxLikes) : NaN;
  C.numMinComments = S.minComments !== "none" ? parseCompact(S.minComments) : NaN;
  C.numMaxComments = S.maxComments !== "none" ? parseCompact(S.maxComments) : NaN;
  C.blockTagsNorm = new Set((S.blockTags || []).map(normName));
  C.blockAuthorsNorm = new Set((S.blockAuthors || []).map(normName));
  C.allowAuthorsNorm = new Set((S.allowAuthors || []).map(normName));
}

/* ---------- tiny utils (hot-path friendly) ---------- */

function parseCompact(t) {
  // "12.3k" / "4m" / "1,234" -> number. ~10x cheaper than regex-heavy variants.
  // Strict: invalid formats ("12x", "5oops") yield NaN (fail-open in shouldSkip);
  // only null/undefined/empty yield 0. Same strictness as popup.js.
  if (t == null) return 0;
  if (typeof t === "number") return t;
  let s = String(t).trim().toLowerCase().replace(/,/g, "");
  if (!s) return 0;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?[kmb]?$/.test(s)) return NaN;
  let m = 1;
  const last = s.charCodeAt(s.length - 1);
  if (last === 107) { m = 1e3; s = s.slice(0, -1); }       // k
  else if (last === 109) { m = 1e6; s = s.slice(0, -1); }  // m
  else if (last === 98) { m = 1e9; s = s.slice(0, -1); }    // b
  const n = Number(s) * m;
  return Number.isFinite(n) ? n : NaN;
}

function normName(t) {
  return String(t || "").trim().toLowerCase().replace(/^@/, "");
}

function isShortsPage() {
  // cheap string checks first; only touch DOM on likely-shorts URLs
  const p = location.pathname;
  return p === "/shorts" || p.indexOf("/shorts/") === 0;
}

/* ---------- element lookups (scoped, minimal) ---------- */

function getActiveRenderer() {
  // Fast path: YT marks exactly one renderer is-active.
  return (
    document.querySelector("ytd-reel-video-renderer[is-active]") ||
    document.querySelector(".reel-video-in-sequence[is-active]") ||
    document.querySelector("ytd-reel-video-renderer") ||
    null
  );
}

function rendererKey(r) {
  if (!r) return null;
  // Keep identity local: pathname can change before the active renderer does.
  const videoId = r.getAttribute("video-id");
  if (videoId) return "video:" + videoId;
  const v = r.querySelector("video");
  const src = v && v.currentSrc ? v.currentSrc : "";
  if (src) return "src:" + src;
  // Last resort: renderer index among siblings; null if that is unavailable.
  if (r.parentNode && r.parentNode.children) {
    const sibs = r.parentNode.children;
    for (let i = 0; i < sibs.length; i++) {
      if (sibs[i] === r) return "idx:" + i;
    }
  }
  return r.id ? "id:" + r.id : null;
}

function commentsOpen() {
  const panel = document.querySelector(
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-comments-section"]'
  );
  if (!panel) return false;
  if (panel.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED")
    return true;
  // secondary: in-view comments title (mobile-ish layouts)
  const t = document.querySelector("#comments #title-text, #title-text[title='Comments']");
  if (t) {
    const r = t.getBoundingClientRect();
    if (r.top < innerHeight && r.bottom > 0 && r.width > 0) return true;
  }
  return false;
}

function isAd(r) {
  // scoped to renderer: avoids full-document scan
  return !!r.querySelector("ad-badge-view-model");
}

function isSubscribed(r) {
  // Only queried when allowSubs is enabled (caller gates this).
  const b = r.querySelector(
    "yt-subscribe-button-view-model button, yt-reel-channel-bar-view-model button"
  );
  if (!b) return false;
  const t = (b.innerText || b.getAttribute("aria-label") || "").toLowerCase();
  return t.indexOf("subscribed") !== -1;
}

/* ---------- filter check: reads DOM only for enabled filters ---------- */

function filtersEnabled() {
  return (
    S.minLen !== "none" || S.maxLen !== "none" ||
    S.minViews !== "none" || S.maxViews !== "none" ||
    S.minLikes !== "none" || S.maxLikes !== "none" ||
    S.minComments !== "none" || S.maxComments !== "none" ||
    S.blockAuthors.length > 0 || S.allowAuthors.length > 0 ||
    S.blockTags.length > 0 || S.skipNoTags || S.allowSubs
  );
}

function shouldSkip(r, video) {
  // Returns true if this short must be skipped. Cheap early-outs first.
  if (isAd(r)) return true;
  if (!filtersEnabled()) return false;

  // Creator (needed by allow/block/subs logic) — single query.
  // NOTE: allowAuthors/allowSubs bypass ONLY the blockAuthors check below;
  // length/views/likes/tags filters still apply to allowed/subscribed shorts.
  let authorAllowed = false;
  if (S.blockAuthors.length || S.allowAuthors.length || S.allowSubs) {
    const creator =
      r.querySelector("yt-reel-channel-bar-view-model a") ||
      r.querySelector("ytd-channel-name a");
    const creatorNorm = creator ? normName(creator.textContent) : "";
    if (creatorNorm) {
      if (C.allowAuthorsNorm.has(creatorNorm)) authorAllowed = true;
      else if (S.allowSubs && isSubscribed(r)) authorAllowed = true;
      if (!authorAllowed && C.blockAuthorsNorm.has(creatorNorm)) return true;
    }
  }

  // Length — no DOM query at all.
  if (video && video.duration && Number.isFinite(video.duration)) {
    const d = video.duration;
    if (S.minLen !== "none" && d < +S.minLen) return true;
    if (S.maxLen !== "none" && d > +S.maxLen) return true;
  }

  // Tags — only when block/skip-no-tags is configured.
  if (S.blockTags.length || S.skipNoTags) {
    const tags = r.querySelectorAll("#title a[href*='hashtag'], #title a");
    if (tags.length === 0) {
      if (S.skipNoTags) return true;
    } else if (S.blockTags.length) {
      for (let i = 0; i < tags.length; i++) {
        const t = normName(tags[i].textContent).replace(/^#/, "");
        if (C.blockTagsNorm.has(t) || C.blockTagsNorm.has("#" + t)) return true;
      }
    }
  }

  // Views / likes / comments — strictly scoped to the active renderer.
  // Sibling-renderer factoids must never be used: fail-open (no filter applies
  // for a metric the renderer lacks) instead of filtering on a sibling's count.
  if (S.minViews !== "none" || S.maxViews !== "none") {
    const el = r.querySelector(
      "#factoids view-count-factoid-renderer span, #factoids span.ytwFactoidRendererValue"
    );
    if (el) {
      const n = parseCompact(el.textContent);
      if (!Number.isNaN(C.numMinViews) && n < C.numMinViews) return true;
      if (!Number.isNaN(C.numMaxViews) && n > C.numMaxViews) return true;
    }
  }
  if (S.minLikes !== "none" || S.maxLikes !== "none") {
    const el = r.querySelector(
      "#factoids factoid-renderer span.ytwFactoidRendererValue span, #factoids factoid-renderer span"
    );
    if (el) {
      const n = parseCompact(el.textContent);
      if (!Number.isNaN(C.numMinLikes) && n < C.numMinLikes) return true;
      if (!Number.isNaN(C.numMaxLikes) && n > C.numMaxLikes) return true;
    }
  }
  if (S.minComments !== "none" || S.maxComments !== "none") {
    let el = r.querySelector("reel-action-bar-view-model button-view-model span");
    if (!el) {
      const fb = document.querySelector("#comments-button span");
      // Sibling factoids must never be used: accept the document fallback
      // only when it lives inside this renderer; otherwise ignore (fail-open).
      if (fb && r.contains(fb)) el = fb;
    }
    if (el) {
      const n = parseCompact(el.textContent);
      if (!Number.isNaN(C.numMinComments) && n < C.numMinComments) return true;
      if (!Number.isNaN(C.numMaxComments) && n > C.numMaxComments) return true;
    }
  }
  return false;
}

/* ---------- navigation ---------- */

function advance() {
  // (a) Prefer YT's own nav buttons: triggers proper hydration, no scroll hacks.
  const sel = S.dir < 0
    ? "#navigation-button-up button"
    : "#navigation-button-down button";
  const btn = document.querySelector(sel);
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  // (b) Fallback: scroll sibling into view.
  if (activeRenderer) {
    const sib = S.dir < 0 ? activeRenderer.previousElementSibling : activeRenderer.nextElementSibling;
    if (sib && sib.scrollIntoView) {
      try {
        sib.scrollIntoView({ block: "nearest" });
        return true;
      } catch (_) {}
    }
  }
  // (c) Last resort: dispatch ArrowDown/ArrowUp so YT's own key handler moves.
  try {
    const before = getActiveRenderer();
    const beforeKey = rendererKey(before);
    const key = S.dir < 0 ? "ArrowUp" : "ArrowDown";
    document.dispatchEvent(new KeyboardEvent("keydown", { key: key, bubbles: true, cancelable: true }));
    const after = getActiveRenderer();
    return !!after && (after !== before || rendererKey(after) !== beforeKey);
  } catch (_) {}
  return false;
}

function waitCommentsClosed(token) {
  // Resolves when comments close; rejects (false) if short changes meanwhile.
  return new Promise((resolve) => {
    if (!commentsOpen()) return resolve(true);
    if (commentsMo) { commentsMo.disconnect(); commentsMo = null; }
    let iv = 0;
    commentsMo = new MutationObserver(() => {
      if (token !== navToken) {
        if (iv) clearInterval(iv);
        if (commentsMo === myMo) { commentsMo.disconnect(); commentsMo = null; }
        resolve(false);
        return;
      }
      if (!commentsOpen()) {
        if (iv) clearInterval(iv);
        if (commentsMo === myMo) { commentsMo.disconnect(); commentsMo = null; }
        resolve(true);
      }
    });
    const myMo = commentsMo;
    const panel = document.querySelector("ytd-engagement-panel-section-list-renderer");
    commentsMo.observe(panel || document.body, {
      attributes: true, attributeFilter: ["visibility", "panel-content-visible"],
      subtree: true, childList: true,
    });
    // Safety: re-check once per second instead of busy 100ms loop.
    iv = setInterval(() => {
      if (token !== navToken) {
        clearInterval(iv);
        if (commentsMo === myMo) { commentsMo.disconnect(); commentsMo = null; }
        resolve(false);
      }
      else if (!commentsOpen()) {
        clearInterval(iv);
        if (commentsMo === myMo) { commentsMo.disconnect(); commentsMo = null; }
        resolve(true);
      }
    }, 1000);
  });
}

async function scheduleNext(immediateSkip) {
  if (!S.on || !isShortsPage()) return;
  const token = ++navToken;
  if (scheduled) clearTimeout(scheduled);

  const go = () => {
    if (token !== navToken) return;
    if (advance()) {
      // active renderer swap is picked up by MutationObserver; nudge in case attrs lag
      queueMicrotask(attachCurrent);
    }
  };

  // Filter-skips ignore the extra delay; natural ends respect it.
  const delay = immediateSkip ? 150 : (S.delay || 0);

  if (!immediateSkip && S.waitForComments && commentsOpen()) {
    const stillSame = await waitCommentsClosed(token);
    if (!stillSame || token !== navToken) return;
  }
  if (token !== navToken) return;
  if (delay > 0) scheduled = setTimeout(go, delay);
  else go();
}

/* ---------- attach / lifecycle (event-driven, no polling) ---------- */

function unloop(v) {
  if (!v) return;
  try {
    v.loop = false;
    if (v.hasAttribute("loop")) v.removeAttribute("loop");
  } catch (_) {}
}

function attachCurrent() {
  if (!S.on || !isShortsPage()) return;
  const r = getActiveRenderer();
  if (!r) return;
  const key = rendererKey(r);
  const v = r.querySelector("video");
  if (key && key === curKey && r === activeRenderer && v === curVideo) {
    // same short: just enforce no-loop + resume if YT paused it
    unloop(v);
    if (curVideo && curVideo.paused && !curVideo.ended && !userPaused) {
      curVideo.play().catch(() => {});
    }
    return;
  }
  curKey = key;
  userPaused = false; // new short: clear any manual-pause state
  activeRenderer = r;
  playCount = 0;
  curVideo = v || null;
  if (!v) {
    // video not hydrated yet: observer will re-fire when it appears; one short retry
    setTimeout(() => { if (rendererKey(getActiveRenderer()) !== curKey) attachCurrent(); }, 600);
    return;
  }
  unloop(v);
  if (!userPaused) v.play().catch(() => {});
  // Skip disallowed shorts shortly after metadata hydrates (bounded, not 15x500ms).
  if (filtersEnabled()) {
    let tries = 0;
    const check = () => {
      if (rendererKey(getActiveRenderer()) !== curKey) return; // user moved on
      if (shouldSkip(r, v)) { scheduleNext(true); return; }
      // metadata may hydrate late: retry only while creator/views still empty
      if (++tries < 3) {
        const c = r.querySelector("yt-reel-channel-bar-view-model a");
        if (!c || !c.textContent.trim()) setTimeout(check, 400);
      }
    };
    setTimeout(check, 350);
  } else if (isAd(r)) {
    scheduleNext(true);
  }
}

function onEnded(e) {
  const v = e.target;
  if (!v || v.tagName !== "VIDEO") return;
  if (!S.on || !isShortsPage()) return;
  // Ignore videos outside the active renderer (preloads, hidden players).
  const r = v.closest ? v.closest("ytd-reel-video-renderer, .reel-video-in-sequence") : null;
  if (!r || (activeRenderer && r !== activeRenderer)) {
    const ar = getActiveRenderer();
    if (r !== ar) return;
    activeRenderer = ar;
  }
  // NOTE: "ended" is not cancelable, so no preventDefault() here.
  playCount++;
  if (playCount >= Math.max(1, S.plays | 0)) {
    playCount = 0;
    scheduleNext(false);
  } else {
    userPaused = false; // ended is not a manual pause: allow replay
    v.play().catch(() => {});
  }
}

function observeRendererSwaps() {
  if (mo) mo.disconnect();
  // Watch only the shorts container for attribute changes (is-active flips),
  // not the whole document: minimal observer cost.
  const root =
    document.querySelector("#shorts-container") ||
    document.querySelector("ytd-shorts") ||
    document.body;
  let queued = false;
  mo = new MutationObserver((muts) => {
    if (!S.on || queued) return;
    for (let i = 0; i < muts.length; i++) {
      const m = muts[i];
      if (m.type === "attributes" && m.attributeName === "is-active") {
        queued = true;
        queueMicrotask(() => { queued = false; attachCurrent(); });
        return;
      }
      if (m.type === "childList" && m.addedNodes.length) {
        for (let j = 0; j < m.addedNodes.length; j++) {
          const n = m.addedNodes[j];
          if (n.nodeType === 1 && (n.tagName === "VIDEO" || (n.querySelector && n.querySelector("video")))) {
            queued = true;
            queueMicrotask(() => { queued = false; attachCurrent(); });
            return;
          }
        }
      }
    }
  });
  mo.observe(root, {
    attributes: true, attributeFilter: ["is-active"],
    childList: true, subtree: true,
  });
}

function matchKey(e, combo) {
  // combo like "shift+d": exact modifier match, no per-keypress debounce/timeout.
  if (!combo) return false;
  const parts = combo.toLowerCase().split("+");
  const name = parts.pop();
  const key = name === "space" ? " " : name;
  if ((e.key || "").toLowerCase() !== key) return false;
  const want = { shift: false, ctrl: false, alt: false, meta: false };
  for (const p of parts) if (p in want) want[p] = true;
  return (
    !!e.shiftKey === want.shift &&
    !!e.ctrlKey === want.ctrl &&
    !!e.altKey === want.alt &&
    !!e.metaKey === want.meta
  );
}

function toggleLike() {
  const r = activeRenderer || getActiveRenderer();
  if (!r) return;
  const like =
    r.querySelector("like-button-view-model button[aria-pressed='false']") ||
    r.querySelector("like-button-view-model button");
  if (like) like.click();
}

/* ---------- boot ---------- */

function boot() {
  chrome.storage.local.get("cfg", (res) => {
    if (res && res.cfg) S = { ...DEFAULTS, ...res.cfg };
    rebuildCache();
    if (!isShortsPage()) return; // stay dormant off-shorts: zero cost
    observeRendererSwaps();
    attachCurrent();
  });

  chrome.storage.onChanged.addListener((chg, area) => {
    if (area !== "local" || !chg.cfg) return;
    const wasOn = S.on;
    S = { ...DEFAULTS, ...chg.cfg.newValue };
    rebuildCache();
    if (S.on && !wasOn) { navToken++; attachCurrent(); }
    else if (!S.on && wasOn) {
      navToken++; // cancel pending navs
      if (scheduled) { clearTimeout(scheduled); scheduled = 0; }
      if (commentsMo) { commentsMo.disconnect(); commentsMo = null; }
      if (curVideo) {
        try { curVideo.loop = true; } catch (_) {}
      }
    }
  });

  // Single delegated listeners (capture): replace per-video add/remove churn.
  document.addEventListener("ended", onEnded, true);
  document.addEventListener(
    "play",
    (e) => { if (S.on && e.target && e.target.tagName === "VIDEO") unloop(e.target); },
    true
  );
  // Fresh user gestures gate userPaused: ignores programmatic pauses.
  document.addEventListener("pointerdown", () => { lastGesture = Date.now(); }, true);
  document.addEventListener("keydown", () => { lastGesture = Date.now(); }, true);
  // Respect explicit user pauses: do not autoplay over them.
  document.addEventListener(
    "pause",
    (e) => {
      if (e.target === curVideo && !e.target.ended && (Date.now() - lastGesture < 5000)) {
        userPaused = true;
      }
    },
    true
  );

  // SPA navigation: YT fires yt-navigate-finish; popstate covers back/forward.
  // Abort pending navs early on navigate-start.
  window.addEventListener("yt-navigate-start", () => {
    navToken++;
    if (scheduled) { clearTimeout(scheduled); scheduled = 0; }
  });
  window.addEventListener("yt-navigate-finish", () => {
    navToken++;
    if (scheduled) { clearTimeout(scheduled); scheduled = 0; }
    curKey = null;
    if (S.on && isShortsPage()) {
      observeRendererSwaps();
      attachCurrent();
    } else if (!isShortsPage()) {
      if (mo) { mo.disconnect(); mo = null; }
    }
  });
  window.addEventListener("popstate", () => {
    navToken++;
    if (scheduled) { clearTimeout(scheduled); scheduled = 0; }
    curKey = null;
    if (S.on && isShortsPage()) attachCurrent();
    else if (!isShortsPage()) {
      if (mo) { mo.disconnect(); mo = null; }
    }
  });

  // In-page shortcuts (commands API handles it when focus is outside page).
  document.addEventListener("keydown", (e) => {
    if (!e.key || e.repeat) return;
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (matchKey(e, S.toggleKey)) {
      e.preventDefault();
      setCfg({ on: !S.on });
    } else if (matchKey(e, S.likeKey)) {
      e.preventDefault();
      toggleLike();
    }
  });

  // Toggle/like commands from chrome://extensions keyboard shortcuts
  // (relayed by background.js). In-page keydown below covers the focused-page case.
  if (chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!isShortsPage()) return;
      if (msg?.type === "toggle-autonext") setCfg({ on: !S.on });
      else if (msg?.type === "like-toggle") toggleLike();
    });
  }
}

function setCfg(patch) {
  S = { ...S, ...patch };
  rebuildCache();
  chrome.storage.local.set({ cfg: S });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
