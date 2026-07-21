# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Running the app

No build step — pure static HTML/JS/CSS. Serve from the project root with Python:

```bash
python -m http.server 3334
```

Then open `http://localhost:3334` in Chrome. The preview server config is in `.claude/launch.json` (server name: `inquisitor-app`).

WebHID requires Chrome 89+ and a secure context (localhost or HTTPS). It will not work in Firefox, Safari, or file:// URLs.

**Cache-busting:** Both `<link>` and `<script>` tags in `index.html` use `?v=N` query strings. Bump N whenever `app.js` or `style.css` changes so Chrome picks up the new version.

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

`playersPerTeam()` returns 4 for Model 2012 and 4097, 5 for all others (including Model 712).

### HID protocol

- **VID:** `0x19A1` — filter used in both `requestDevice` (manual connect) and `getDevices` (auto-reconnect on load)
- **Input report — 4 bytes:** `[0]`/`[1]`/`[2]` = reserved, `[3]` = player/team ID
- **Model number = PID** (`device.productId`), read at connect time and stored in `state.modelNumber` — not from the data bytes
- **Idle value:** byte 4 = `255` means no button pressed — player label is cleared, nothing else happens
- **Output:** two separate `sendReport(0, Uint8Array)` calls via `sendHIDCommand()` — `resetBuzzers()` sends `124` then `125`, which causes the HID to immediately return to sending `255`
- **`buzzLocked`:** set `true` on first non-255 report to gate repeat reports of the same buzz; cleared by `resetBuzzers()`

### Splash / connect flow

`openDevice(device)` is the single shared helper that opens an already VID-matched device, stores it on `state`, and wires up `handleHIDReport`. Both connect paths funnel through it:

- **Auto-connect on load** — `initSplash()` calls `navigator.hid.getDevices()`; if a previously-granted device matches `HID_VID`, it calls `openDevice(dev)` directly, no button press required.
- **Manual connect** — `btn-connect` triggers `connectHID()`, which calls `navigator.hid.requestDevice()` (needs a user gesture) and then `openDevice()` on the result.

Message text is chosen by *why* the connection didn't happen:
- `showNotFound()` — "Inquisitor not found…" — only shown when no device with the matching VID exists (empty `getDevices()` match or empty `requestDevice()` picker result).
- `showConnectionError(err)` — "Inquisitor found but could not connect…" — shown when the VID *was* found but `device.open()` (or `requestDevice()`) threw.

### Decoding byte 4 → player (`decodeByte4`)

- **Model 712:** byte 4 value is the 1-based player number; `1–5` → Team One (`playerIdx = byte4 - 1`); `6–10` → Team Two (`playerIdx = byte4 - 6`).
- **Model 2012 / 4097:** XOR byte4 with 255; if multiple bits set, randomly keep one; bit position maps to player number via `BIT_TO_PLAYER = [1,2,3,4,5,6,8,7]` (bits 6 and 7 are swapped on the physical device — bit 6 → player 8, bit 7 → player 7); players 1–4 → Team One, players 5–8 → Team Two.

### Timer behaviour

- **RESPONSE TIMER** (left-click = tossup duration, right-click = bonus duration): counts down in whole seconds, displays 2 digits (`00`–`99`). Sets `state.anyTimerExpired = true` and plays the expiry sound on expiry.
- **MATCH TIMER** (left-click = start, right-click = `callTimeout()`: stop + start 60 s timeout): displays MM:SS. Resumes from `state.matchSeconds` after a timeout ends.
- `startResponseTimer`, `startMatchTimer`, and `callTimeout` all no-op while `state.buzzerCheckActive` is true.

### Audio

`playSound(src, onEnded)` plays a wav file via a plain `<audio>` element and optionally fires `onEnded` when playback finishes; used for `ringin.wav`/`ringout.wav` on a decoded buzz and `Windows XP Hardware Fail.wav` on timer expiry. `playBuzzTone()` (a synthesized Web Audio tone) is defined but currently unused — the wav-based `playSound` is what actually fires.

### Voice Spotter

Menu → Options → "Voice Spotter" checkbox (`opt-voice-spotter`) sets `state.voiceSpotter`. On a decoded buzz, `handleScoreboardBuzz` passes `announceBuzz(teamName, playerName)` as the `onEnded` callback to `playSound`, so the speech (`SpeechSynthesisUtterance` reading "`<team>, <player>`") happens right after the buzz-in sound finishes, not before. No-ops if the checkbox is off or `speechSynthesis` isn't available.

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

## Known limitations / pending work

- Tab bar dropdowns' Display Settings / Sound Settings items are placeholders — content TBD after testing.
