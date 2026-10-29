/* Shorts AutoNext — shared defaults (single source of truth).
 *
 * How to include:
 * - content_scripts (manifest.json): "js": ["config.js", "content.js"]
 *   config.js MUST come BEFORE content.js. Both share the same isolated
 *   world, so `var SHORTS_AUTONEXT_DEFAULTS` below is visible to content.js.
 * - popup.html (owned by another agent — do NOT edit it here):
 *   <script src="config.js"></script>
 *   <script src="popup.js"></script>
 *   config.js MUST load BEFORE popup.js.
 * - background.js (service worker): cannot share content-script globals.
 *   Either duplicate these values or `importScripts("config.js")` and use
 *   `SHORTS_AUTONEXT_DEFAULTS` with fallback (see background.js onInstalled).
 *
 * How content.js / popup.js should consume this (future-proof fallback,
 * keeps working even if config.js is not loaded):
 *   const DEFAULTS = (typeof SHORTS_AUTONEXT_DEFAULTS !== "undefined")
 *     ? SHORTS_AUTONEXT_DEFAULTS
 *     : { ...inline fallback... };
 *
 * NOTE: plain `var` (not `const`/`let`, no module export) on purpose:
 * content_scripts run without `type: "module"`, so module exports would fail.
 * Keep this file dependency-free and side-effect-free (defines one global only).
 */
"use strict";

var SHORTS_AUTONEXT_DEFAULTS = {
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
  likeKey: "shift+g"
};
