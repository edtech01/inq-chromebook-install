if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

// Hardcoded factory defaults — used by Restore Default Setup. Kept separate from
// `state` so restoring can't be corrupted by whatever the live state has drifted to.
const DEFAULT_TEAMS = [
  { name: 'Team One', players: ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5'] },
  { name: 'Team Two', players: ['Player 6', 'Player 7', 'Player 8', 'Player 9', 'Player 10'] }
];
const DEFAULT_CONFIG = { matchTimer: '15:00', tossupTimer: 5, bonusTimer: 10, scoreIncrement: 1 };

// ── State ──────────────────────────────────────────────────────────────────
const state = {
  hidDevice: null,
  modelNumber: null,
  splashShown: false,
  teams: [
    { name: 'Team One', players: ['Player 1', 'Player 2', 'Player 3', 'Player 4', 'Player 5'] },
    { name: 'Team Two', players: ['Player 6', 'Player 7', 'Player 8', 'Player 9', 'Player 10'] }
  ],
  scores: [0, 0],
  config: {
    matchTimer: '15:00',
    tossupTimer: 5,
    bonusTimer: 10,
    scoreIncrement: 1
  },
  scoreboardMode: 'classic', // 'classic' (2-team) or 'cutthroat' (individual leaderboard)
  ctScores: [],              // Cut Throat per-player scores; index 0..count-1 = Team One, count..2count-1 = Team Two
  ctBuzzedPlayerIdx: null,    // ctScores index of the player currently shown in the Cut Throat buzz box
  matchSeconds: 0,
  matchInterval: null,
  matchRunning: false,
  responseInterval: null,
  responseSeconds: 0,
  responseExpired: false,
  timeoutInterval: null,
  anyTimerExpired: false,
  buzzLocked: false,  // true while a buzz is displayed; gates repeat HID reports

  keepStats: false,
  voiceSpotter: false,
  stats: { teams: [], players: [] },
  currentBuzz: null,          // { teamIdx, playerIdx, pointAwarded } for the buzz currently on screen
  tossupTimerStarted: false,  // true once the tossup timer has been started for the current buzz cycle
  tossupStartTime: null,      // Date.now() when the tossup timer was last started
  bonusEligibleTeam: null,    // team idx allowed to attempt a bonus next
  bonusActiveTeam: null,      // team idx currently in a bonus attempt
  bonusPointAwarded: false,   // single-count gate for the active bonus attempt
  inBonus: false,             // true while the bonus timer is set; blocks buzz-ins, shows "Bonus"
  inIntro: false,             // true from scoreboard entry until the name label is cleared; blocks buzz-ins, shows "INQUISITOR"

  buzzerCheckActive: false,        // true while operators are test-buzzing after a substitution; suspends stats + timers
  buzzerCheckMatchWasRunning: false // whether the match timer was running when Buzzer Check was pressed, so Resume Match can restart it
};

// ── Helpers ────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}

function parseMMSS(str) {
  const parts = str.split(':');
  if (parts.length === 2) return parseInt(parts[0]) * 60 + parseInt(parts[1]);
  return parseInt(str) || 0;
}

function formatMMSS(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── HID ───────────────────────────────────────────────────────────────────
const HID_VID = 0x19A1;

// Opens an already-VID-matched device and wires it up.
async function openDevice(device) {
  try {
    await device.open();
  } catch (err) {
    showConnectFailed();
    return;
  }
  state.hidDevice = device;
  state.modelNumber = device.productId;
  state.splashShown = false;
  device.addEventListener('inputreport', handleHIDReport);
  await resetBuzzers(); // nudge the device into streaming so the firmware check runs immediately, without waiting on a spontaneous report
  $('splash-vid-pid').textContent =
    `VID: 0x${device.vendorId.toString(16).toUpperCase().padStart(4,'0')}  ` +
    `PID: 0x${device.productId.toString(16).toUpperCase().padStart(4,'0')}`;
  $('splash-status').textContent = 'Reading device…';
  $('btn-connect').style.display = 'none';
  $('btn-exit').style.display = 'none';
}

async function connectHID() {
  let devices;
  try {
    devices = await navigator.hid.requestDevice({ filters: [{ vendorId: HID_VID }] });
  } catch (err) {
    showConnectFailed();
    return;
  }
  if (!devices || devices.length === 0) { showConnectFailed(); return; }
  await openDevice(devices[0]);
}

function handleHIDReport(event) {
  const data = new Uint8Array(event.data.buffer);
  // Bytes 0-2 reserved. Byte 3 = player/team ID (255 = idle).
  // Model number (PID) stored in state.modelNumber at connect time.
  const byte4 = data[3];

  // Splash: on the first report, gate the MENU button on a firmware check —
  // the 3rd data byte (data[2]) must read 111 or the interface's firmware is too old.
  if (!state.splashShown) {
    state.splashShown = true;
    if (data[2] === 111) {
      $('splash-status').textContent =
        `Inquisitor Model ${state.modelNumber} is connected and working.`;
      $('btn-menu').style.display = 'inline-block';
    } else {
      $('splash-status').textContent = 'Firmware update required.';
      showFirmwareWarning();
    }
  }

  // Route to whichever board is on screen; both share the same idle/lock rules.
  if ($('scoreboard').classList.contains('active')) {
    handleBoardReport(byte4, 'raw-byte-display', 'buzz-player-label', handleScoreboardBuzz);
  } else if ($('cutthroat').classList.contains('active')) {
    handleBoardReport(byte4, 'ct-raw-byte-display', 'ct-buzz-player-label', handleCTBuzz);
  }
}

// Shared idle/lock handling for both scoreboard screens — always show the raw byte,
// decode a buzz if nothing is currently blocking it, otherwise show why buzzing is blocked.
function handleBoardReport(byte4, rawDisplayId, playerLabelId, onBuzz) {
  $(rawDisplayId).textContent = `Byte 4: ${byte4}`;

  if (byte4 === 255) {
    if (!state.anyTimerExpired) state.buzzLocked = false;
    if (state.inTimeout) {
      $(playerLabelId).textContent = 'Time Out';
    } else if (state.inBonus) {
      $(playerLabelId).textContent = 'Bonus';
    } else if (state.inIntro) {
      $(playerLabelId).textContent = 'INQUISITOR';
    } else {
      $(playerLabelId).textContent = state.anyTimerExpired ? 'TIME EXPIRED' : '';
    }
    return;
  }
  if (state.buzzLocked || state.anyTimerExpired || state.inBonus || state.inIntro) {
    // A held/stale press during a blocked state must still lock out further
    // reports — otherwise the same non-255 report re-fires as a fresh buzz
    // the instant the block (INQUISITOR/Bonus label) is cleared.
    state.buzzLocked = true;
    return;
  }

  state.buzzLocked = true;
  onBuzz(byte4);
}

// Default splash invitation — shown before any connect attempt has actually been made
// (e.g. no previously-paired device found on load). Not an error, so no "not found" wording.
function showConnectPrompt() {
  $('splash-vid-pid').textContent = '';
  $('splash-status').textContent =
    'Please connect your Inquisitor to any available USB port and click the CONNECT button or press EXIT.';
  $('btn-connect').style.display = 'inline-block';
  $('btn-exit').style.display = 'inline-block';
  $('btn-menu').style.display = 'none';
}

// A real connect attempt failed — VID matched but couldn't open, or the picker/requestDevice
// call itself came back empty. Gives the operator concrete troubleshooting steps.
function showConnectFailed() {
  $('splash-vid-pid').textContent = '';
  $('splash-status').innerHTML =
    'INQUISITOR NOT FOUND. Make sure your Inquisitor is connected to a USB port and then click CONNECT. ' +
    'Check USB cable. If unit still fails to connect, go to ' +
    '<a href="https://www.inquisitor.us/tech-suport/" target="_blank" rel="noopener noreferrer">' +
    'https://www.inquisitor.us/tech-suport/</a> and submit service request.';
  $('btn-connect').style.display = 'inline-block';
  $('btn-exit').style.display = 'inline-block';
  $('btn-menu').style.display = 'none';
}

// Device connected but its firmware doesn't report data[2] === 111 — too old for this software.
function showFirmwareWarning() {
  $('splash-msgbox-text').innerHTML =
    'Firmware in the Inquisitor USB interface must be updated to use this software. ' +
    'Once firmware is updated you can use either the Chrome or Windows version of the Inquisitor software. ' +
    'Go to <a href="https://www.inquisitor.us/tech-suport/" target="_blank" rel="noopener noreferrer">' +
    'https://www.inquisitor.us/tech-suport/</a> for additional information.';
  $('splash-msgbox').style.display = 'flex';
}

// Send a single-byte command to the HID device
async function sendHIDCommand(value) {
  if (!state.hidDevice || !state.hidDevice.opened) return;
  const report = new Uint8Array(1);
  report[0] = value;
  try {
    await state.hidDevice.sendReport(0, report);
  } catch (e) {
    console.warn('HID send error', e);
  }
}

// Send reset sequence (124 then 125) — HID immediately returns to sending 255
async function resetBuzzers() {
  await sendHIDCommand(124);
  await sendHIDCommand(125);
  // With a real device, keep buzzLocked=true until the HID confirms reset
  // by sending 255 (handled in handleHIDReport). Without a device, unlock now.
  if (!state.hidDevice || !state.hidDevice.opened) {
    state.buzzLocked = false;
  }
}

// ── SPLASH ─────────────────────────────────────────────────────────────────
function initSplash() {
  $('btn-connect').addEventListener('click', connectHID);
  $('btn-exit').addEventListener('click', () => window.close());
  $('btn-menu').addEventListener('click', () => {
    populateMenu();
    showScreen('menu');
  });
  $('btn-splash-msgbox-dismiss').addEventListener('click', () => {
    $('splash-msgbox').style.display = 'none';
    $('btn-exit').style.display = 'inline-block';
  });

  // Auto-connect on load once the VID is confirmed among previously-granted devices
  navigator.hid.getDevices().then(devices => {
    console.log('[Inquisitor] getDevices() on load:', devices.map(d =>
      `vendorId=0x${d.vendorId.toString(16)} productId=0x${d.productId.toString(16)} opened=${d.opened}`
    ));
    const dev = devices.find(d => d.vendorId === HID_VID);
    if (dev) {
      openDevice(dev);
    } else {
      showConnectPrompt();
    }
  }).catch(showConnectPrompt);
}

// ── MENU ───────────────────────────────────────────────────────────────────
function playersPerTeam() {
  if (state.modelNumber === 2012 || state.modelNumber === 4097) return 4;
  return 5; // model 712 and default
}

function populateMenu() {
  const count = playersPerTeam();
  const show5 = count === 5;
  $('t1-p5-row').style.display = show5 ? '' : 'none';
  $('t2-p5-row').style.display = show5 ? '' : 'none';

  $('t1-name').value = state.teams[0].name;
  for (let i = 0; i < count; i++) $(`t1-p${i+1}`).value = state.teams[0].players[i];
  $('t2-name').value = state.teams[1].name;
  for (let i = 0; i < count; i++) {
    const stored = state.teams[1].players[i];
    // Team Two's stored defaults are numbered for the 5-per-team model (Player 6-10).
    // On a 4-per-team model (2012/4097) the device's own numbering is Player 5-8,
    // so re-derive any still-untouched "Player N" default for the current model.
    $(`t2-p${i+1}`).value = /^Player \d+$/.test(stored) ? `Player ${i + count + 1}` : stored;
  }

  $('cfg-match').value  = state.config.matchTimer;
  $('cfg-tossup').value = state.config.tossupTimer;
  $('cfg-bonus').value  = state.config.bonusTimer;
  $('cfg-score').value  = state.config.scoreIncrement;

  $('opt-keep-stats').checked = state.keepStats;
  $('btn-stats').disabled = !state.keepStats;
  $('opt-voice-spotter').checked = state.voiceSpotter;
  $('opt-mode-classic').checked = state.scoreboardMode !== 'cutthroat';
  $('opt-mode-cutthroat').checked = state.scoreboardMode === 'cutthroat';
  updateBuzzerCheckVisibility();
  updateOptionsSummary();
}

// Keeps the read-only "Current Options" summary in sync with the live settings.
function updateOptionsSummary() {
  $('summary-keep-stats').textContent = state.keepStats ? 'On' : 'Off';
  $('summary-voice-spotter').textContent = state.voiceSpotter ? 'On' : 'Off';
  $('summary-scoreboard-type').textContent =
    state.scoreboardMode === 'cutthroat' ? 'Cut Throat (Individual)' : 'Classic (2 Team)';
}

function saveMenuValues() {
  const count = playersPerTeam();

  state.teams[0].name = $('t1-name').value || 'Team One';
  for (let i = 0; i < count; i++)
    state.teams[0].players[i] = $(`t1-p${i+1}`).value || `Player ${i+1}`;
  state.teams[0].players.length = count;

  state.teams[1].name = $('t2-name').value || 'Team Two';
  for (let i = 0; i < count; i++)
    state.teams[1].players[i] = $(`t2-p${i+1}`).value || `Player ${i+count+1}`;
  state.teams[1].players.length = count;

  state.config.matchTimer     = $('cfg-match').value  || '15:00';
  state.config.tossupTimer    = parseInt($('cfg-tossup').value) || 5;
  state.config.bonusTimer     = parseInt($('cfg-bonus').value)  || 10;
  state.config.scoreIncrement = parseInt($('cfg-score').value)  || 1;
}

// File menu: Save/Open/Restore Setup — persists everything on the menu page
// (team/player names, match config, and the current options) as key=value lines.
async function saveSetupFile() {
  saveMenuValues(); // make sure state reflects whatever is currently typed in the fields
  const count = playersPerTeam();
  const lines = [];
  lines.push(`teamOneName=${state.teams[0].name}`);
  for (let i = 0; i < count; i++) lines.push(`teamOnePlayer${i + 1}=${state.teams[0].players[i]}`);
  lines.push(`teamTwoName=${state.teams[1].name}`);
  for (let i = 0; i < count; i++) lines.push(`teamTwoPlayer${i + 1}=${state.teams[1].players[i]}`);
  lines.push(`matchTimer=${state.config.matchTimer}`);
  lines.push(`tossupTimer=${state.config.tossupTimer}`);
  lines.push(`bonusTimer=${state.config.bonusTimer}`);
  lines.push(`scoreIncrement=${state.config.scoreIncrement}`);
  lines.push(`keepStats=${state.keepStats}`);
  lines.push(`voiceSpotter=${state.voiceSpotter}`);
  lines.push(`scoreboardMode=${state.scoreboardMode}`);

  try {
    const handle = await window.showSaveFilePicker({
      startIn: 'documents',
      suggestedName: 'InquisitorSetup.txt',
      types: [{ description: 'Text File', accept: { 'text/plain': ['.txt'] } }]
    });
    const writable = await handle.createWritable();
    await writable.write(lines.join('\n'));
    await writable.close();
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Save Setup File failed:', err);
  }
}

async function openSetupFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      startIn: 'documents',
      types: [{ description: 'Text File', accept: { 'text/plain': ['.txt'] } }]
    });
    const file = await handle.getFile();
    const text = await file.text();

    const values = {};
    text.split('\n').forEach(line => {
      const idx = line.indexOf('=');
      if (idx === -1) return;
      values[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    });

    const count = playersPerTeam();
    if (values.teamOneName !== undefined) state.teams[0].name = values.teamOneName;
    for (let i = 0; i < count; i++) {
      const v = values[`teamOnePlayer${i + 1}`];
      if (v !== undefined) state.teams[0].players[i] = v;
    }
    if (values.teamTwoName !== undefined) state.teams[1].name = values.teamTwoName;
    for (let i = 0; i < count; i++) {
      const v = values[`teamTwoPlayer${i + 1}`];
      if (v !== undefined) state.teams[1].players[i] = v;
    }

    if (values.matchTimer !== undefined) state.config.matchTimer = values.matchTimer;
    if (values.tossupTimer !== undefined) state.config.tossupTimer = parseInt(values.tossupTimer) || state.config.tossupTimer;
    if (values.bonusTimer !== undefined) state.config.bonusTimer = parseInt(values.bonusTimer) || state.config.bonusTimer;
    if (values.scoreIncrement !== undefined) state.config.scoreIncrement = parseInt(values.scoreIncrement) || state.config.scoreIncrement;
    if (values.keepStats !== undefined) state.keepStats = values.keepStats === 'true';
    if (values.voiceSpotter !== undefined) state.voiceSpotter = values.voiceSpotter === 'true';
    if (values.scoreboardMode !== undefined) state.scoreboardMode = values.scoreboardMode === 'cutthroat' ? 'cutthroat' : 'classic';

    populateMenu();
  } catch (err) {
    if (err.name !== 'AbortError') console.warn('Open Setup File failed:', err);
  }
}

