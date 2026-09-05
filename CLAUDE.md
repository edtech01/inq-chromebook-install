# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

**Production deployment is GitHub Pages** (`edtech01.github.io/inq-chromebook-install`), installed as a PWA directly on the operator's ChromeOS Chromebook — no server involved at all, just the static files in this repo. `serve.py` below is a **Windows-only local dev/testing convenience**, not part of that deployment; don't assume it's present when reasoning about production behavior (see "Setup file" under Architecture for where this distinction actually matters).

For local dev on Windows: static HTML/JS/CSS, no build step, but served by a small custom script (`serve.py`) rather than plain `python -m http.server` — it also exposes `GET /api/setup-file` so the app can auto-load `InquisitorSetup.txt` from the operator's Documents folder (see below). Serve from the project root with:

```bash
python serve.py 3334
```

Then open `http://localhost:3334` in Chrome, or just run `Run-Inquisitor.bat`, which does both. The preview server config is in `.claude/launch.json` (server name: `inquisitor-app`), also pointed at `serve.py`.

WebHID requires Chrome 89+ and a secure context (localhost or HTTPS). It will not work in Firefox, Safari, or file:// URLs.

**Cache-busting:** Both `<link>` and `<script>` tags in `index.html` use `?v=N` query strings. Bump N whenever `app.js` or `style.css` changes so Chrome picks up the new version.

**Service worker cache:** `sw.js` precaches `./index.html`, `./app.js`, and `./style.css` under the bare (query-less) URL, keyed by the `CACHE` constant at the top of the file. Since the SW file itself is what the browser diffs to decide whether to reinstall, editing `index.html`/`app.js`/`style.css` without also bumping `CACHE` in `sw.js` leaves the old service worker in place — it will keep serving the **stale cached `index.html`** (old menu markup and all) no matter how many times the `?v=N` query strings are bumped, since the browser never even re-fetches index.html from disk. **Always bump `CACHE` in `sw.js` alongside any change to those three files.**

Two more layers had to be fixed for that bump to actually reach the browser, both now handled — don't reintroduce either:
- **Chrome only rechecks `sw.js` for changes at most once per 24 hours** during a routine page load. `app.js`'s registration call chains `reg.update()` after `register()` specifically to bypass that throttle — without it, a correctly-bumped `CACHE` can sit unnoticed for up to a day even with everything else right.
- **`serve.py` sends `Cache-Control: no-store, must-revalidate` for `/`, `/index.html`, and `/sw.js`.** Without it, a static file server's default (heuristic) caching can let the browser reuse a stale HTTP-cached copy of `sw.js` itself, so the update check never even sees the new bytes on disk. Don't move back to plain `python -m http.server` for real usage — it lacks both this and the `/api/setup-file` endpoint below.
- **`serve.py`'s `Server` class must not set `allow_reuse_address = True`.** On Windows that maps to `SO_REUSEADDR`, which lets a *second, separate process* bind and listen on a port a first process is already listening on — the OS then routes each incoming request to whichever of the two processes it feels like, so some requests hit old code and some hit new with no way to tell which from the browser side. `Run-Inquisitor.bat` checks `netstat` for an existing listener on the port before starting a new server for this same reason — don't remove that check, and don't launch a second `serve.py` manually while one is already running; close its console window first.

## Architecture

Single-page app with no framework or bundler. All four screens live in `index.html` as sibling `<div class="screen">` elements; only the one with class `active` is visible. `showScreen(id)` in `app.js` handles all transitions.

| File | Role |
|---|---|
| `index.html` | Shell: four screen divs (`#splash`, `#menu`, `#scoreboard`, `#stats`) |
| `app.js` | All logic — HID lifecycle, timers, scoring, stats, screen transitions, audio, speech |
| `style.css` | Dark theme; `.screen.active { display: flex }` drives screen visibility |
| `InquisitorSplash1.jpg` | Background image for the splash screen |
| `ringin.wav` / `ringout.wav` | Buzz-in sound effects for Team One / Team Two |
| `Windows XP Hardware Fail.wav` | Timer-expiry sound effect |

### Global state (`app.js`)

