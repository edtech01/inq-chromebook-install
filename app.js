if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {});
}

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
  matchSeconds: 0,
  matchInterval: null,
  matchRunning: false,
  responseInterval: null,
  responseSeconds: 0,
  responseExpired: false,
  timeoutInterval: null,
  anyTimerExpired: false,
  buzzLocked: false   // true while a buzz is displayed; gates repeat HID reports
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

async function connectHID() {
  try {
    const devices = await navigator.hid.requestDevice({ filters: [{ vendorId: HID_VID }] });
    if (!devices || devices.length === 0) { showNotFound(); return; }
    const device = devices[0];
    await device.open();
    state.hidDevice = device;
    state.modelNumber = device.productId;
    state.splashShown = false;
    device.addEventListener('inputreport', handleHIDReport);
    $('splash-vid-pid').textContent =
      `VID: 0x${device.vendorId.toString(16).toUpperCase().padStart(4,'0')}  ` +
      `PID: 0x${device.productId.toString(16).toUpperCase().padStart(4,'0')}`;
    $('splash-status').textContent = 'Reading device…';
    $('btn-connect').style.display = 'none';
    $('btn-exit').style.display = 'none';
  } catch (err) {
    showNotFound();
  }
}

function handleHIDReport(event) {
  const data = new Uint8Array(event.data.buffer);
  // Bytes 0-2 reserved. Byte 3 = player/team ID (255 = idle).
  // Model number (PID) stored in state.modelNumber at connect time.
  const byte4 = data[3];

  // Splash: display model confirmation once on first report
  if (!state.splashShown) {
    state.splashShown = true;
    $('splash-status').textContent =
      `Inquisitor Model ${state.modelNumber} is connected and working.`;
    $('btn-menu').style.display = 'inline-block';
  }

  // Scoreboard: always show raw byte 4; decode buzz if not locked
  if ($('scoreboard').classList.contains('active')) {
    $('raw-byte-display').textContent = `Byte 4: ${byte4}`;

    if (byte4 === 255) {
      if (!state.anyTimerExpired) state.buzzLocked = false;
      if (state.inTimeout) {
        $('buzz-player-label').textContent = 'Time Out';
      } else {
        $('buzz-player-label').textContent = state.anyTimerExpired ? 'TIME EXPIRED' : '';
      }
      return;
    }
    if (state.buzzLocked || state.anyTimerExpired) return;   // buzz already displayed — ignore repeats

    state.buzzLocked = true;
    handleScoreboardBuzz(byte4);
  }
}

function showNotFound() {
  $('splash-vid-pid').textContent = '';
  $('splash-status').textContent =
    'Inquisitor interface not found. Please connect your Inquisitor to any available USB port and click the CONNECT button or press EXIT.';
  $('btn-connect').style.display = 'inline-block';
  $('btn-exit').style.display = 'inline-block';
  $('btn-menu').style.display = 'none';
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

  // Auto-reconnect on load if device was previously granted
  navigator.hid.getDevices().then(devices => {
    const dev = devices.find(d => d.vendorId === HID_VID);
    if (dev) {
      dev.open().then(() => {
        state.hidDevice = dev;
        state.modelNumber = dev.productId;
        state.splashShown = false;
        dev.addEventListener('inputreport', handleHIDReport);
        $('splash-vid-pid').textContent =
          `VID: 0x${dev.vendorId.toString(16).toUpperCase().padStart(4,'0')}  ` +
          `PID: 0x${dev.productId.toString(16).toUpperCase().padStart(4,'0')}`;
        $('splash-status').textContent = 'Reading device…';
        $('btn-connect').style.display = 'none';
        $('btn-exit').style.display = 'none';
      }).catch(showNotFound);
    } else {
      showNotFound();
    }
  }).catch(showNotFound);
}

// ── MENU ───────────────────────────────────────────────────────────────────
function playersPerTeam() {
  if (state.modelNumber === 2012) return 4;
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
  for (let i = 0; i < count; i++) $(`t2-p${i+1}`).value = state.teams[1].players[i];

  $('cfg-match').value  = state.config.matchTimer;
  $('cfg-tossup').value = state.config.tossupTimer;
  $('cfg-bonus').value  = state.config.bonusTimer;
  $('cfg-score').value  = state.config.scoreIncrement;
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

  document.querySelectorAll('#menu-body input[type="text"]').forEach(input => {
    input.addEventListener('focus', () => { input.value = ''; });
  });

  $('btn-continue').addEventListener('click', () => {
    saveMenuValues();
    initScoreboard();
    showScreen('scoreboard');
  });
}

// ── AUDIO ──────────────────────────────────────────────────────────────────

function playDingTone() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const oscillator = ctx.createOscillator();
    const gainNode   = ctx.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);

    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, ctx.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(660, ctx.currentTime + 0.5);
    gainNode.gain.setValueAtTime(0.8, ctx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);

    oscillator.start(ctx.currentTime);
    oscillator.stop(ctx.currentTime + 0.8);
    oscillator.onended = () => ctx.close();
  } catch (e) {
    console.warn('Audio not available:', e);
  }
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