function restoreDefaultSetup() {
  state.teams = [
    { name: DEFAULT_TEAMS[0].name, players: [...DEFAULT_TEAMS[0].players] },
    { name: DEFAULT_TEAMS[1].name, players: [...DEFAULT_TEAMS[1].players] }
  ];
  state.config = { ...DEFAULT_CONFIG };
  state.keepStats = false;
  state.voiceSpotter = false;
  state.scoreboardMode = 'classic';
  populateMenu();
}

function initMenu() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      e.stopPropagation();
      const dd = tab.querySelector('.tab-dropdown');
      const wasOpen = dd.classList.contains('open');
      document.querySelectorAll('.tab-dropdown').forEach(d => d.classList.remove('open'));
      if (!wasOpen) dd.classList.add('open');
    });
  });
  document.addEventListener('click', () => {
    document.querySelectorAll('.tab-dropdown').forEach(d => d.classList.remove('open'));
  });

  $('menu-file-exit').addEventListener('click', (e) => {
    e.preventDefault();
    window.close();
  });

  $('menu-file-save-setup').addEventListener('click', (e) => {
    e.preventDefault();
    saveSetupFile();
  });

  $('menu-file-open-setup').addEventListener('click', (e) => {
    e.preventDefault();
    openSetupFile();
  });

  $('menu-file-restore-setup').addEventListener('click', (e) => {
    e.preventDefault();
    restoreDefaultSetup();
  });

  document.querySelectorAll('#menu-body input[type="text"]').forEach(input => {
    input.addEventListener('focus', () => { input.value = ''; });
  });

  $('btn-continue').addEventListener('click', async () => {
    saveMenuValues();
    if (state.scoreboardMode === 'cutthroat') {
      initCutthroat();
      showScreen('cutthroat');
    } else {
      initScoreboard();
      showScreen('scoreboard');
    }
    await resetBuzzers(); // clear the HID report buffer on entering the scoreboard
  });

  $('opt-keep-stats').addEventListener('change', (e) => {
    state.keepStats = e.target.checked;
    $('btn-stats').disabled = !state.keepStats;
    updateBuzzerCheckVisibility();
    updateOptionsSummary();
  });

  $('opt-voice-spotter').addEventListener('change', (e) => {
    state.voiceSpotter = e.target.checked;
    updateOptionsSummary();
  });

  $('opt-mode-classic').addEventListener('change', (e) => {
    if (e.target.checked) { state.scoreboardMode = 'classic'; updateOptionsSummary(); }
  });

  $('opt-mode-cutthroat').addEventListener('change', (e) => {
    if (e.target.checked) { state.scoreboardMode = 'cutthroat'; updateOptionsSummary(); }
  });

  $('btn-stats').addEventListener('click', () => {
    renderStats();
    showScreen('stats');
  });

  $('btn-stats-back').addEventListener('click', () => {
    showScreen('menu');
  });
}

