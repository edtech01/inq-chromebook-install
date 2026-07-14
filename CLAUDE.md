# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step — pure static HTML/JS/CSS. Serve from the project root with Python:

```bash
python -m http.server 3334
```

Then open `http://localhost:3334` in Chrome. The preview server config is in `.claude/launch.json` (server name: `inquisitor-app`).

WebHID requires Chrome 89+ and a secure context (localhost or HTTPS). It will not work in Firefox, Safari, or file:// URLs.

## Architecture

Single-page app with no framework or bundler. All three screens live in `index.html` as sibling `<div class="screen">` elements; only the one with class `active` is visible. `showScreen(id)` in `app.js` handles all transitions.

| File | Role |
|---|---|
| `index.html` | Shell: three screen divs (`#splash`, `#menu`, `#scoreboard`) |
| `app.js` | All logic — HID lifecycle, timers, scoring, screen transitions, audio |
| `style.css` | Dark theme; `.screen.active { display: flex }` drives screen visibility |
| `InquisitorSplash1.jpg` | Background image for the splash screen |

### Global state (`app.js`)

A single `state` object holds everything: `hidDevice`, `modelNumber`, `splashShown`, `teams[2]` (name + up to 5 players each), `scores[2]`, `config` (matchTimer, tossupTimer, bonusTimer, scoreIncrement), all timer state (`matchSeconds`, `matchInterval`, `matchRunning`, `responseSeconds`, `responseInterval`, `responseExpired`, `timeoutInterval`, `anyTimerExpired`), and `buzzLocked`.

`playersPerTeam()` returns 4 for Model 2012, 5 for all others (including Model 712).

### HID protocol

- **VID:** `0x19A1` — filter used in both `requestDevice` (manual connect) and `getDevices` (auto-reconnect on load)
- **Input report — 4 bytes:** `[0]`/`[1]`/`[2]` = reserved, `[3]` = player/team ID
- **Model number = PID** (`device.productId`), read at connect time and stored in `state.modelNumber` — not from the data bytes
- **Idle value:** byte 4 = `255` means no button pressed — player label is cleared, nothing else happens
- **Output:** two separate `sendReport(0, Uint8Array)` calls via `sendHIDCommand()` — `resetBuzzers()` sends `124` then `125`, which causes the HID to immediately return to sending `255`
- **`buzzLocked`:** set `true` on first non-255 report to gate repeat reports of the same buzz; cleared by `resetBuzzers()`

### Decoding byte 4 → player (`decodeByte4`)

- **Model 712:** byte 4 value is the 1-based player number; `1–5` → Team One (`playerIdx = byte4 - 1`); `6–10` → Team Two (`playerIdx = byte4 - 6`).
- **Model 2012:** XOR byte4 with 255; if multiple bits set, randomly keep one; bit 0 → player 1, bit 1 → player 2, …; players 1–4 → Team One, players 5–8 → Team Two.

### Timer behaviour

- **RESPONSE TIMER** (left-click = tossup duration, right-click = bonus duration): counts down in whole seconds, displays 2 digits (`00`–`99`). Plays `playDingTone()` and sets `state.anyTimerExpired = true` on expiry.
- **MATCH TIMER** (left-click = start, right-click = stop + start 60 s timeout): displays MM:SS. Resumes from `state.matchSeconds` after a timeout ends.

### Audio

Both tones use the Web Audio API (no audio files). `playBuzzTone()` — square wave at 160 Hz, 0.5 s — fires when a valid buzz is decoded. `playDingTone()` — sine wave sweeping 880→660 Hz, 0.8 s — fires when the response timer expires. Both create and close their own `AudioContext`.

### Score boxes

Left-click increments, right-click decrements by `state.config.scoreIncrement`. Score cannot go below 0. Scores are **preserved** across menu visits — `initScoreboard()` does not reset them.

### Menu → Scoreboard data flow

`saveMenuValues()` reads all input fields into `state`. `initScoreboard()` reads from `state` to populate the scoreboard and re-attaches all event listeners using direct property assignment (`onclick`, `oncontextmenu`) so repeated CONTINUE presses safely overwrite rather than stack listeners.

## Known limitations / pending work

- Tab bar dropdowns (File / Options / Info) have placeholder menu items — content TBD after testing.
