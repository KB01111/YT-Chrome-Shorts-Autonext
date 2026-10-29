# Shorts AutoNext — Efficient

Clones the features of [Auto Youtube Shorts Scroller](https://chromewebstore.google.com/detail/auto-youtube-shorts-scrol/ckbnikemebopgknkpgjlkbffpkkhblbe)
(auto-advance when a Short ends, filters, block/allow lists, delays, shortcuts),
rebuilt for minimal CPU / memory overhead.

## Why it's efficient

| Original | This version |
|---|---|
| `setInterval(checkForNewShort, 500ms)` polling forever, even off Shorts | Zero polling. One `MutationObserver` on `#shorts-container` + delegated `ended` listener |
| Per-video `addEventListener/removeEventListener` churn | Single document-level `ended`/`play` listeners (capture) |
| Busy-wait `while (commentsOpen) sleep(100)` | One-shot `MutationObserver` + 1s safety re-check |
| 15 retries × 500ms metadata wait per Short | Max 3 × 400ms, only when filters are enabled |
| Full-document `querySelectorAll` scans, `console.log` on every Short | Scoped queries inside active renderer, only for enabled filters; no logging |
| Always-on background page logic + `tabs` permission | Event-only service worker (command relay); `storage` permission only |

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a `youtube.com/shorts` video. It auto-advances when the video ends.

## Features

- Auto-advance on `ended` (loop attribute stripped, no infinite loops)
- Replays per Short, Up/Down direction, extra delay
- Hold while comments panel is open (optional)
- Filters: length, views, likes, comments (k/m/b suffixes), blocked tags,
  skip-no-tags, blocked/always-allow creators, always-allow subscriptions, ad skip
- Shortcuts: `Shift+D` toggle (default), `Shift+G` like; remappable in popup and
  `chrome://extensions/shortcuts`
- Single `cfg` object in `chrome.storage.local` — one read at startup, live updates

## Files

- `manifest.json` — MV3, `storage` permission only
- `config.js` — shared `SHORTS_AUTONEXT_DEFAULTS` (single source of truth)
- `content.js` — event-driven core (no build step)
- `popup.html` / `popup.js` — settings UI
- `background.js` — keyboard-command relay, sleeps otherwise
- `icons/` — extension icons

## Shared defaults (`config.js`)

Single source of truth: `var SHORTS_AUTONEXT_DEFAULTS = {...}` in `config.js`.
`content.js` / `popup.js` keep their inline `DEFAULTS` as fallback and should
prefer the shared object when present:

```js
const DEFAULTS = (typeof SHORTS_AUTONEXT_DEFAULTS !== "undefined")
  ? SHORTS_AUTONEXT_DEFAULTS
  : { /* inline fallback */ };
```

Inclusion order matters (plain `var`, no modules):

- `manifest.json` content_scripts already loads `["config.js", "content.js"]` —
  `config.js` first.
- `popup.html` is owned separately and was intentionally not touched here.
  Its owner should add, **before** `popup.js`:

```html
<script src="config.js"></script>
<script src="popup.js"></script>
```