// ── AUDIO ──────────────────────────────────────────────────────────────────

function playSound(src, onEnded) {
  try {
    const audio = new Audio(src);
    if (onEnded) audio.addEventListener('ended', onEnded);
    audio.play().catch(e => {
      console.warn('Audio not available:', e);
      if (onEnded) onEnded();
    });
  } catch (e) {
    console.warn('Audio not available:', e);
    if (onEnded) onEnded();
  }
}

// Voice Spotter: speaks "<team>, <player>" (or just "<player>" if there's no team,
// as on the Cut Throat board) once the buzz-in sound effect finishes
function announceBuzz(teamName, playerName) {
  if (!state.voiceSpotter) return;
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel(); // drop any queued announcement from a prior buzz
  const utterance = new SpeechSynthesisUtterance(teamName ? `${teamName}, ${playerName}` : playerName);
  window.speechSynthesis.speak(utterance);
}

function playBuzzTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gainNode   = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(160, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.6, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.5);
    oscillator.onended = () => ctx.close();
  } catch (e) {
    console.warn('Audio not available:', e);
  }
}

// ── SCOREBOARD ─────────────────────────────────────────────────────────────

// Decode byte 4 → { teamIdx, playerIdx } using device PID as the model number
function decodeByte4(byte4, modelNumber) {
  if (modelNumber === 712) {
    // Byte 4 is the 1-based player number
    // 1–5  → Team One,  playerIdx = byte4 - 1
    // 6–10 → Team Two,  playerIdx = byte4 - 6
    if (byte4 >= 1 && byte4 <= 5)  return { teamIdx: 0, playerIdx: byte4 - 1 };
    if (byte4 >= 6 && byte4 <= 10) return { teamIdx: 1, playerIdx: byte4 - 6 };
    return null;
  }
  if (modelNumber === 2012 || modelNumber === 4097) {
    // XOR with 255, isolate one bit randomly if multiple set, then map bit position to
    // player number via BIT_TO_PLAYER. Bits 6 and 7 are swapped on the physical device:
    // bit 6 = player 8, bit 7 = player 7.
    let val = byte4 ^ 255;
    if (val === 0) return null;
    const setBits = [];
    for (let bit = 0; bit < 8; bit++) { if (val & (1 << bit)) setBits.push(bit); }
    let bit = setBits.length > 1 ? setBits[Math.floor(Math.random() * setBits.length)] : setBits[0];
    const BIT_TO_PLAYER = [1, 2, 3, 4, 5, 6, 8, 7];
    const playerNum = BIT_TO_PLAYER[bit];
    if (playerNum >= 1 && playerNum <= 4) return { teamIdx: 0, playerIdx: playerNum - 1 };
    if (playerNum >= 5 && playerNum <= 8) return { teamIdx: 1, playerIdx: playerNum - 5 };
    return null;
  }
  return null;
}