A single `state` object holds everything: `hidDevice`, `modelNumber`, `splashShown`, `teams[2]` (name + up to 5 players each), `scores[2]`, `config` (matchTimer, tossupTimer, bonusTimer, scoreIncrement), all timer state (`matchSeconds`, `matchInterval`, `matchRunning`, `responseSeconds`, `responseInterval`, `responseExpired`, `timeoutInterval`, `anyTimerExpired`), `buzzLocked`, `inBonus`, `inIntro`, plus:

- `keepStats` / `stats` — "Keep Match Stats" toggle and the `{ teams: [], players: [] }` stat accumulators
- `currentBuzz`, `tossupTimerStarted`, `tossupStartTime`, `bonusEligibleTeam`, `bonusActiveTeam`, `bonusPointAwarded` — per-buzz-cycle bookkeeping that ties a score-box click back to the right stat
- `voiceSpotter` — "Voice Spotter" toggle (announces buzz-ins via speech synthesis)
- `buzzerCheckActive` / `buzzerCheckMatchWasRunning` — Buzzer Check mode and whether to resume the match timer on exit

`playersPerTeam()` returns 4 for Model 2012 and 4097, 5 for all others (including Model 712 and Model 512).

### HID protocol

- **VID:** `0x19A1` — filter used in both `requestDevice` (manual connect) and `getDevices` (auto-reconnect on load)
- **Input report — 4 bytes:** `[0]`/`[2]` = reserved, `[3]` (`byte4`) = player/team ID on every model; `[1]` (`byte2`) is reserved on Model 712/2012/4097 but carries players 1-2 on Model 512 (see below)
- **`handleHIDReport` must build the byte array from `event.data.byteOffset`/`byteLength`**, not just `event.data.buffer` — Chrome strips the report-ID byte from `event.data` for numbered reports, and using the raw `.buffer` (ignoring the `DataView`'s own offset) silently shifts every index by one on devices that use a numbered report
- **Model number = PID** (`device.productId`), read at connect time and stored in `state.modelNumber` — not from the data bytes
- **Idle value:** byte 4 = `255` means no button pressed. Model 512 additionally requires byte 2's bits 6-7 to both read `1` (see `isIdleReport`) — a player 1/2 buzz leaves byte 4 at `255`, so byte 4 alone isn't sufficient to detect idle on that model
- **Output:** two separate `sendReport(0, Uint8Array)` calls via `sendHIDCommand()` — `resetBuzzers()` sends `124` then `125`, which causes the HID to immediately return to sending `255`
- **`buzzLocked`:** set `true` on first non-255/non-idle report to gate repeat reports of the same buzz; cleared by `resetBuzzers()`

### Splash / connect flow

`openDevice(device)` is the single shared helper that opens an already VID-matched device, stores it on `state`, and wires up `handleHIDReport`. Both connect paths funnel through it:

- **Auto-connect on load** — `initSplash()` calls `navigator.hid.getDevices()`; if a previously-granted device matches `HID_VID`, it calls `openDevice(dev)` directly, no button press required.
- **Manual connect** — `btn-connect` triggers `connectHID()`, which calls `navigator.hid.requestDevice()` (needs a user gesture) and then `openDevice()` on the result.

Message text is chosen by *why* the connection didn't happen:
- `showNotFound()` — "Inquisitor not found…" — only shown when no device with the matching VID exists (empty `getDevices()` match or empty `requestDevice()` picker result).
- `showConnectionError(err)` — "Inquisitor found but could not connect…" — shown when the VID *was* found but `device.open()` (or `requestDevice()`) threw.

### Decoding byte 4 (+ byte 2 for Model 512) → player (`decodeByte4`)

- **Model 712:** byte 4 value is the 1-based player number; `1–5` → Team One (`playerIdx = byte4 - 1`); `6–10` → Team Two (`playerIdx = byte4 - 6`).
- **Model 2012 / 4097:** XOR byte4 with 255; if multiple bits set, randomly keep one; bit position maps to player number via `BIT_TO_PLAYER = [1,2,3,4,5,6,8,7]` (bits 6 and 7 are swapped on the physical device — bit 6 → player 8, bit 7 → player 7); players 1–4 → Team One, players 5–8 → Team Two.
- **Model 512** (10-player device, mapping measured directly from hardware — do not assume it follows the 2012 pattern): checked in this order —
  1. XOR byte 2 with 192 and check bits 6-7: bit 6 → player 1, bit 7 → player 2 (if both set, randomly keep one). Either always resolves to Team One (`playerIdx = playerNum - 1`) and, if set, takes priority over byte 4 for that report.
  2. Otherwise, XOR byte 4 with 255; if multiple bits set, randomly keep one; bit position maps to player number via `BIT_TO_PLAYER_512 = [3,4,5,10,9,8,6,7]` — note this ordering is *not* the same as Model 2012's `BIT_TO_PLAYER`. Players 1–5 → Team One, players 6–10 → Team Two.
  - The two bytes are not pooled into a single random draw — a simultaneous press across byte 2 and byte 4 always resolves in byte 2's favor. Considered acceptable since that requires two different players buzzing in the same ~ms.

### Timer behaviour

- **RESPONSE TIMER** (left-click = tossup duration, right-click = bonus duration): counts down in whole seconds, displays 2 digits (`00`–`99`). Sets `state.anyTimerExpired = true` and plays the expiry sound on expiry.
- **MATCH TIMER** (left-click = start, right-click = `callTimeout()`: stop + start 60 s timeout): displays MM:SS. Resumes from `state.matchSeconds` after a timeout ends.
- `startResponseTimer`, `startMatchTimer`, and `callTimeout` all no-op while `state.buzzerCheckActive` is true.

### Audio

`playSound(src, onEnded)` plays a wav file via a plain `<audio>` element and optionally fires `onEnded` when playback finishes; used for `ringin.wav`/`ringout.wav` on a decoded buzz and `Windows XP Hardware Fail.wav` on timer expiry. `playBuzzTone()` (a synthesized Web Audio tone) is defined but currently unused — the wav-based `playSound` is what actually fires.

### Voice Spotter

Menu → Options → "Voice Spotter" checkbox (`opt-voice-spotter`) sets `state.voiceSpotter`. On a decoded buzz, `handleScoreboardBuzz` passes `announceBuzz(teamName, playerName)` as the `onEnded` callback to `playSound`, so the speech (`SpeechSynthesisUtterance` reading "`<team>, <player>`") happens right after the buzz-in sound finishes, not before. No-ops if the checkbox is off or `speechSynthesis` isn't available.

### Casting the display to a TV

**There is no in-app "Cast" button — use Chrome/ChromeOS's own native casting instead**, e.g. right-clicking the installed app's icon on the shelf, or ChromeOS Quick Settings → Cast. That does real screen mirroring (live pixels, whatever is currently on screen) with zero app code.

A web page **cannot** trigger that same native tab-mirroring UI itself — it's deliberately locked out for privacy reasons (otherwise any site could silently screen-share a visitor). An in-app "Cast to TV" button was tried using the W3C Presentation API (`PresentationRequest`), but that API does something different: it opens a **second, independent instance of the app's URL** on the receiver device rather than mirroring the live tab — so the TV just showed a fresh copy of the app stuck on the splash screen, never reflecting the operator's actual live state. That approach was reverted. Building genuine live mirroring via Presentation API would require app.js to push state updates (screen transitions, scores, buzzes, timers) over the API's message channel to a receiver-side copy of the app — a real second implementation of "what renders," not a small tweak — and hasn't been built.

### Score boxes

Left-click increments, right-click decrements by `state.config.scoreIncrement`. Score cannot go below 0. Scores are **preserved** across menu visits — `initScoreboard()` does not reset them. `adjustScore()` also attributes tossup/bonus points to `state.stats` via `state.currentBuzz` / `state.bonusActiveTeam`.

### Stats screen

Menu → Options → "Keep Match Stats" checkbox (`opt-keep-stats`) sets `state.keepStats`, enables the menu's `btn-stats` button, and (see below) reveals the scoreboard's Buzzer Check button. `renderStats()` builds the Team Stats and Individual Stats tables from `state.stats` on demand when `btn-stats` is clicked.

### Buzzer Check

Scoreboard footer button, `toggleBuzzerCheck()`, only visible when `state.keepStats` is true (`updateBuzzerCheckVisibility()`, called from the `opt-keep-stats` change handler and from `initScoreboard()`). Lets operators test buzzers after a substitution without polluting stats or the match clock:

- **Press "Buzzer Check"** — pauses the match timer (remembering if it was running) and any response timer, blocks new timer starts and `recordBuzzStats`, clears blocking flags (`anyTimerExpired`/`inBonus`/`inIntro`/`buzzLocked`) so test buzzes still display names normally. Button label becomes "Resume Match".
- **Press "Resume Match"** — clears the name label, re-enables stats/timers, restarts the match timer only if it had been running before the check began.
- If `state.keepStats` gets unchecked while a check is in progress, `updateBuzzerCheckVisibility()` auto-resumes the match before hiding the button.

### Menu → Scoreboard data flow

`saveMenuValues()` reads all input fields into `state`. `initScoreboard()` reads from `state` to populate the scoreboard and re-attaches all event listeners using direct property assignment (`onclick`, `oncontextmenu`) so repeated CONTINUE presses safely overwrite rather than stack listeners.

### Setup file (File menu + auto-load)

**The real production deployment is a Chromebook (ChromeOS) with the app installed as a PWA straight from GitHub Pages — there is no server behind it at all.** GitHub Pages is 100% static hosting: it cannot run `serve.py`, has no `/api/setup-file` route, and has no concept of "the operator's Documents folder". Don't assume `serve.py` is present when reasoning about that deployment; it's a Windows-only local dev/testing convenience (see "Running the app"), not part of the production path.

`applySetupText(text)` parses the `key=value` setup format (team/player names, match config, and the current options) and applies it to `state`; it's the shared parser behind every path below. `buildSetupText()` is the inverse — serializes current `state` back into that same format.

- **Save Setup File / Open Setup File** (File menu) — `saveSetupFile()` / `openSetupFile()` use `showSaveFilePicker()` / `showOpenFilePicker()` (File System Access API), defaulting to the Documents folder and the filename `InquisitorSetup.txt`. These always need a real user click — that's a browser requirement, not a bug. Works identically on GitHub Pages and everywhere else, since it's pure client-side browser API.
- **Local-storage autosave/auto-load — the mechanism that actually matters on a Chromebook.** `saveSetupToLocalStorage()` writes `buildSetupText()` to `localStorage['inquisitorSetup']` on every commit point (`saveMenuValues()` — i.e. every CONTINUE press — plus Open Setup File and Restore Factory Defaults). `tryAutoLoadSetupFile()` reads it back synchronously on `DOMContentLoaded` and applies it via `applySetupText()`. This is what makes an installed-from-GitHub-Pages Chromebook remember its own settings across restarts with zero server involved — local to that one browser profile/device, doesn't sync anywhere.
- **`GET /api/setup-file` (serve.py only)** — `tryAutoLoadSetupFile()` also tries this *after* local storage, and applies it on top if it succeeds. Exists only for the Windows `serve.py`/`Run-Inquisitor.bat` dev flow, reading `InquisitorSetup.txt` straight from the operator's OS Documents folder over plain HTTP (no browser permission needed). On GitHub Pages (or any static host) this fetch simply fails/404s and is a silent no-op — local storage's value stands. When both a server file and a local-storage entry exist, the server value wins (it's the more deliberately-managed source in that dev scenario).
  - **`serve.py`'s `documents_folder()` must not hardcode `home() / 'Documents'`** — OneDrive's "Known Folder Move" (common on managed/school machines) redirects the real Documents folder to somewhere like `...\OneDrive\Documents` by changing the registry, not by moving/symlinking the default path, so that guess silently points at the wrong (often nonexistent-content) folder. It calls `SHGetFolderPathW` (CSIDL_PERSONAL) via `ctypes` instead, which returns the actual redirected path Windows and the browser's own file pickers agree on. If this dev-only path ever "just doesn't work" again, check this first — compare `serve.py`'s resolved path (printed in the console it runs in) against `[Environment]::GetFolderPath('MyDocuments')` in PowerShell.

## Known limitations / pending work

- Tab bar dropdown's Display Settings item is a placeholder — content TBD after testing.
- Local-storage-based setup persistence is per-device/per-browser-profile — it does not sync across multiple Chromebooks or survive a browser profile reset/powerwash. If multi-device sync is ever needed, that requires actual shared/cloud storage, not `serve.py` (which isn't reachable from a GitHub-Pages-hosted Chromebook anyway).
