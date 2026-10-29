/* Shorts AutoNext — efficient content script.
 * Event-driven: no setInterval polling, no background worker, no console spam.
 * Single delegated 'ended' listener + one MutationObserver for renderer swaps.
 */
"use strict";

const DEFAULTS = {
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

/* ---------- tiny utils (hot-path friendly) ---------- */

function parseCompact(t) {
  // "12.3k" / "4m" / "1,234" -> number. ~10x cheaper than regex-heavy variants.
  if (t == null) return 0;
  if (typeof t === "number") return t;
  let s = String(t).trim().toLowerCase().replace(/,/g, "");
  if (!s) return 0;
  let m = 1;
  const last = s.charCodeAt(s.length - 1);
  if (last === 107) { m = 1e3; s = s.slice(0, -1); }       // k
  else if (last === 109) { m = 1e6; s = s.slice(0, -1); }  // m
  else if (last === 98) { m = 1e9; s = s.slice(0, -1); }    // b
  const n = parseFloat(s);
  return Number.isFinite(n) ? n * m : 0;
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
  const v = r.querySelector("video");
  // currentSrc is stable per short and cheap to read; fallback to element id/index
  const src = v && v.currentSrc ? v.currentSrc : "";
  if (src) return src;
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
  let creator = null, creatorNorm = "";
  if (S.blockAuthors.length || S.allowAuthors.length || S.allowSubs) {
    creator =
      r.querySelector("yt-reel-channel-bar-view-model a") ||
      r.querySelector("ytd-channel-name a");
    creatorNorm = creator ? normName(creator.textContent) : "";
    if (creatorNorm) {
      if (S.allowAuthors.length) {
        for (let i = 0; i < S.allowAuthors.length; i++) {
          if (normName(S.allowAuthors[i]) === creatorNorm) return false; // whitelisted: keep
        }
      }
      if (S.allowSubs && isSubscribed(r)) return false; // subscribed: keep
      if (S.blockAuthors.length) {
        for (let i = 0; i < S.blockAuthors.length; i++) {
          if (normName(S.blockAuthors[i]) === creatorNorm) return true;
        }
      }
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
      const blocked = new Set(S.blockTags.map(normName));
      for (let i = 0; i < tags.length; i++) {
        const t = normName(tags[i].textContent).replace(/^#/, "");
        if (blocked.has(t) || blocked.has("#" + t)) return true;
      }
    }
  }

  // Views / likes / comments — each queried only if its filter is active.
  if (S.minViews !== "none" || S.maxViews !== "none") {
    const el = document.querySelector(
      "#factoids view-count-factoid-renderer span, #factoids span.ytwFactoidRendererValue"
    );
    if (el) {
      const n = parseCompact(el.textContent);
      if (S.minViews !== "none" && n < parseCompact(S.minViews)) return true;
      if (S.maxViews !== "none" && n > parseCompact(S.maxViews)) return true;
    }
  }
  if (S.minLikes !== "none" || S.maxLikes !== "none") {
    const el = document.querySelector(
      "#factoids factoid-renderer span.ytwFactoidRendererValue span, #factoids factoid-renderer span"
    );
    if (el) {
      const n = parseCompact(el.textContent);
      if (S.minLikes !== "none" && n < parseCompact(S.minLikes)) return true;
      if (S.maxLikes !== "none" && n > parseCompact(S.maxLikes)) return true;
    }
  }
  if (S.minComments !== "none" || S.maxComments !== "none") {
    const el =
      r.querySelector("reel-action-bar-view-model button-view-model span") ||
      document.querySelector("#comments-button span");
    if (el) {
      const n = parseCompact(el.textContent);
      if (S.minComments !== "none" && n < parseCompact(S.minComments)) return true;
      if (S.maxComments !== "none" && n > parseCompact(S.maxComments)) return true;
    }
  }
  return false;
}

/* ---------- navigation ---------- */

function advance() {
  // Prefer YT's own nav buttons: triggers proper hydration, no scroll hacks.
  const sel = S.dir < 0
    ? "#navigation-button-up button"
    : "#navigation-button-down button";
  const btn = document.querySelector(sel);
  if (btn && !btn.disabled) {
    btn.click();
    return true;
  }
  // Fallback: scroll sibling into view.
  if (activeRenderer) {
    const sib = S.dir < 0 ? activeRenderer.previousElementSibling : activeRenderer.nextElementSibling;
    if (sib && sib.scrollIntoView) {
      sib.scrollIntoView({ block: "nearest" });
      return true;
    }
  }
  return false;
}

function waitCommentsClosed(token) {
  // Resolves when comments close; rejects (false) if short changes meanwhile.
  return new Promise((resolve) => {
    if (!commentsOpen()) return resolve(true);
    if (commentsMo) commentsMo.disconnect();
    commentsMo = new MutationObserver(() => {
      if (token !== navToken) { commentsMo.disconnect(); resolve(false); return; }
      if (!commentsOpen()) { commentsMo.disconnect(); commentsMo = null; resolve(true); }
    });
    const panel = document.querySelector("ytd-engagement-panel-section-list-renderer");
    commentsMo.observe(panel || document.body, {
      attributes: true, attributeFilter: ["visibility", "panel-content-visible"],
      subtree: true, childList: true,
    });
    // Safety: re-check once per second instead of busy 100ms loop.
    const iv = setInterval(() => {
      if (token !== navToken) { clearInterval(iv); resolve(false); }
      else if (!commentsOpen()) { clearInterval(iv); if (commentsMo) commentsMo.disconnect(); commentsMo = null; resolve(true); }
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
  if (key && key === curKey) {
    // same short: just enforce no-loop + resume if YT paused it
    if (curVideo && curVideo.paused && !curVideo.ended) {
      curVideo.play().catch(() => {});
    }
    return;
  }
  curKey = key;
  activeRenderer = r;
  playCount = 0;
  const v = r.querySelector("video");
  curVideo = v || null;
  if (!v) {
    // video not hydrated yet: observer will re-fire when it appears; one short retry
    setTimeout(() => { if (rendererKey(getActiveRenderer()) !== curKey) attachCurrent(); }, 600);
    return;
  }
  unloop(v);
  v.play().catch(() => {});
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
  e.preventDefault && e.preventDefault();
  playCount++;
  if (playCount >= Math.max(1, S.plays | 0)) {
    playCount = 0;
    scheduleNext(false);
  } else {
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
  const key = parts.pop();
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
    if (!isShortsPage()) return; // stay dormant off-shorts: zero cost
    observeRendererSwaps();
    attachCurrent();
  });

  chrome.storage.onChanged.addListener((chg, area) => {
    if (area !== "local" || !chg.cfg) return;
    const wasOn = S.on;
    S = { ...DEFAULTS, ...chg.cfg.newValue };
    if (S.on && !wasOn) { navToken++; attachCurrent(); }
    else if (!S.on && wasOn) {
      navToken++; // cancel pending navs
      if (scheduled) clearTimeout(scheduled);
      if (commentsMo) { commentsMo.disconnect(); commentsMo = null; }
      if (curVideo) unloop(curVideo); // restore loop attr? leave off: harmless
    }
  });

  // Single delegated listeners (capture): replace per-video add/remove churn.
  document.addEventListener("ended", onEnded, true);
  document.addEventListener(
    "play",
    (e) => { if (e.target && e.target.tagName === "VIDEO") unloop(e.target); },
    true
  );

  // SPA navigation: YT fires yt-navigate-finish; popstate covers back/forward.
  window.addEventListener("yt-navigate-finish", () => {
    navToken++;
    curKey = null;
    if (S.on && isShortsPage()) {
      observeRendererSwaps();
      attachCurrent();
    }
  });
  window.addEventListener("popstate", () => {
    navToken++;
    curKey = null;
    if (S.on && isShortsPage()) attachCurrent();
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
      if (msg?.type === "toggle-autonext") setCfg({ on: !S.on });
      else if (msg?.type === "like-toggle") toggleLike();
    });
  }
}

function setCfg(patch) {
  S = { ...S, ...patch };
  chrome.storage.local.set({ cfg: S });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