function handleScoreboardBuzz(byte4) {
  clearInterval(state.responseInterval);
  const decoded = decodeByte4(byte4, state.modelNumber);
  if (decoded) {
    const teamName   = state.teams[decoded.teamIdx].name;
    const playerName = state.teams[decoded.teamIdx].players[decoded.playerIdx];
    playSound(decoded.teamIdx === 0 ? 'ringin.wav' : 'ringout.wav', () => announceBuzz(teamName, playerName));
    $('buzz-team-label').textContent   = teamName;
    $('buzz-player-label').textContent = playerName;
    recordBuzzStats(decoded.teamIdx, decoded.playerIdx);
    highlightTeam(decoded.teamIdx);
  } else {
    $('buzz-team-label').textContent   = '';
    $('buzz-player-label').textContent = `ID: ${byte4}`;
  }
}

// ── CUT THROAT ─────────────────────────────────────────────────────────────

// Maps a decoded {teamIdx, playerIdx} onto a single ctScores index:
// 0..count-1 = Team One, count..2count-1 = Team Two.
function ctIndexFor(teamIdx, playerIdx) {
  return teamIdx === 0 ? playerIdx : playersPerTeam() + playerIdx;
}

function handleCTBuzz(byte4) {
  clearInterval(state.responseInterval);
  const decoded = decodeByte4(byte4, state.modelNumber);
  if (decoded) {
    const ctIndex = ctIndexFor(decoded.teamIdx, decoded.playerIdx);
    const playerName = state.teams[decoded.teamIdx].players[decoded.playerIdx];
    state.ctBuzzedPlayerIdx = ctIndex;
    playSound(decoded.teamIdx === 0 ? 'ringin.wav' : 'ringout.wav', () => announceBuzz('', playerName));
    $('ct-buzz-player-label').textContent = playerName;
    $('ct-buzz-score-value').textContent = state.ctScores[ctIndex];
    recordBuzzStats(decoded.teamIdx, decoded.playerIdx);
    renderCTLeaderboard();
  } else {
    $('ct-buzz-player-label').textContent = `ID: ${byte4}`;
    $('ct-buzz-score-value').textContent = '';
  }
}