function playTripleDing() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const ding = (startTime) => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'sine';
      osc.frequency.setValueAtTime(1047, startTime);       // C6 — bright bell tone
      gain.gain.setValueAtTime(0.7, startTime);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + 0.22);
      osc.start(startTime);
      osc.stop(startTime + 0.22);
    };
    const t = ctx.currentTime;
    ding(t);
    ding(t + 0.28);
    ding(t + 0.56);
    setTimeout(() => ctx.close(), 1000);
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
  if (modelNumber === 2012) {
    // XOR with 255, isolate one bit randomly if multiple set, bit position = player number - 1
    let val = byte4 ^ 255;
    if (val === 0) return null;
    const setBits = [];
    for (let bit = 0; bit < 8; bit++) { if (val & (1 << bit)) setBits.push(bit); }
    if (setBits.length > 1) {
      const kept = setBits[Math.floor(Math.random() * setBits.length)];
      val = 1 << kept;
    }
    const playerNum = Math.log2(val) + 1;
    if (playerNum >= 1 && playerNum <= 4) return { teamIdx: 0, playerIdx: playerNum - 1 };
    if (playerNum >= 5 && playerNum <= 8) return { teamIdx: 1, playerIdx: playerNum - 5 };
    return null;
  }
  return null;
}

function handleScoreboardBuzz(byte4) {
  const decoded = decodeByte4(byte4, state.modelNumber);
  if (decoded) {
    playTripleDing();
    $('buzz-team-label').textContent   = state.teams[decoded.teamIdx].name;
    $('buzz-player-label').textContent = state.teams[decoded.teamIdx].players[decoded.playerIdx];
  } else {
    $('buzz-team-label').textContent   = '';
    $('buzz-player-label').textContent = `ID: ${byte4}`;
  }
}

function initScoreboard() {
  state.anyTimerExpired = false;
  state.buzzLocked = false;
  state.inTimeout = false;

  updateScoreDisplay();
  $('score-name-0').textContent = state.teams[0].name;
  $('score-name-1').textContent = state.teams[1].name;
  $('buzz-team-label').textContent   = '';
  $('buzz-player-label').textContent = '';
  $('raw-byte-display').textContent  = '';

  if (!state.matchInitialized) {
    state.matchSeconds = parseMMSS(state.config.matchTimer);
    state.matchInitialized = true;
  }
  state.matchRunning  = false;
  $('match-timer-value').textContent    = formatMMSS(state.matchSeconds);
  $('response-timer-value').textContent = '00';

  // RESPONSE TIMER — left=tossup, right=bonus
  $('response-timer-box').onclick = () => startResponseTimer(state.config.tossupTimer);
  $('response-timer-box').oncontextmenu = (e) => {
    e.preventDefault();
    startResponseTimer(state.config.bonusTimer);
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

  // Player label click — clear labels, reset expired state, send 124 then 125
  $('buzz-player-label').onclick = async () => {
    $('buzz-team-label').textContent   = '';
    $('buzz-player-label').textContent = '';
    state.anyTimerExpired = false;
    state.responseExpired = false;
    state.inTimeout = false;
    await resetBuzzers();
  };

  // Dismiss — close message box, clear team label, send reset to HID, unlock
  $('btn-dismiss').onclick = async () => {
    $('sb-msgbox').style.display = 'none';
    $('buzz-team-label').textContent = '';
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
}

function startResponseTimer(seconds) {
  clearInterval(state.responseInterval);
  state.responseSeconds = seconds;
  state.responseExpired = false;
  $('response-timer-box').classList.remove('expired');
  $('response-timer-value').textContent = String(state.responseSeconds).padStart(2, '0');

  state.responseInterval = setInterval(() => {
    state.responseSeconds--;
    $('response-timer-value').textContent =
      String(Math.max(0, state.responseSeconds)).padStart(2, '0');
    if (state.responseSeconds <= 0) {
      clearInterval(state.responseInterval);
      state.responseExpired = true;
      state.anyTimerExpired = true;
      state.buzzLocked = true;
      $('response-timer-box').classList.add('expired');
      $('buzz-team-label').textContent = '';
      $('buzz-player-label').textContent = 'TIME EXPIRED';
      playDingTone();
    }
  }, 1000);
}

function startMatchTimer() {
  if (state.matchRunning) return;
  clearInterval(state.matchInterval);
  clearInterval(state.timeoutInterval);
  state.matchRunning = true;
  $('match-timer-box').classList.remove('expired');

  state.matchInterval = setInterval(() => {
    state.matchSeconds--;
    $('match-timer-value').textContent = formatMMSS(Math.max(0, state.matchSeconds));
    if (state.matchSeconds <= 0) {
      clearInterval(state.matchInterval);
      state.matchRunning = false;
      state.anyTimerExpired = true;
      state.buzzLocked = true;
      $('match-timer-box').classList.add('expired');
      $('buzz-team-label').textContent = '';
      $('buzz-player-label').textContent = 'TIME EXPIRED';
    }
  }, 1000);
}

function callTimeout() {
  clearInterval(state.matchInterval);
  clearInterval(state.responseInterval);
  state.matchRunning = false;
  state.inTimeout = true;
  $('buzz-team-label').textContent   = '';
  $('buzz-player-label').textContent = 'Time Out';
  startResponseTimer(60);
}

// ── KEYBOARD ───────────────────────────────────────────────────────────────
document.addEventListener('keydown', async (e) => {
  if (e.code === 'Space' && $('scoreboard').classList.contains('active')) {
    e.preventDefault(); // prevent page scroll
    $('buzz-team-label').textContent   = '';
    $('buzz-player-label').textContent = '';
    state.anyTimerExpired = false;
    state.responseExpired = false;
    state.inTimeout = false;
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