// Builds the sorted (score descending) leaderboard rows from state.ctScores.
// Re-rendered wholesale on every score change since ordering can shift each time.
function renderCTLeaderboard() {
  const count = playersPerTeam();
  const entries = [];
  for (let i = 0; i < count; i++) entries.push({ ctIndex: i, name: state.teams[0].players[i], score: state.ctScores[i] });
  for (let i = 0; i < count; i++) entries.push({ ctIndex: count + i, name: state.teams[1].players[i], score: state.ctScores[count + i] });
  entries.sort((a, b) => b.score - a.score);

  const container = $('ct-leaderboard');
  container.innerHTML = '';
  entries.forEach(entry => {
    const row = document.createElement('div');
    row.className = 'ct-row' + (entry.ctIndex === state.ctBuzzedPlayerIdx ? ' highlight' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'ct-name';
    nameEl.textContent = entry.name;

    const scoreEl = document.createElement('span');
    scoreEl.className = 'ct-score';
    scoreEl.textContent = entry.score;
    scoreEl.onclick = () => adjustCTScore(entry.ctIndex, 1);
    scoreEl.oncontextmenu = (e) => { e.preventDefault(); adjustCTScore(entry.ctIndex, -1); };

    row.appendChild(nameEl);
    row.appendChild(scoreEl);
    container.appendChild(row);
  });
}

function adjustCTScore(ctIndex, direction) {
  state.ctScores[ctIndex] += direction * state.config.scoreIncrement;
  if (state.ctScores[ctIndex] < 0) state.ctScores[ctIndex] = 0;

  if (direction === 1 && ctIndex === state.ctBuzzedPlayerIdx &&
      state.currentBuzz && !state.currentBuzz.pointAwarded) {
    const teamIdx = ctIndex < playersPerTeam() ? 0 : 1;
    state.currentBuzz.pointAwarded = true;
    state.stats.teams[teamIdx].tossupPoints++;
    state.stats.players[teamIdx][state.currentBuzz.playerIdx].tossupPoints++;
  }

  if (ctIndex === state.ctBuzzedPlayerIdx) $('ct-buzz-score-value').textContent = state.ctScores[ctIndex];
  renderCTLeaderboard();
}

// ── STATS ──────────────────────────────────────────────────────────────────

function initStatsData() {
  const count = playersPerTeam();
  state.stats.teams = [0, 1].map(() => ({
    tossupAttempts: 0, tossupPoints: 0,
    bonusAttempts: 0, bonusPoints: 0,
    interrupts: 0
  }));
  state.stats.players = [0, 1].map(() =>
    Array.from({ length: count }, () => ({
      tossupAttempts: 0, tossupPoints: 0, interrupts: 0,
      responseTimeTotalMs: 0, responseTimeCount: 0
    }))
  );
}

function highlightTeam(teamIdx) {
  clearHighlight();
  $(`score-box-${teamIdx}`).classList.add('highlight');
}

function clearHighlight() {
  $('score-box-0').classList.remove('highlight');
  $('score-box-1').classList.remove('highlight');
}

// A buzz is a tossup attempt for that player/team. If it happened before the
// tossup timer was started for this cycle, it's also an interrupt; otherwise
// its elapsed time since the timer started feeds that player's average response time.
function recordBuzzStats(teamIdx, playerIdx) {
  if (state.buzzerCheckActive) return; // buzzer check: buzzes display but don't count toward stats

  const teamStats   = state.stats.teams[teamIdx];
  const playerStats = state.stats.players[teamIdx][playerIdx];

  teamStats.tossupAttempts++;
  playerStats.tossupAttempts++;

  if (!state.tossupTimerStarted) {
    teamStats.interrupts++;
    playerStats.interrupts++;
  } else if (state.tossupStartTime !== null) {
    playerStats.responseTimeTotalMs += Date.now() - state.tossupStartTime;
    playerStats.responseTimeCount++;
  }

  state.currentBuzz = { teamIdx, playerIdx, pointAwarded: false };
}

function recordBonusAttempt(teamIdx) {
  state.stats.teams[teamIdx].bonusAttempts++;
}

// Resets the per-buzz-cycle stat state (called wherever a buzz is cleared/reset).
// Does NOT touch bonus eligibility/active state — that persists across the
// tossup-to-bonus transition until the next tossup timer start.
function resetBuzzCycle() {
  state.currentBuzz = null;
  state.tossupTimerStarted = false;
  state.tossupStartTime = null;
  state.inBonus = false;
  state.inIntro = false;
  clearHighlight();
}

function makeStatsRow(cells) {
  const tr = document.createElement('tr');
  cells.forEach(text => {
    const td = document.createElement('td');
    td.textContent = text;
    tr.appendChild(td);
  });
  return tr;
}

function renderStats() {
  if (!state.stats.teams.length) initStatsData();

  const teamBody = $('stats-team-body');
  teamBody.innerHTML = '';
  state.stats.teams.forEach((t, i) => {
    const tuPct = t.tossupAttempts > 0 ? Math.round(t.tossupPoints / t.tossupAttempts * 100) : 0;
    const bPct  = t.bonusAttempts  > 0 ? Math.round(t.bonusPoints  / t.bonusAttempts  * 100) : 0;
    teamBody.appendChild(makeStatsRow([
      state.teams[i].name,
      t.tossupAttempts, t.tossupPoints, `${tuPct}%`,
      t.bonusAttempts, t.bonusPoints, `${bPct}%`,
      t.interrupts
    ]));
  });

  const playerBody = $('stats-player-body');
  playerBody.innerHTML = '';
  state.stats.players.forEach((teamPlayers, teamIdx) => {
    teamPlayers.forEach((p, playerIdx) => {
      const tuPct = p.tossupAttempts > 0 ? Math.round(p.tossupPoints / p.tossupAttempts * 100) : 0;
      const avgResp = p.responseTimeCount > 0
        ? (p.responseTimeTotalMs / p.responseTimeCount / 1000).toFixed(1)
        : '—';
      playerBody.appendChild(makeStatsRow([
        state.teams[teamIdx].players[playerIdx],
        state.teams[teamIdx].name,
        p.tossupAttempts, p.tossupPoints, `${tuPct}%`,
        avgResp,
        p.interrupts
      ]));
    });
  });
}

// Resolves the DOM ids for whichever board is being driven. Classic has a team
// label; Cut Throat doesn't, so callers must guard teamLabel before using it.
// Pass `board` explicitly when the caller isn't necessarily running while that
// board's screen is the active one (e.g. Buzzer Check button wiring).
function activeBoardIds(board) {
  const isCT = board ? board === 'cutthroat' : $('cutthroat').classList.contains('active');
  if (isCT) {
    return {
      responseBox: 'ct-response-timer-box', responseValue: 'ct-response-timer-value',
      matchBox: 'ct-match-timer-box', matchValue: 'ct-match-timer-value',
      teamLabel: null, playerLabel: 'ct-buzz-player-label'
    };
  }
  return {
    responseBox: 'response-timer-box', responseValue: 'response-timer-value',
    matchBox: 'match-timer-box', matchValue: 'match-timer-value',
    teamLabel: 'buzz-team-label', playerLabel: 'buzz-player-label'
  };
}

// Buzzer Check is only useful once stats are being tracked (it exists to keep a
// substitution's test buzzes out of the stats), so hide it until Keep Match Stats
// is checked. If stats get unchecked mid-check, resume the match first.
function updateBuzzerCheckVisibility() {
  const show = state.keepStats;
  if (!show && state.buzzerCheckActive) {
    const activeButtonId = $('btn-buzzer-check').textContent === 'Resume Match' ? 'btn-buzzer-check' : 'ct-btn-buzzer-check';
    toggleBuzzerCheck(activeButtonId);
  }
  $('btn-buzzer-check').style.display = show ? '' : 'none';
  $('ct-btn-buzzer-check').style.display = show ? '' : 'none';
}

// Buzzer Check: lets operators test buzzers after a player substitution without
// touching stats or timers. Pressing it pauses the match timer (if running),
// blocks new timers/stats, and lets buzzes display normally so names can be
// confirmed. Pressing "Resume Match" clears the name label and un-pauses everything.
// `buttonId` identifies which board's button was pressed (btn-buzzer-check or
// ct-btn-buzzer-check), which also tells us which board's DOM to update.
function toggleBuzzerCheck(buttonId) {
  const board = buttonId === 'ct-btn-buzzer-check' ? 'cutthroat' : 'classic';
  const ids = activeBoardIds(board);
  const btn = $(buttonId);

  if (!state.buzzerCheckActive) {
    state.buzzerCheckActive = true;
    state.buzzerCheckMatchWasRunning = state.matchRunning;
    clearInterval(state.matchInterval);
    state.matchRunning = false;
    clearInterval(state.responseInterval);
    $(ids.responseBox).classList.remove('expired');

    // Clear any blocking state so test buzzes register and display freely.
    state.anyTimerExpired = false;
    state.responseExpired = false;
    state.inTimeout = false;
    state.inBonus = false;
    state.inIntro = false;
    state.buzzLocked = false;
    if (ids.teamLabel) $(ids.teamLabel).textContent = '';
    $(ids.playerLabel).textContent = '';

    btn.textContent = 'Resume Match';
  } else {
    state.buzzerCheckActive = false;
    if (ids.teamLabel) $(ids.teamLabel).textContent = '';
    $(ids.playerLabel).textContent = '';
    btn.textContent = 'Buzzer Check';

    if (state.buzzerCheckMatchWasRunning) startMatchTimer();
    state.buzzerCheckMatchWasRunning = false;
  }
}

function initScoreboard() {
  state.anyTimerExpired = false;
  state.buzzLocked = false;
  state.inTimeout = false;
  state.inBonus = false;
  state.inIntro = true;
  state.buzzerCheckActive = false;
  state.buzzerCheckMatchWasRunning = false;
  $('btn-buzzer-check').textContent = 'Buzzer Check';
  updateBuzzerCheckVisibility();

  updateScoreDisplay();
  $('score-name-0').textContent = state.teams[0].name;
  $('score-name-1').textContent = state.teams[1].name;
  $('buzz-team-label').textContent   = '';
  $('buzz-player-label').textContent = 'INQUISITOR';
  $('raw-byte-display').textContent  = '';

  if (!state.matchInitialized) {
    state.matchSeconds = parseMMSS(state.config.matchTimer);
    state.matchInitialized = true;
    initStatsData();
  }
  state.matchRunning  = false;
  $('match-timer-value').textContent    = formatMMSS(state.matchSeconds);
  $('response-timer-value').textContent = '00';

  // RESPONSE TIMER — left=tossup, right=bonus
  $('response-timer-box').onclick = () => startResponseTimer(state.config.tossupTimer, 'tossup');
  $('response-timer-box').oncontextmenu = (e) => {
    e.preventDefault();
    startResponseTimer(state.config.bonusTimer, 'bonus');
  };

  // MATCH TIMER — left=start, right=stop+60s timeout
  $('match-timer-box').onclick = () => startMatchTimer();
  $('match-timer-box').oncontextmenu = (e) => {
    e.preventDefault();
    callTimeout();
  };

  // Score boxes — left=increment, right=decrement
  $('score-box-0').onclick = () => adjustScore(0, 1);
  $('score-box-0').oncontextmenu = (e) => { e.preventDefault(); adjustScore(0, -1); };
  $('score-box-1').onclick = () => adjustScore(1, 1);
  $('score-box-1').oncontextmenu = (e) => { e.preventDefault(); adjustScore(1, -1); };

  // MENU button — pause timers, return to menu
  $('btn-back-to-menu').onclick = () => {
    clearInterval(state.matchInterval);
    clearInterval(state.responseInterval);
    state.matchRunning = false;
    populateMenu();
    showScreen('menu');
  };

  // BUZZER CHECK / RESUME MATCH — toggle stats/timer suspension for buzzer testing
  $('btn-buzzer-check').onclick = () => toggleBuzzerCheck('btn-buzzer-check');

  // Player label click — clear labels, reset expired state, send 124 then 125
  $('buzz-player-label').onclick = async () => {
    $('buzz-team-label').textContent   = '';
    $('buzz-player-label').textContent = '';
    clearInterval(state.responseInterval);
    $('response-timer-value').textContent = '';
    $('response-timer-box').classList.remove('expired');
    state.anyTimerExpired = false;
    state.responseExpired = false;
    state.inTimeout = false;
    resetBuzzCycle();
    await resetBuzzers();
  };

  // Dismiss — close message box, clear team label, send reset to HID, unlock
  $('btn-dismiss').onclick = async () => {
    $('sb-msgbox').style.display = 'none';
    $('buzz-team-label').textContent = '';
    resetBuzzCycle();
    await resetBuzzers();
  };
}

function initCutthroat() {
  state.anyTimerExpired = false;
  state.buzzLocked = false;
  state.inTimeout = false;
  state.inBonus = false;
  state.inIntro = true;
  state.buzzerCheckActive = false;
  state.buzzerCheckMatchWasRunning = false;
  $('ct-btn-buzzer-check').textContent = 'Buzzer Check';
  updateBuzzerCheckVisibility();

  const count = playersPerTeam();
  if (state.ctScores.length !== count * 2) state.ctScores = new Array(count * 2).fill(0);
  state.ctBuzzedPlayerIdx = null;

  renderCTLeaderboard();
  $('ct-buzz-player-label').textContent = 'INQUISITOR';
  $('ct-buzz-score-value').textContent = '';
  $('ct-raw-byte-display').textContent = '';

  if (!state.matchInitialized) {
    state.matchSeconds = parseMMSS(state.config.matchTimer);
    state.matchInitialized = true;
    initStatsData();
  }
  state.matchRunning = false;
  $('ct-match-timer-value').textContent    = formatMMSS(state.matchSeconds);
  $('ct-response-timer-value').textContent = '00';

  // RESPONSE TIMER — left=tossup, right=bonus
  $('ct-response-timer-box').onclick = () => startResponseTimer(state.config.tossupTimer, 'tossup');
  $('ct-response-timer-box').oncontextmenu = (e) => {
    e.preventDefault();
    startResponseTimer(state.config.bonusTimer, 'bonus');
  };

  // MATCH TIMER — left=start, right=stop+60s timeout
  $('ct-match-timer-box').onclick = () => startMatchTimer();
  $('ct-match-timer-box').oncontextmenu = (e) => {
    e.preventDefault();
    callTimeout();
  };

  // MENU button — pause timers, return to menu
  $('ct-btn-back-to-menu').onclick = () => {
    clearInterval(state.matchInterval);
    clearInterval(state.responseInterval);
    state.matchRunning = false;
    populateMenu();
    showScreen('menu');
  };

  // BUZZER CHECK / RESUME MATCH — toggle stats/timer suspension for buzzer testing
  $('ct-btn-buzzer-check').onclick = () => toggleBuzzerCheck('ct-btn-buzzer-check');

  // Player label click — clear labels, reset expired state, send 124 then 125
  $('ct-buzz-player-label').onclick = async () => {
    $('ct-buzz-player-label').textContent = '';
    $('ct-buzz-score-value').textContent = '';
    clearInterval(state.responseInterval);
    $('ct-response-timer-value').textContent = '';
    $('ct-response-timer-box').classList.remove('expired');
    state.anyTimerExpired = false;
    state.responseExpired = false;
    state.inTimeout = false;
    resetBuzzCycle();
    state.ctBuzzedPlayerIdx = null;
    renderCTLeaderboard();
    await resetBuzzers();
  };
}

function updateScoreDisplay() {
  $('score-val-0').textContent = state.scores[0];
  $('score-val-1').textContent = state.scores[1];
}

function adjustScore(teamIdx, direction) {
  state.scores[teamIdx] += direction * state.config.scoreIncrement;
  if (state.scores[teamIdx] < 0) state.scores[teamIdx] = 0;
  updateScoreDisplay();

  if (direction !== 1) return; // only a score increase can award a tossup/bonus point

  if (state.currentBuzz && !state.currentBuzz.pointAwarded && state.currentBuzz.teamIdx === teamIdx) {
    state.currentBuzz.pointAwarded = true;
    state.stats.teams[teamIdx].tossupPoints++;
    state.stats.players[teamIdx][state.currentBuzz.playerIdx].tossupPoints++;
    state.bonusEligibleTeam = teamIdx;
  } else if (state.bonusActiveTeam === teamIdx && !state.bonusPointAwarded) {
    state.bonusPointAwarded = true;
    state.stats.teams[teamIdx].bonusPoints++;
  }
}

function startResponseTimer(seconds, mode) {
  if (state.buzzerCheckActive) return;
  const ids = activeBoardIds();
  const isCT = ids.teamLabel === null;
  clearInterval(state.responseInterval);
  state.responseSeconds = seconds;
  state.responseExpired = false;
  $(ids.responseBox).classList.remove('expired');
  $(ids.responseValue).textContent = String(state.responseSeconds).padStart(2, '0');

  if (mode === 'tossup') {
    state.tossupTimerStarted = true;
    state.tossupStartTime = Date.now();
    state.bonusActiveTeam = null;
    state.bonusPointAwarded = false;
    state.inBonus = false;
    state.inIntro = false;
    if (!isCT) clearHighlight();
  } else if (mode === 'bonus') {
    state.inBonus = true;
    if (ids.teamLabel) $(ids.teamLabel).textContent = '';
    $(ids.playerLabel).textContent = 'Bonus';
    if (state.bonusEligibleTeam !== null) {
      recordBonusAttempt(state.bonusEligibleTeam);
      state.bonusActiveTeam = state.bonusEligibleTeam;
      state.bonusPointAwarded = false;
      state.bonusEligibleTeam = null;
      if (!isCT) highlightTeam(state.bonusActiveTeam);
    }
  }

  state.responseInterval = setInterval(() => {
    state.responseSeconds--;
    $(ids.responseValue).textContent =
      String(Math.max(0, state.responseSeconds)).padStart(2, '0');
    if (state.responseSeconds <= 0) {
      clearInterval(state.responseInterval);
      state.responseExpired = true;
      state.anyTimerExpired = true;
      state.buzzLocked = true;
      $(ids.responseBox).classList.add('expired');
      // On Cut Throat only the tossup (left-click) timer prints TIME EXPIRED;
      // a bonus-timer expiry there leaves whatever label ("Bonus") is showing.
      if (!isCT || mode === 'tossup') {
        if (ids.teamLabel) $(ids.teamLabel).textContent = '';
        $(ids.playerLabel).textContent = 'TIME EXPIRED';
      }
      playSound('Windows XP Hardware Fail.wav');
    }
  }, 1000);
}

function startMatchTimer() {
  if (state.buzzerCheckActive) return;
  if (state.matchRunning) return;
  const ids = activeBoardIds();
  const isCT = ids.teamLabel === null;
  clearInterval(state.matchInterval);
  clearInterval(state.timeoutInterval);
  state.matchRunning = true;
  $(ids.matchBox).classList.remove('expired');

  state.matchInterval = setInterval(() => {
    state.matchSeconds--;
    $(ids.matchValue).textContent = formatMMSS(Math.max(0, state.matchSeconds));
    if (state.matchSeconds <= 0) {
      clearInterval(state.matchInterval);
      state.matchRunning = false;
      state.anyTimerExpired = true;
      state.buzzLocked = true;
      $(ids.matchBox).classList.add('expired');
      if (ids.teamLabel) $(ids.teamLabel).textContent = '';
      $(ids.playerLabel).textContent = isCT ? 'Match Over' : 'TIME EXPIRED';
      playSound('Windows XP Hardware Fail.wav');
    }
  }, 1000);
}

function callTimeout() {
  if (state.buzzerCheckActive) return;
  const ids = activeBoardIds();
  clearInterval(state.matchInterval);
  clearInterval(state.responseInterval);
  state.matchRunning = false;
  state.inTimeout = true;
  if (ids.teamLabel) $(ids.teamLabel).textContent = '';
  $(ids.playerLabel).textContent = 'Time Out';
  startResponseTimer(60);
}

// ── KEYBOARD ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', async (e) => {
  const onScoreboard = $('scoreboard').classList.contains('active');
  const onCutthroat  = $('cutthroat').classList.contains('active');
  if (e.code === 'Space' && (onScoreboard || onCutthroat)) {
    e.preventDefault(); // prevent page scroll
    const ids = activeBoardIds();
    if (ids.teamLabel) $(ids.teamLabel).textContent = '';
    $(ids.playerLabel).textContent = '';
    state.anyTimerExpired = false;
    state.responseExpired = false;
    state.inTimeout = false;
    resetBuzzCycle();
    if (onCutthroat) {
      state.ctBuzzedPlayerIdx = null;
      $('ct-buzz-score-value').textContent = '';
      renderCTLeaderboard();
    }
    await resetBuzzers();
  }
});

// ── 4:3 RESIZE ─────────────────────────────────────────────────────────────
function resizeApp() {
  const container = document.getElementById('app-container');
  const ww = window.innerWidth;
  const wh = window.innerHeight;
  if (ww / wh > 4 / 3) {
    // Wider than 4:3 — constrain by height, letterbox sides
    container.style.width  = Math.round(wh * 4 / 3) + 'px';
    container.style.height = wh + 'px';
  } else {
    // Taller than 4:3 — constrain by width, letterbox top/bottom
    container.style.width  = ww + 'px';
    container.style.height = Math.round(ww * 3 / 4) + 'px';
  }
}
window.addEventListener('resize', resizeApp);

// ── INIT ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  resizeApp();
  initSplash();
  initMenu();
  showScreen('splash');
});
