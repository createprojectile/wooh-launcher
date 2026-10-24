"use strict";

/**
 * WoohProject Launcher – renderer.
 *
 * A classic (non-module) browser script loaded after `i18n.js`. It owns all
 * UI state: Steam gate, Play/Install button, download progress, server
 * counters, settings and error dialogs.
 *
 * Communication with the main process happens exclusively through
 * `window.electronAPI`, defined in preload.js.
 */

// ---------------------------------------------------------------------------
// Message sanitising and dialogs
// ---------------------------------------------------------------------------

/** Removes server URLs from any message shown in the UI. */
function sanitizeMessage(message) {
  return String(message ?? "")
    .replace(/https?:\/\/[^\s"'<>)]+/gi, "[сервер]")
    .replace(/\b[\w.-]*huggingface\.co[^\s"'<>)]*/gi, "[сервер]")
    .replace(/\b[\w.-]+\.hf\.co\b[^\s"'<>)]*/gi, "[сервер]")
    .replace(/\bdatasets\/[\w.-]+\/[\w.-]+[^\s"'<>)]*/gi, "[сервер]");
}

// Even a stray `alert()` must not leak the CDN address.
(() => {
  const nativeAlert = window.alert.bind(window);
  window.alert = (message) => nativeAlert(sanitizeMessage(message));
})();

/**
 * Shows the two-button assistant dialog.
 *
 * @param {{ title?: string, message?: string, question?: string,
 *           yes?: string, no?: string, reportId?: string | null }} [options]
 * @returns {Promise<boolean>}
 */
function askDialog({
  title = "Помощник",
  message = "",
  question = "",
  yes = "Да",
  no = "Нет",
  reportId = null,
} = {}) {
  const modal = document.getElementById("modal-ask");
  if (!modal) return Promise.resolve(confirm(message + "\n\n" + question));

  document.getElementById("ask-title").textContent = title;
  document.getElementById("ask-message").textContent = sanitizeMessage(message);
  document.getElementById("ask-question").textContent = question;
  document.getElementById("ask-code").textContent = reportId ? "Код отчёта: " + reportId : "";

  const yesButton = document.getElementById("ask-yes");
  const noButton = document.getElementById("ask-no");
  yesButton.textContent = yes;
  noButton.textContent = no;
  modal.style.display = "flex";

  return new Promise((resolve) => {
    const close = (answer) => {
      modal.style.display = "none";
      yesButton.onclick = null;
      noButton.onclick = null;
      resolve(answer);
    };
    yesButton.onclick = () => close(true);
    noButton.onclick = () => close(false);
  });
}

/** On first run, offers to add the game domains to a running zapret config. */
async function checkZapretOnStart() {
  try {
    const state = await window.electronAPI?.zapretDetect?.();
    if (!state?.canFix) return;

    let skip = false;
    try {
      skip = localStorage.getItem("wooh.zapretSkip") === "1";
    } catch {
      // localStorage may be unavailable.
    }
    if (skip) return;

    const shouldFix = await askDialog({
      title: "Мешает zapret",
      message:
        "У вас включён zapret (программа для Discord и YouTube). Он может мешать скачивать игру.",
      question: "Исправить? Игра будет качаться, а Discord и YouTube продолжат работать.",
      yes: "Исправить",
      no: "Не сейчас",
    });

    if (shouldFix) {
      const result = await window.electronAPI?.zapretFix?.();
      console.log("[zapret] исправление при запуске: " + (result?.ok ? "готово" : "не удалось"));
    } else {
      try {
        localStorage.setItem("wooh.zapretSkip", "1");
      } catch {
        // Ignore.
      }
    }
  } catch (error) {
    console.warn("zapret check error:", error);
  }
}

/**
 * Shows the error dialog with the report code and support buttons.
 *
 * @param {{ title?: string, message: string, reportId?: string | null, info?: boolean }} options
 */
function showErrorDialog({ title, message, reportId, info = false }) {
  const modal = document.getElementById("modal-error");
  if (!modal) {
    alert("" + message + (reportId ? "\n\nКод отчёта: " + reportId : ""));
    return;
  }

  document.getElementById("error-title").textContent = title || "Ошибка";
  document.getElementById("error-message").textContent = sanitizeMessage(message);
  document.getElementById("error-code").textContent = reportId ? "Код отчёта: " + reportId : "";

  const hint = document.getElementById("error-hint");
  hint.style.display = "none";

  const telegramButton = document.getElementById("error-send-tg");
  const discordButton = document.getElementById("error-send-dc");
  telegramButton.disabled = false;
  discordButton.disabled = false;
  discordButton.style.display = "none";
  telegramButton.style.display = info ? "none" : "";

  if (!info) {
    window.electronAPI
      ?.supportLinks?.()
      .then((links) => {
        if (links?.discord) discordButton.style.display = "";
      })
      .catch(() => {});
  }

  const sendReport = async (channel) => {
    telegramButton.disabled = true;
    discordButton.disabled = true;
    try {
      const result = await window.electronAPI?.supportSend?.(reportId, channel);
      hint.style.display = "block";
      hint.className = "setting-hint ok";
      hint.textContent = result?.hasFile
        ? "Готово! Текст ошибки уже скопирован.\n1) В чате поддержки нажмите Ctrl+V и отправьте.\n2) Перетащите в чат файл из открывшейся папки."
        : "Готово! Текст ошибки уже скопирован. В чате поддержки нажмите Ctrl+V и отправьте.";
    } catch {
      hint.style.display = "block";
      hint.className = "setting-hint bad";
      hint.textContent =
        "Не получилось. Откройте «Настройки → Папка отчётов» и отправьте файл в поддержку.";
    } finally {
      telegramButton.disabled = false;
      discordButton.disabled = false;
    }
  };

  telegramButton.onclick = () => sendReport("telegram");
  discordButton.onclick = () => sendReport("discord");

  const close = () => {
    modal.style.display = "none";
  };
  document.getElementById("error-ok").onclick = close;
  document.getElementById("error-close").onclick = close;
  modal.onclick = (event) => {
    if (event.target === modal) close();
  };
  modal.style.display = "flex";
}

window.addEventListener("error", (event) => {
  reportUiError(
    event.error || new Error(event.message + " (" + event.filename + ":" + event.lineno + ")"),
    "ui-error",
  );
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  reportUiError(
    reason instanceof Error ? reason : new Error(String(reason)),
    "ui-unhandled-rejection",
  );
});

// ---------------------------------------------------------------------------
// Application state and DOM references
// ---------------------------------------------------------------------------

const state = {
  steamAuthed: false,
  clientInstalled: false,
  clientNeedsUpdate: false,
  clientUpdateInfo: null,
  installPhase: "idle",
  downloading: false,
  downloadPaused: false,
  downloadCancelled: false,
  installCancelledByUser: false,
  installPath: "C:\\WoohRustClient",
  launchArgs: "",
  steamUser: null,
  servers: {
    main: { online: 0, joining: 0, max: 0, status: false, map: "—" },
    combat: { online: 0, joining: 0, max: 0, status: false, map: "—" },
  },
};

const INSTALL_PATH_KEY = "wooh.installPath";
const LAUNCH_ARGS_KEY = "wooh.launchArgs";

function loadInstallPath() {
  try {
    const saved = localStorage.getItem(INSTALL_PATH_KEY);
    if (saved && typeof saved === "string") state.installPath = saved;
  } catch {
    // Ignore.
  }
}

function saveInstallPath(installPath) {
  state.installPath = installPath || "C:\\WoohRustClient";
  try {
    localStorage.setItem(INSTALL_PATH_KEY, state.installPath);
  } catch {
    // Ignore.
  }
  if (ui.installPathInput) ui.installPathInput.value = state.installPath;
}

function loadLaunchArgs() {
  try {
    const saved = localStorage.getItem(LAUNCH_ARGS_KEY);
    if (typeof saved === "string") state.launchArgs = saved;
  } catch {
    // Ignore.
  }
}

function saveLaunchArgs(launchArgs) {
  state.launchArgs = typeof launchArgs === "string" ? launchArgs : "";
  try {
    localStorage.setItem(LAUNCH_ARGS_KEY, state.launchArgs);
  } catch {
    // Ignore.
  }
}

const SERVER_IDS = { MAIN: 11_252_685, COMBAT: 11_487_742 };

const DEFAULT_AVATAR =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64' fill='%23555'%3E%3Crect width='64' height='64' rx='12'/%3E%3Ctext x='50%25' y='55%25' text-anchor='middle' fill='%23888' font-size='20' font-family='Inter'%3E?%3C/text%3E%3C/svg%3E";

/** Translates a key, falling back to the key itself. */
const tr = (key) => {
  try {
    const value = window.i18n?.t(key);
    return value ?? key;
  } catch {
    return key;
  }
};

const PLAY_TEXT_FALLBACK = {
  "play.checkingFiles": "Проверка файлов...",
  "play.signInSteam": "ВОЙДИТЕ ЧЕРЕЗ STEAM",
  "play.install": "Установить",
  "play.update": "Обновить",
  "play.play": "Играть",
  "play.launching": "Запуск...",
  "play.downloading": "Загрузка...",
  "play.paused": "Пауза",
  "play.done": "Готово!",
};

function playText(key) {
  const translated = tr(key);
  if (typeof translated === "string" && translated !== key) return translated;
  return PLAY_TEXT_FALLBACK[key] || key;
}

function setPlayText(key) {
  if (ui.btnPlayText) ui.btnPlayText.textContent = playText(key);
}

const $ = (selector) => document.querySelector(selector);
const ui = {
  btnMinimize: $("#btn-minimize"),
  btnClose: $("#btn-close"),
  userAvatar: $("#user-avatar"),
  userName: $("#user-name"),
  userSteamId: $("#user-steamid"),
  userStatusDot: $("#user-status-dot"),
  btnSteamAuth: $("#btn-steam-auth"),
  btnPlay: $("#btn-play"),
  btnPlayText: $("#btn-play-text"),
  playIconWrapper: $("#play-icon-wrapper"),
  btnPause: $("#btn-pause"),
  btnCancelDl: $("#btn-cancel-dl"),
  progressWrap: $("#progress-wrap"),
  progressPhase: $("#progress-phase"),
  progressFill: $("#progress-fill"),
  progressText: $("#progress-text"),
  progressSpeed: $("#progress-speed"),
  totalOnline: $("#total-online"),
  serverMainPlayers: $("#server-main-players"),
  serverMainMax: $("#server-main-max"),
  serverMainMap: $("#server-main-map"),
  serverMainDot: $("#server-main-dot"),
  serverMainName: $("#server-main-name"),
  serverCombatPlayers: $("#server-combat-players"),
  serverCombatMax: $("#server-combat-max"),
  serverCombatMap: $("#server-combat-map"),
  serverCombatDot: $("#server-combat-dot"),
  serverCombatName: $("#server-combat-name"),
  btnSettings: $("#btn-settings"),
  modalSettings: $("#modal-settings"),
  modalClose: $("#modal-close"),
  installPathInput: $("#install-path"),
  btnBrowse: $("#btn-browse"),
  launchArgsInput: $("#launch-args"),
  btnDiscord: $("#btn-discord"),
  btnTelegram: $("#btn-telegram"),
  btnShop: $("#btn-shop"),
  btnLogout: $("#btn-logout"),
  settingLang: $("#setting-lang"),
  steamGate: $("#steam-gate"),
  steamGateSpinner: $("#steam-gate-spinner"),
  steamGateMessage: $("#steam-gate-message"),
  btnSteamRetry: $("#btn-steam-retry"),
  launcherUpdateGate: $("#launcher-update-gate"),
  launcherUpdateMessage: $("#launcher-update-message"),
  launcherUpdateProgress: $("#launcher-update-progress"),
  launcherUpdateProgressFill: $("#launcher-update-progress-fill"),
  launcherUpdateProgressText: $("#launcher-update-progress-text"),
};

let launcherReady = false;
let steamBlocked = false;
let steamWatchTimer = null;
/** @type {{ running: boolean, loggedIn: boolean, ready: boolean, unknown?: boolean } | null} */
let lastSteamGateState = null;
let latestGameInstallProgress = null;
let gameInstallProgressTimer = null;
let serverRefreshTimer = null;
let uiAudioContext = null;
let lastUiHoverSoundAt = 0;
let currentInstallPromise = null;

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return "";
  const rounded = Math.round(seconds);
  if (rounded < 60) return rounded + " с";
  const minutes = Math.round(rounded / 60);
  if (minutes < 60) return minutes + " мин";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? hours + " ч " + rest + " мин" : hours + " ч";
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(unit === 0 ? 0 : 1) + " " + units[unit];
}

// ---------------------------------------------------------------------------
// UI sound effects
// ---------------------------------------------------------------------------

const sfx = (() => {
  let outputGain = null;
  let noiseBuffer = null;

  function ensureContext() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    if (!uiAudioContext) {
      uiAudioContext = new AudioContextClass();
      const compressor = uiAudioContext.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.ratio.value = 4;
      outputGain = uiAudioContext.createGain();
      outputGain.gain.value = 0.9;
      outputGain.connect(compressor);
      compressor.connect(uiAudioContext.destination);

      noiseBuffer = uiAudioContext.createBuffer(
        1,
        uiAudioContext.sampleRate * 0.5,
        uiAudioContext.sampleRate,
      );
      const samples = noiseBuffer.getChannelData(0);
      for (let index = 0; index < samples.length; index++) {
        samples[index] = Math.random() * 2 - 1;
      }
    }
    if (uiAudioContext.state === "suspended") uiAudioContext.resume();
    return uiAudioContext;
  }

  function envelope(context, gain, startTime, peak, attack, release) {
    gain.gain.setValueAtTime(0.0001, startTime);
    gain.gain.exponentialRampToValueAtTime(peak, startTime + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, startTime + attack + release);
  }

  function tone(
    context,
    { type = "sine", from, to, t, peak, attack = 0.004, release = 0.08, detune = 0 },
  ) {
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = type;
    oscillator.detune.value = detune;
    oscillator.frequency.setValueAtTime(from, t);
    if (to) oscillator.frequency.exponentialRampToValueAtTime(to, t + attack + release * 0.6);
    envelope(context, gain, t, peak, attack, release);
    oscillator.connect(gain).connect(outputGain);
    oscillator.start(t);
    oscillator.stop(t + attack + release + 0.02);
  }

  function noise(
    context,
    { t, peak, attack = 0.002, release = 0.03, filter = "highpass", freq = 4000, freqTo, q = 0.8 },
  ) {
    const source = context.createBufferSource();
    source.buffer = noiseBuffer;
    const biquad = context.createBiquadFilter();
    biquad.type = filter;
    biquad.Q.value = q;
    biquad.frequency.setValueAtTime(freq, t);
    if (freqTo) biquad.frequency.exponentialRampToValueAtTime(freqTo, t + attack + release);
    const gain = context.createGain();
    envelope(context, gain, t, peak, attack, release);
    source.connect(biquad).connect(gain).connect(outputGain);
    source.start(t);
    source.stop(t + attack + release + 0.02);
  }

  function effect(play) {
    return (...args) => {
      try {
        const context = ensureContext();
        if (context) play(context, context.currentTime, ...args);
      } catch {
        // Sound is decorative: never let it break the UI.
      }
    };
  }

  return {
    hover: effect((context, now) => {
      noise(context, { t: now, peak: 0.018, release: 0.012, freq: 7000 });
    }),
    click: effect((context, now) => {
      noise(context, { t: now, peak: 0.05, release: 0.02, filter: "bandpass", freq: 3200, q: 1.2 });
      tone(context, { from: 1400, to: 520, t: now, peak: 0.07, attack: 0.002, release: 0.05 });
    }),
    toggle: effect((context, now, enabled) => {
      const [first, second] = enabled ? [880, 1320] : [1320, 880];
      tone(context, { from: first, t: now, peak: 0.035, release: 0.06 });
      tone(context, { from: second, t: now + 0.045, peak: 0.035, release: 0.08 });
    }),
    sheet: effect((context, now) => {
      noise(context, {
        t: now,
        peak: 0.05,
        attack: 0.04,
        release: 0.22,
        filter: "bandpass",
        freq: 600,
        freqTo: 3200,
        q: 0.7,
      });
    }),
    success: effect((context, now) => {
      [659.25, 987.77, 1318.5].forEach((frequency, index) => {
        tone(context, {
          from: frequency,
          t: now + index * 0.09,
          peak: 0.05,
          attack: 0.006,
          release: 0.6,
        });
        tone(context, {
          type: "triangle",
          from: frequency * 2,
          t: now + index * 0.09,
          peak: 0.008,
          release: 0.3,
          detune: 4,
        });
      });
    }),
    error: effect((context, now) => {
      tone(context, { type: "triangle", from: 392, t: now, peak: 0.06, release: 0.14 });
      tone(context, { type: "triangle", from: 311, t: now + 0.12, peak: 0.06, release: 0.24 });
    }),
  };
})();

function playUiClick() {
  sfx.click();
}

function playUiHover() {
  const now = performance.now();
  if (now - lastUiHoverSoundAt < 60) return;
  lastUiHoverSoundAt = now;
  sfx.hover();
}

// ---------------------------------------------------------------------------
// Steam gate
// ---------------------------------------------------------------------------

/**
 * Queries the Steam state, keeping the last known state on timeout.
 * @param {boolean} [silent] Suppress warnings (used by the background watcher).
 */
async function querySteamState(silent = false) {
  if (!window.electronAPI?.isSteamRunning) {
    return { running: true, loggedIn: true, ready: true };
  }
  try {
    const raw = await Promise.race([
      window.electronAPI.isSteamRunning(),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("steam check timeout")), 10_000),
      ),
    ]);
    const result = {
      running: Boolean(raw?.running),
      loggedIn: Boolean(raw?.loggedIn),
      ready: Boolean(raw?.ready ?? (raw?.running && raw?.loggedIn)),
    };
    lastSteamGateState = result;
    return result;
  } catch (error) {
    if (!silent) {
      console.warn("Steam check slow/failed, keeping last state:", error?.message);
    }
    if (lastSteamGateState) return { ...lastSteamGateState, unknown: true };
    return { running: false, loggedIn: false, ready: false, unknown: true };
  }
}

function getSteamGateMessageKey(state = lastSteamGateState) {
  if (state?.running && !state?.loggedIn) return "steamGate.selectAccount";
  return "steamGate.notRunning";
}

async function isSteamReady(silent = false) {
  const state = await querySteamState(silent);
  return state.ready;
}

function showSteamGateChecking() {
  if (!ui.steamGate) return;
  ui.steamGate.classList.remove("is-hidden", "is-error");
  if (ui.steamGateSpinner) ui.steamGateSpinner.style.display = "";
  if (ui.steamGateMessage) ui.steamGateMessage.textContent = tr("steamGate.checking");
  if (ui.btnSteamRetry) ui.btnSteamRetry.style.display = "none";
}

function showSteamGateError(state = lastSteamGateState) {
  if (!ui.steamGate) return;
  ui.steamGate.classList.remove("is-hidden");
  ui.steamGate.classList.add("is-error");
  if (ui.steamGateSpinner) ui.steamGateSpinner.style.display = "none";
  if (ui.steamGateMessage) {
    ui.steamGateMessage.textContent = tr(getSteamGateMessageKey(state));
  }
  if (ui.btnSteamRetry) {
    ui.btnSteamRetry.textContent = tr("steamGate.retry");
    ui.btnSteamRetry.style.display = "";
  }
}

function hideSteamGate() {
  if (!ui.steamGate) return;
  ui.steamGate.classList.add("is-hidden");
  ui.steamGate.classList.remove("is-error");
}

/** Polls Steam every 5 s: blocks the UI when Steam is closed and unlocks it again. */
let steamLostStreak = 0;

function startSteamWatch() {
  if (steamWatchTimer) return;
  steamWatchTimer = setInterval(async () => {
    const steam = await querySteamState(true);
    steamLostStreak = steam.ready ? 0 : steamLostStreak + 1;

    if (steam.ready && steamBlocked) {
      steamBlocked = false;
      hideSteamGate();
      if (!launcherReady) await continueLauncherInit();
      else await tryAutoSteamAuth();
      updatePlayButton();
      return;
    }

    if (launcherReady && !steamBlocked && !steam.ready && !steam.unknown && steamLostStreak >= 2) {
      await handleSteamLost();
    }
  }, 5000);
}

async function checkSteamRunning() {
  showSteamGateChecking();
  let steam = await querySteamState();

  for (let attempt = 0; attempt < 2 && !steam.ready; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    steam = await querySteamState(true);
  }

  if (steam.ready) {
    steamBlocked = false;
    hideSteamGate();
    return true;
  }
  steamBlocked = true;
  showSteamGateError(steam);
  return false;
}

async function handleSteamLost() {
  if (steamBlocked) return;
  const steam = await querySteamState(true);
  if (steam.ready) return;
  steamBlocked = true;
  resetLauncherAuth();
  showSteamGateError(steam);
  updatePlayButton();
}

// ---------------------------------------------------------------------------
// Launcher self-update gate
// ---------------------------------------------------------------------------

function showLauncherUpdateGate(messageKey) {
  if (!ui.launcherUpdateGate) return;
  ui.launcherUpdateGate.classList.remove("is-hidden");
  if (ui.launcherUpdateMessage) ui.launcherUpdateMessage.textContent = tr(messageKey);
  if (ui.launcherUpdateProgress) ui.launcherUpdateProgress.style.display = "none";
}

function hideLauncherUpdateGate() {
  if (!ui.launcherUpdateGate) return;
  ui.launcherUpdateGate.classList.add("is-hidden");
}

function updateLauncherUpdateProgress(progress = {}) {
  if (!ui.launcherUpdateGate || ui.launcherUpdateGate.classList.contains("is-hidden")) return;

  if (progress.messageKey && ui.launcherUpdateMessage) {
    ui.launcherUpdateMessage.textContent = tr(progress.messageKey);
  }

  if (progress.phase === "downloading" && ui.launcherUpdateProgress) {
    ui.launcherUpdateProgress.style.display = "block";
    const total = progress.totalBytes || 0;
    const downloaded = progress.downloadedBytes || 0;
    const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
    if (ui.launcherUpdateProgressFill) {
      ui.launcherUpdateProgressFill.style.width = percent.toFixed(1) + "%";
    }
    if (ui.launcherUpdateProgressText) {
      ui.launcherUpdateProgressText.textContent = percent.toFixed(1) + "%";
    }
  }
}

/**
 * Checks for launcher updates, retrying the download up to three times.
 * @returns {Promise<boolean>} false when the launcher is restarting.
 */
async function runLauncherSelfUpdate() {
  if (!window.electronAPI?.launcherUpdate) return true;

  let unsubscribe = null;
  showLauncherUpdateGate("launcherUpdate.checking");
  if (window.electronAPI.onLauncherUpdateProgress) {
    unsubscribe = window.electronAPI.onLauncherUpdateProgress((progress) => {
      updateLauncherUpdateProgress(progress);
    });
  }

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const retryButton = document.getElementById("btn-update-retry");
  const spinner = document.getElementById("launcher-update-spinner");
  const setMessage = (message) => {
    if (ui.launcherUpdateMessage) ui.launcherUpdateMessage.textContent = message;
  };

  try {
    for (;;) {
      if (retryButton) retryButton.style.display = "none";
      if (spinner) spinner.style.display = "";
      showLauncherUpdateGate("launcherUpdate.checking");

      let result = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          result = await window.electronAPI.launcherUpdate();
        } catch (error) {
          result = { ok: false, status: "error", message: error?.message || String(error) };
        }

        if (result?.status === "restarting") {
          showLauncherUpdateGate("launcherUpdate.restarting");
          return false;
        }
        if (result?.ok !== false) return true;

        console.warn(`launcher update attempt ${attempt}/3 failed:`, result?.message);
        if (attempt < 3) {
          setMessage("Не получилось скачать обновление, пробую ещё раз (" + (attempt + 1) + "/3)…");
          if (ui.launcherUpdateProgress) ui.launcherUpdateProgress.style.display = "none";
          await wait(3000 * attempt);
        }
      }

      if (spinner) spinner.style.display = "none";
      if (ui.launcherUpdateProgress) ui.launcherUpdateProgress.style.display = "none";
      setMessage(
        "Не получилось скачать обновление лаунчера.\nПроверьте интернет или включите VPN и нажмите «Повторить»." +
          (result?.reportId ? "\nКод отчёта: " + result.reportId : ""),
      );

      if (!retryButton) return false;
      retryButton.style.display = "";
      await new Promise((resolve) => {
        retryButton.onclick = () => resolve();
      });
    }
  } finally {
    unsubscribe?.();
    hideLauncherUpdateGate();
  }
}

// ---------------------------------------------------------------------------
// Steam authorisation UI
// ---------------------------------------------------------------------------

function updateAuthUI() {
  if (ui.btnSteamAuth) ui.btnSteamAuth.style.display = state.steamAuthed ? "none" : "";
  if (ui.btnLogout) ui.btnLogout.style.display = state.steamAuthed ? "flex" : "none";
}

function applySteamProfile(profile) {
  state.steamAuthed = true;
  state.steamUser = profile;
  if (ui.userName) ui.userName.textContent = profile.name;
  if (ui.userSteamId) ui.userSteamId.textContent = profile.steamId;
  if (profile.avatar && ui.userAvatar) ui.userAvatar.src = profile.avatar;
  if (ui.userStatusDot) ui.userStatusDot.classList.add("online");
  updateAuthUI();
  updatePlayButton();
}

async function tryAutoSteamAuth() {
  if (!window.electronAPI?.steamAuth || state.steamAuthed || steamBlocked) return;
  if (!(await isSteamReady(true))) return;
  try {
    const profile = await window.electronAPI.steamAuth();
    if (profile) applySteamProfile(profile);
  } catch (error) {
    console.error("Auto steam auth error:", error);
  }
}

function resetLauncherAuth() {
  state.steamAuthed = false;
  state.steamUser = null;
  if (ui.userName) ui.userName.textContent = tr("auth.notAuthorized");
  if (ui.userSteamId) ui.userSteamId.textContent = "";
  if (ui.userAvatar) ui.userAvatar.src = DEFAULT_AVATAR;
  if (ui.userStatusDot) ui.userStatusDot.classList.remove("online");
  if (ui.btnSteamAuth) {
    ui.btnSteamAuth.innerHTML = window.i18n.getSteamBtnHtml();
    ui.btnSteamAuth.disabled = false;
  }
  updateAuthUI();
  updatePlayButton();
}

async function continueLauncherInit() {
  if (launcherReady) return;
  try {
    await verifyFilesOnStart();
    await tryAutoSteamAuth();
    startServerPolling();
    launcherReady = true;
  } catch (error) {
    console.error("launcher init error:", error);
  } finally {
    updatePlayButton();
  }
}

if (ui.btnLogout) {
  ui.btnLogout.addEventListener("click", async () => {
    if (!state.steamAuthed) return;
    if (steamBlocked) return;
    ui.btnLogout.disabled = true;
    ui.btnLogout.textContent = tr("auth.loggingOut");
    try {
      resetLauncherAuth();
    } catch (error) {
      console.error("Logout error:", error);
    } finally {
      if (ui.btnLogout) {
        ui.btnLogout.textContent = tr("auth.logout");
        ui.btnLogout.disabled = false;
      }
    }
  });
}

if (ui.btnSteamRetry) {
  ui.btnSteamRetry.addEventListener("click", async () => {
    if (!(await checkSteamRunning())) return;
    if (!launcherReady) {
      await continueLauncherInit();
    } else {
      await tryAutoSteamAuth();
      updatePlayButton();
    }
  });
}

if (ui.btnMinimize) {
  ui.btnMinimize.addEventListener("click", () => window.electronAPI?.minimize());
}
if (ui.btnClose) {
  ui.btnClose.addEventListener("click", () => window.electronAPI?.close());
}

if (ui.btnSteamAuth) {
  ui.btnSteamAuth.addEventListener("click", async () => {
    if (state.steamAuthed || steamBlocked) return;

    if (!(await isSteamReady())) {
      await handleSteamLost();
      return;
    }

    ui.btnSteamAuth.textContent = tr("auth.authorizing");
    ui.btnSteamAuth.disabled = true;
    try {
      const profile = window.electronAPI?.steamAuth ? await window.electronAPI.steamAuth() : null;
      if (!profile) {
        if (!(await isSteamReady(true))) {
          await handleSteamLost();
          return;
        }
        ui.btnSteamAuth.innerHTML = window.i18n.getSteamBtnHtml();
        ui.btnSteamAuth.disabled = false;
        return;
      }
      applySteamProfile(profile);
    } catch (error) {
      console.error("Steam auth error:", error);
      ui.btnSteamAuth.innerHTML = window.i18n.getSteamBtnHtml();
      ui.btnSteamAuth.disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Play / Install button
// ---------------------------------------------------------------------------

const PLAY_ICON_INSTALL =
  '<svg class="btn-play-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 3V14" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><path d="M7.5 10.5L12 15L16.5 10.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><rect x="4" y="18" width="16" height="2.5" rx="1.25" fill="currentColor"/></svg>';
const PLAY_ICON_STEAM =
  '<svg class="btn-play-icon" width="24" height="24" viewBox="0 -2 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="m24.72 7.094c0 2.105-1.707 3.812-3.812 3.812-1.053 0-2.006-.427-2.696-1.117-.74-.697-1.201-1.684-1.201-2.778 0-2.105 1.707-3.812 3.812-3.812 1.094 0 2.08.461 2.776 1.199l.002.002c.691.669 1.12 1.605 1.12 2.641v.055-.003zm-12.033 11.593c0-.004 0-.008 0-.012 0-2.151-1.744-3.894-3.894-3.894-.004 0-.008 0-.013 0h.001c-.299 0-.59.034-.87.099l.026-.005 1.625.656c.778.303 1.387.897 1.704 1.644l.007.02c.164.356.26.772.26 1.21 0 .418-.087.816-.244 1.176l.007-.019c-.304.778-.901 1.386-1.652 1.696l-.02.007c-.355.161-.77.254-1.206.254-.422 0-.824-.088-1.188-.246l.019.007q-.328-.125-.969-.383l-.953-.383c.337.627.82 1.138 1.405 1.498l.017.01c.568.358 1.258.571 1.999.571h.034-.002.012c2.151 0 3.894-1.744 3.894-3.894 0-.004 0-.008 0-.013v.001zm12.969-11.577c-.005-2.63-2.136-4.761-4.765-4.766-2.631.002-4.763 2.135-4.763 4.766s2.134 4.766 4.766 4.766c1.313 0 2.503-.531 3.364-1.391.863-.834 1.399-2.003 1.399-3.296 0-.028 0-.056-.001-.083zm2.344 0v.001c0 3.926-3.183 7.109-7.109 7.109h-.001l-6.828 4.981c-.116 1.361-.749 2.556-1.698 3.402l-.005.004c-.914.863-2.151 1.394-3.512 1.394-.023 0-.046 0-.069 0h.004c-2.534-.002-4.652-1.777-5.181-4.152l-.007-.035-3.594-1.438v-6.703l6.08 2.453c.758-.471 1.679-.75 2.664-.75h.041-.002q.203 0 .547.031l4.438-6.359c.05-3.898 3.218-7.04 7.122-7.047h.001c3.924.006 7.104 3.185 7.11 7.109v.001z"/></svg>';
const PLAY_ICON_PLAY =
  '<svg class="btn-play-icon" width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M8 5v14l11-7L8 5z" fill="currentColor"/></svg>';

function updatePlayButton() {
  const button = ui.btnPlay;
  const label = ui.btnPlayText;
  const iconWrapper = ui.playIconWrapper;
  if (!button || !label) return;

  const actionCard = document.getElementById("action-card");
  const busyPhase = ["downloading", "verifying", "preparing", "verifying-download"].includes(
    state.installPhase,
  );
  if (actionCard) actionCard.classList.toggle("loading", busyPhase);

  if (
    state.installPhase === "downloading" ||
    state.installPhase === "paused" ||
    state.installPhase === "verifying" ||
    state.installPhase === "preparing" ||
    state.installPhase === "verifying-download"
  ) {
    button.disabled = true;
    button.classList.add("installing");
    button.classList.remove("ready");
    label.textContent =
      state.installPhase === "paused"
        ? playText("play.paused")
        : state.installPhase === "verifying" || state.installPhase === "preparing"
          ? playText("play.checkingFiles")
          : playText("play.downloading");
    if (iconWrapper) iconWrapper.innerHTML = PLAY_ICON_INSTALL;
    return;
  }

  if (!state.steamAuthed) {
    button.disabled = true;
    button.classList.remove("installing", "ready");
    label.textContent = playText("play.signInSteam");
    if (iconWrapper) iconWrapper.innerHTML = PLAY_ICON_STEAM;
    return;
  }

  if (!state.clientInstalled) {
    button.disabled = false;
    button.classList.remove("installing", "ready");
    label.textContent = state.clientNeedsUpdate
      ? playText("play.update")
      : playText("play.install");
    if (iconWrapper) iconWrapper.innerHTML = PLAY_ICON_INSTALL;
    return;
  }

  button.disabled = false;
  button.classList.remove("installing");
  button.classList.add("ready");
  label.textContent = playText("play.play");
  if (iconWrapper) iconWrapper.innerHTML = PLAY_ICON_PLAY;
}

/** Installs/repairs the game and, when it was already up to date, launches it. */
async function installThenMaybeLaunch(reason, options = {}) {
  console.log("[play] нужна проверка/докачка (" + reason + ")");
  state.lastInstallStatus = null;
  await installGame(options);
  await currentInstallPromise;

  console.log(
    "[play] проверка завершена: статус=" +
      state.lastInstallStatus +
      " установлено=" +
      state.clientInstalled,
  );

  const canLaunch =
    state.lastInstallStatus === "up_to_date" ||
    (options.smart && state.lastInstallStatus === "updated");
  if (canLaunch && state.clientInstalled && state.installPhase === "idle") {
    hideDownloadUi();
    await launchNow();
  }
}

async function launchNow() {
  console.log("[play] запуск игры");
  ui.btnPlayText.textContent = tr("play.launching");
  ui.btnPlay.disabled = true;

  if (window.electronAPI) {
    const result = await window.electronAPI.launchGame(state.installPath, state.launchArgs);
    if (!result?.launched) {
      ui.btnPlay.disabled = false;

      if (
        result?.error === "GAME_INCOMPLETE" ||
        result?.error === "GAME_EXE_INVALID" ||
        result?.error === "GAME_EXE_MISSING"
      ) {
        console.warn("[play] клиент неполный (" + result.error + ") — докачиваю");
        state.clientInstalled = false;
        state.clientNeedsUpdate = true;
        updatePlayButton();
        await installGame();
        return;
      }

      console.warn("[play] запуск не удался: " + result?.error + " " + (result?.message || ""));
      if (result?.message) {
        showErrorDialog({
          title: "Не удалось запустить игру",
          message: result.message,
          reportId: result.reportId,
        });
      }
      updatePlayButton();
      return;
    }
  }

  setTimeout(() => updatePlayButton(), 3000);
}

if (ui.btnPlay) {
  ui.btnPlay.addEventListener("click", async () => {
    console.log(
      "[play] нажато: фаза=" +
        state.installPhase +
        " steamBlocked=" +
        steamBlocked +
        " установлено=" +
        state.clientInstalled +
        " путь=" +
        (state.installPath ? "есть" : "нет"),
    );

    if (state.installPhase !== "idle" || steamBlocked) {
      console.warn("[play] пропуск: идёт установка или нет Steam");
      return;
    }

    if (!(await isSteamReady(true))) {
      console.warn("[play] Steam не готов");
      await handleSteamLost();
      return;
    }

    if (!state.clientInstalled) {
      await installThenMaybeLaunch("клиент не установлен/нужно обновление");
      return;
    }

    await installThenMaybeLaunch("проверка перед запуском", { smart: true });
  });
}

// ---------------------------------------------------------------------------
// Download progress / pause / cancel
// ---------------------------------------------------------------------------

let installGen = 0;
let pauseBusy = false;
let cancelBusy = false;

function renderPauseButton() {
  if (!ui.btnPause) return;
  if (state.downloadPaused) {
    ui.btnPause.classList.add("paused");
    ui.btnPause.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M8 5v14l11-7L8 5z" fill="currentColor"/></svg>';
    ui.btnPause.title = tr("download.resume");
  } else {
    ui.btnPause.classList.remove("paused");
    ui.btnPause.innerHTML =
      '<svg width="14" height="14" viewBox="0 0 24 24"><rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor"/><rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor"/></svg>';
    ui.btnPause.title = tr("download.pause");
  }
}

function hideDownloadUi() {
  if (ui.progressWrap) ui.progressWrap.style.display = "none";
  if (ui.btnPause) ui.btnPause.style.display = "none";
  if (ui.btnCancelDl) ui.btnCancelDl.style.display = "none";
  if (ui.progressFill) ui.progressFill.style.width = "0%";
}

if (ui.btnPause) {
  ui.btnPause.addEventListener("click", async () => {
    if (pauseBusy || cancelBusy) return;
    if (state.installPhase !== "downloading" && state.installPhase !== "paused") return;

    const generation = installGen;
    pauseBusy = true;
    try {
      if (!state.downloadPaused) {
        const result = await window.electronAPI?.pauseGameInstall?.();
        if (generation === installGen && result?.ok) {
          state.downloadPaused = true;
          state.installPhase = "paused";
        }
      } else {
        const result = await window.electronAPI?.resumeGameInstall?.();
        if (generation === installGen && result?.ok) {
          state.downloadPaused = false;
          state.installPhase = "downloading";
        }
      }
    } catch (error) {
      console.error("pause/resume install error:", error);
    } finally {
      pauseBusy = false;
    }
    if (generation !== installGen) return;

    renderPauseButton();
    if (state.downloadPaused) {
      if (ui.progressPhase) ui.progressPhase.textContent = "Пауза";
      if (ui.progressSpeed) ui.progressSpeed.textContent = tr("download.paused");
    } else if (ui.progressPhase) {
      ui.progressPhase.textContent = "Загрузка";
    }
    updatePlayButton();
  });
}

if (ui.btnCancelDl) {
  ui.btnCancelDl.addEventListener("click", async () => {
    if (cancelBusy || state.installPhase === "idle") return;
    cancelBusy = true;
    installGen++;

    if (ui.progressPhase) ui.progressPhase.textContent = "Отмена";
    if (ui.progressSpeed) ui.progressSpeed.textContent = "Останавливаем загрузку...";
    if (ui.btnPause) ui.btnPause.style.display = "none";

    try {
      await window.electronAPI?.cancelGameInstall?.();
    } catch (error) {
      console.error("cancel install error:", error);
    }

    state.downloading = false;
    state.downloadPaused = false;
    state.downloadCancelled = false;
    state.installCancelledByUser = false;
    state.installPhase = "idle";
    currentInstallPromise = null;
    latestGameInstallProgress = null;
    hideDownloadUi();
    renderPauseButton();
    cancelBusy = false;
    updatePlayButton();
  });
}

/**
 * Runs the install pipeline.
 *
 * @param {{
 *   deep?: boolean,
 *   smart?: boolean,
 *   resume?: boolean,
 *   helperAttempt?: number,
 *   helperNote?: string,
 *   issueReportId?: string | null,
 * }} [options]
 * @returns {Promise<void>}
 */
async function installGame(options = {}) {
  if (currentInstallPromise) return currentInstallPromise;
  if (cancelBusy) return;
  if (state.downloading && !options.resume) return;

  if (!options.resume) {
    let hasSavedPath = false;
    try {
      hasSavedPath = localStorage.getItem(INSTALL_PATH_KEY) !== null;
    } catch {
      // Ignore.
    }
    if (!hasSavedPath && window.electronAPI?.selectInstallPath) {
      const chosen = await window.electronAPI.selectInstallPath(window.i18n?.getLang?.() || "ru");
      if (!chosen) return;
      saveInstallPath(chosen);
    }
  }

  const generation = ++installGen;
  latestGameInstallProgress = null;
  state.downloading = true;
  state.downloadPaused = false;
  state.downloadCancelled = false;
  state.installCancelledByUser = false;
  state.installPhase = "preparing";
  renderPauseButton();
  updatePlayButton();

  if (ui.progressWrap) {
    ui.progressWrap.style.display = "block";
    ui.progressWrap.classList.add("fade-in");
  }
  if (ui.btnPause) ui.btnPause.style.display = "flex";
  if (ui.btnCancelDl) ui.btnCancelDl.style.display = "flex";
  if (ui.progressPhase) ui.progressPhase.textContent = "Подготовка";
  if (ui.progressText) ui.progressText.textContent = "0.0% · 0 B / 0 B";
  if (ui.progressSpeed) ui.progressSpeed.textContent = "Подготовка...";
  if (options.helperNote) {
    if (ui.progressPhase) ui.progressPhase.textContent = "Помощник";
    if (ui.progressSpeed) ui.progressSpeed.textContent = options.helperNote;
  }

  const helperAttempt = options.helperAttempt || 0;
  let followUp = null;

  currentInstallPromise = (async () => {
    try {
      if (!window.electronAPI?.installGame) throw new Error("installGame недоступен");

      const result = await window.electronAPI.installGame(state.installPath, generation, {
        deep: Boolean(options.deep),
        smart: Boolean(options.smart),
      });
      if (generation !== installGen) return;

      if (!result?.ok) {
        if (result?.cancelled) return;
        const helperInfo = result.helper || {};
        if (helperInfo.autoRetry && helperAttempt < 2) {
          followUp = { type: "retry", note: result.message };
          return;
        }
        const error = new Error(result?.message || "Ошибка установки");
        error.reportId = result.reportId;
        error.confirm = helperInfo.confirm;
        throw error;
      }

      state.clientInstalled = true;
      state.clientNeedsUpdate = false;
      state.installPhase = "idle";
      state.lastInstallStatus = result.status;

      if (options.deep) {
        const repaired = result.status === "updated";
        setTimeout(
          () =>
            showErrorDialog({
              title: repaired ? "Файлы восстановлены" : "Файлы игры целы",
              message: repaired
                ? "Повреждённые файлы игры скачаны заново. Попробуйте запустить игру ещё раз. Если не поможет — отправьте отчёт в поддержку."
                : "Все файлы игры проверены — повреждений нет, причина в другом. Отправьте отчёт в поддержку, мы разберёмся.",
              reportId: options.issueReportId,
            }),
          400,
        );
      }

      if (ui.progressPhase) ui.progressPhase.textContent = "Готово";
      if (ui.progressFill) ui.progressFill.style.width = "100%";
      if (ui.progressText) ui.progressText.textContent = "100%";
      if (ui.progressSpeed) ui.progressSpeed.textContent = tr("play.done");
      if (!(options.smart && result.status === "up_to_date")) sfx.success();

      setTimeout(() => {
        if (generation !== installGen || state.downloading) return;
        if (ui.progressWrap) ui.progressWrap.style.display = "none";
        updatePlayButton();
      }, 1500);
    } catch (error) {
      if (generation !== installGen) return;
      console.error("installGame error:", error);
      state.installPhase = "idle";
      sfx.error();

      if (!error.reportId) error.reportId = await reportUiError(error, "install-ui");

      if (error.confirm) {
        const yesLabel =
          {
            "zapret-fix": "Исправить",
            "close-game": "Закрыть игру",
            "choose-folder": "Выбрать папку",
          }[error.confirm.action] || "Да";

        const confirmed = await askDialog({
          message: error.message,
          question: error.confirm.question,
          yes: yesLabel,
          no: "Не сейчас",
          reportId: error.reportId,
        });
        if (confirmed) followUp = { type: error.confirm.action };
      } else {
        showErrorDialog({
          title: "Игра не скачалась",
          message: error.message,
          reportId: error.reportId,
        });
      }
    } finally {
      if (generation === installGen) {
        state.downloading = false;
        state.downloadPaused = false;
        state.downloadCancelled = false;
        state.installCancelledByUser = false;
        state.installPhase = "idle";
        if (ui.btnCancelDl) ui.btnCancelDl.style.display = "none";
        if (ui.btnPause) ui.btnPause.style.display = "none";
        renderPauseButton();
        currentInstallPromise = null;
        updatePlayButton();

        if (followUp) {
          const action = followUp;
          setTimeout(() => {
            runHelperFollowUp(action, helperAttempt).catch((error) =>
              console.error("helper follow-up:", error),
            );
          }, 300);
        }
      }
    }
  })();

  return currentInstallPromise;
}

/** Applies the action the user confirmed in the helper dialog. */
async function runHelperFollowUp(action, attempt) {
  if (action.type === "retry") {
    return installGame({ helperAttempt: attempt + 1, helperNote: action.note });
  }

  if (action.type === "zapret-fix") {
    const result = await window.electronAPI?.zapretFix?.();
    if (result?.ok) {
      return installGame({
        helperAttempt: attempt + 1,
        helperNote: "Помощник: zapret исправлен — продолжаю загрузку.",
      });
    }
    showErrorDialog({
      title: "Не получилось",
      message:
        "Не получилось исправить zapret сам.\n\nВыключите zapret, пока качается игра, и нажмите «Обновить». Потом его можно включить снова.",
    });
    return;
  }

  if (action.type === "close-game") {
    const result = await window.electronAPI?.helperAction?.("close-game");
    if (result?.ok) {
      return installGame({
        helperAttempt: attempt + 1,
        helperNote: "Помощник: игра закрыта — продолжаю обновление.",
      });
    }
    alert("Не удалось закрыть игру автоматически. Закройте её вручную и нажмите «Обновить».");
    return;
  }

  if (action.type === "choose-folder") {
    const chosen = await window.electronAPI?.selectInstallPath?.(window.i18n?.getLang?.() || "ru");
    if (chosen) {
      saveInstallPath(chosen);
      return installGame({
        helperAttempt: attempt + 1,
        helperNote: "Помощник: новая папка выбрана — начинаю установку.",
      });
    }
  }
}

async function reportUiError(error, area, context) {
  try {
    return await window.electronAPI?.reportError?.({
      message: error?.message || String(error),
      stack: error?.stack,
      area,
      context,
    });
  } catch {
    return null;
  }
}

function renderGameInstallProgress(progress) {
  if (!progress || !state.downloading) return;

  if (progress.phase === "verifying") {
    state.installPhase = "verifying";
    if (ui.progressPhase) ui.progressPhase.textContent = "Проверка";
    const percent =
      progress.total > 0 ? ((progress.checked / progress.total) * 100).toFixed(1) : "0.0";
    if (ui.progressFill) ui.progressFill.style.width = percent + "%";
    if (ui.progressText) ui.progressText.textContent = percent + "% · проверка файлов";
    if (ui.progressSpeed)
      ui.progressSpeed.textContent = "Проверка: " + progress.checked + "/" + progress.total;
    return;
  }

  if (progress.phase === "verifying-download") {
    state.installPhase = "verifying-download";
    if (ui.progressPhase) ui.progressPhase.textContent = "Проверка скачанного";
    const percent =
      progress.total > 0 ? ((progress.checked / progress.total) * 100).toFixed(1) : "0.0";
    if (ui.progressFill) ui.progressFill.style.width = percent + "%";
    if (ui.progressText) ui.progressText.textContent = percent + "% · проверка скачанного";
    if (ui.progressSpeed) {
      ui.progressSpeed.textContent =
        "Проверка скачанного: " + progress.checked + "/" + progress.total;
    }
    return;
  }

  if (progress.phase === "helper") {
    state.installPhase = "preparing";
    if (ui.progressPhase) ui.progressPhase.textContent = "Помощник";
    if (ui.progressSpeed) ui.progressSpeed.textContent = progress.text || "Помощник: ищу решение…";
    return;
  }

  if (progress.phase === "download_needed") {
    state.installPhase = "preparing";
    if (ui.progressPhase) ui.progressPhase.textContent = "Подготовка";
    if (ui.progressText) ui.progressText.textContent = "0.0% · подготовка загрузки";
    if (ui.progressSpeed)
      ui.progressSpeed.textContent = "К скачиванию: " + (progress.filesCount || 0) + " файлов";
    return;
  }

  if (progress.phase === "downloading") {
    state.installPhase = state.downloadPaused ? "paused" : "downloading";
    if (ui.progressPhase) {
      ui.progressPhase.textContent = state.downloadPaused
        ? "Пауза"
        : progress.source
          ? "Загрузка · " + progress.source
          : "Загрузка";
    }

    const total = progress.totalBytes || 0;
    const downloaded = progress.downloadedBytes || 0;
    const percent = total > 0 ? Math.min(100, (downloaded / total) * 100) : 0;
    if (ui.progressFill) ui.progressFill.style.width = percent.toFixed(1) + "%";
    if (ui.progressText) {
      ui.progressText.textContent =
        percent.toFixed(1) + "% · " + formatBytes(downloaded) + " / " + formatBytes(total);
    }

    const speed = progress.speedBps || 0;
    if (ui.progressSpeed) {
      const speedText = speed < 1024 ? "Подключение…" : (speed / 1024 / 1024).toFixed(1) + " МБ/с";
      const filesText = progress.totalFiles
        ? " — " + progress.completedFiles + "/" + progress.totalFiles
        : "";
      const etaText =
        !state.downloadPaused &&
        progress.etaSeconds != null &&
        isFinite(progress.etaSeconds) &&
        speed > 0
          ? " · осталось " + formatEta(progress.etaSeconds)
          : "";
      ui.progressSpeed.textContent = speedText + filesText + etaText;
    }
  }
}

// ---------------------------------------------------------------------------
// Server online counters
// ---------------------------------------------------------------------------

async function verifyFilesOnStart() {
  if (ui.btnPlay) ui.btnPlay.disabled = true;
  setPlayText("play.checkingFiles");
  await new Promise((resolve) => setTimeout(resolve, 500));

  try {
    if (window.electronAPI?.verifyFiles) {
      const result = await Promise.race([
        window.electronAPI.verifyFiles(state.installPath),
        new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error("verifyFiles timeout")), 60_000),
        ),
      ]);
      state.clientInstalled = Boolean(result?.installed);
      if (result?.filesToDownload > 0) {
        state.clientNeedsUpdate = true;
        state.clientUpdateInfo = result;
      } else {
        state.clientNeedsUpdate = false;
      }
    } else {
      state.clientInstalled = false;
    }
  } catch (error) {
    console.error("verifyFilesOnStart error:", error);
    state.clientInstalled = false;
  }
  updatePlayButton();
}

function startServerPolling() {
  if (serverRefreshTimer) return;
  fetchServerData();
  serverRefreshTimer = setInterval(fetchServerData, 15_000);
}

async function fetchServerData() {
  try {
    if (!window.electronAPI) {
      updateServerUI();
      return;
    }

    const [mainResult, combatResult] = await Promise.allSettled([
      window.electronAPI.fetchServerData(SERVER_IDS.MAIN),
      window.electronAPI.fetchServerData(SERVER_IDS.COMBAT),
    ]);

    if (mainResult.status === "fulfilled" && mainResult.value?.response) {
      const server = mainResult.value.response;
      state.servers.main = {
        name: server.hostname || server.name || "MAIN",
        online: server.numplayers || 0,
        joining: server.queueplayers || 0,
        max: server.maxplayers || 0,
        status: server.status,
        map: server.map || "—",
      };
    }

    if (combatResult.status === "fulfilled" && combatResult.value?.response) {
      const server = combatResult.value.response;
      state.servers.combat = {
        name: server.hostname || server.name || "COMBAT",
        online: server.numplayers || 0,
        joining: server.queueplayers || 0,
        max: server.maxplayers || 0,
        status: server.status,
        map: server.map || "—",
      };
    }

    updateServerUI();
  } catch (error) {
    console.error("Failed to fetch server data:", error);
  }
}

function animateCount(element, target, duration) {
  if (!element) return;
  const to = Number(target) || 0;
  const from = Number(element.dataset.countValue || element.textContent.replace(/\D/g, "")) || 0;
  if (from === to) {
    element.textContent = String(to);
    element.dataset.countValue = String(to);
    return;
  }

  const startedAt = performance.now();
  const totalDuration = duration || 500;
  const easeOutCubic = (progress) => 1 - Math.pow(1 - progress, 3);

  function frame(now) {
    const progress = Math.min(1, (now - startedAt) / totalDuration);
    const value = Math.round(from + (to - from) * easeOutCubic(progress));
    element.textContent = String(value);
    if (progress < 1) requestAnimationFrame(frame);
    else element.dataset.countValue = String(to);
  }
  requestAnimationFrame(frame);
}

function updateServerUI() {
  const { main, combat } = state.servers;
  const totalPlayers = (server) => (server.online || 0) + (server.joining || 0);

  animateCount(ui.totalOnline, totalPlayers(main) + totalPlayers(combat), 500);
  animateCount(ui.serverMainPlayers, totalPlayers(main), 500);
  if (ui.serverMainMax) ui.serverMainMax.textContent = main.max;
  if (ui.serverMainMap) ui.serverMainMap.textContent = main.map;
  if (ui.serverMainDot) {
    ui.serverMainDot.className = "server-status-dot " + (main.status ? "online" : "offline");
  }
  if (ui.serverMainName && main.name) {
    ui.serverMainName.textContent = main.name.replace(/^[A-Za-z0-9]+\s*\|\s*/i, "").trim();
  }

  animateCount(ui.serverCombatPlayers, totalPlayers(combat), 500);
  if (ui.serverCombatMax) ui.serverCombatMax.textContent = combat.max;
  if (ui.serverCombatMap) ui.serverCombatMap.textContent = combat.map;
  if (ui.serverCombatDot) {
    ui.serverCombatDot.className = "server-status-dot " + (combat.status ? "online" : "offline");
  }
  if (ui.serverCombatName && combat.name) {
    ui.serverCombatName.textContent = combat.name.replace(/^[A-Za-z0-9]+\s*\|\s*/i, "").trim();
  }
}

// ---------------------------------------------------------------------------
// FAQ and settings
// ---------------------------------------------------------------------------

document.querySelectorAll(".faq-question").forEach((question) => {
  question.addEventListener("click", () => {
    const faqId = question.getAttribute("data-faq");
    const answer = document.getElementById("faq-a-" + faqId);
    if (!answer) return;

    const isOpen = answer.classList.contains("open");
    document.querySelectorAll(".faq-answer").forEach((item) => item.classList.remove("open"));
    document.querySelectorAll(".faq-question").forEach((item) => item.classList.remove("active"));
    if (!isOpen) {
      answer.classList.add("open");
      question.classList.add("active");
    }
    sfx.toggle(!isOpen);
  });
});

if (ui.btnSettings) {
  ui.btnSettings.addEventListener("click", () => {
    if (ui.modalSettings) ui.modalSettings.style.display = "flex";
    sfx.sheet();
  });
}
if (ui.modalClose) {
  ui.modalClose.addEventListener("click", () => {
    if (ui.modalSettings) ui.modalSettings.style.display = "none";
  });
}
if (ui.modalSettings) {
  ui.modalSettings.addEventListener("click", (event) => {
    if (event.target === ui.modalSettings) ui.modalSettings.style.display = "none";
  });
}

if (ui.btnBrowse) {
  ui.btnBrowse.addEventListener("click", async () => {
    if (!window.electronAPI) return;
    const chosen = await window.electronAPI.selectInstallPath(window.i18n.getLang());
    if (chosen) saveInstallPath(chosen);
  });
}

if (ui.installPathInput) {
  ui.installPathInput.addEventListener("change", () => {
    const value = String(ui.installPathInput.value || "").trim();
    if (value) saveInstallPath(value);
  });
}

if (ui.launchArgsInput) {
  ui.launchArgsInput.addEventListener("input", () => {
    saveLaunchArgs(String(ui.launchArgsInput.value || ""));
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ui.modalSettings) {
    ui.modalSettings.style.display = "none";
  }
});

if (ui.settingLang) {
  ui.settingLang.addEventListener("change", () => {
    window.i18n.setLang(ui.settingLang.value);
  });
}

// ---------------------------------------------------------------------------
// Help / diagnostics block
// ---------------------------------------------------------------------------

(() => {
  const diagnoseButton = document.getElementById("btn-net-diagnose");
  const statusBox = document.getElementById("net-diagnose-status");
  if (!diagnoseButton || !statusBox) return;

  const setStatus = (text, className) => {
    statusBox.style.display = "block";
    statusBox.className = "setting-hint" + (className ? " " + className : "");
    statusBox.textContent = text;
  };

  window.electronAPI?.onNetDiagnoseProgress?.((event) => {
    if (diagnoseButton.disabled && event?.text) setStatus(event.text);
  });

  diagnoseButton.addEventListener("click", async () => {
    if (diagnoseButton.disabled) return;
    diagnoseButton.disabled = true;
    setStatus("Проверяю соединение с серверами…");
    try {
      const result = await window.electronAPI?.diagnoseNetwork?.(state.installPath);
      const reportSuffix = result?.reportId ? "\nКод отчёта: " + result.reportId : "";
      setStatus(
        "" + (result?.message || "Не удалось выполнить проверку.") + reportSuffix,
        result?.ok ? "ok" : "bad",
      );
    } catch (error) {
      setStatus("Не удалось выполнить проверку: " + (error?.message || error), "bad");
    } finally {
      diagnoseButton.disabled = false;
    }
  });

  document.getElementById("btn-open-reports")?.addEventListener("click", () => {
    window.electronAPI?.openReportsFolder?.();
  });

  const gameDiagnoseButton = document.getElementById("btn-game-diagnose");
  gameDiagnoseButton?.addEventListener("click", async () => {
    if (gameDiagnoseButton.disabled) return;
    gameDiagnoseButton.disabled = true;
    setStatus("Проверяю, что мешает игре…");

    try {
      const result = await window.electronAPI?.diagnoseGame?.(state.installPath);
      statusBox.style.display = "none";

      let message;
      if (result?.missingKeyFiles?.length) {
        message = "Не хватает файлов игры. Нажмите «Играть» — лаунчер докачает их.";
      } else if (result?.running && result?.noWindow) {
        message = "Игра зависла и не открылась.";
      } else if (result?.running) {
        message = "Игра уже запущена.";
      } else if (result?.vcRuntime === false) {
        message = "Игре не хватает программы от Microsoft (Visual C++).";
      } else if (result?.steamFail) {
        message =
          "Игра не видит Steam. Закройте Steam полностью (Steam → Выход), откройте снова и нажмите «Играть».";
      } else {
        message = "Явной причины не нашёл.";
      }
      message += "\n\nНажмите «Отправить в поддержку» — мы посмотрим и поможем.";

      if (ui.modalSettings) ui.modalSettings.style.display = "none";

      if (result?.running && result?.noWindow) {
        const shouldClose = await askDialog({
          title: "Игра зависла",
          message: "Игра зависла и не открылась.",
          question: "Закрыть её?",
          yes: "Закрыть",
          no: "Не сейчас",
        });
        if (shouldClose) await window.electronAPI?.helperAction?.("close-game");
      }

      showErrorDialog({ title: "Что мешает игре", message, reportId: result?.reportId });
    } catch (error) {
      setStatus("Не удалось собрать сведения: " + (error?.message || error), "bad");
    } finally {
      gameDiagnoseButton.disabled = false;
    }
  });
})();

// ---------------------------------------------------------------------------
// Language changes
// ---------------------------------------------------------------------------

window.addEventListener("languagechange", () => {
  if (!state.steamAuthed) {
    if (ui.userName) ui.userName.textContent = tr("auth.notAuthorized");
    if (ui.btnSteamAuth) {
      ui.btnSteamAuth.innerHTML = window.i18n.getSteamBtnHtml();
      ui.btnSteamAuth.style.display = "";
    }
  } else {
    if (ui.userName && state.steamUser?.name) {
      ui.userName.textContent = state.steamUser.name;
    }
    if (ui.btnSteamAuth) ui.btnSteamAuth.style.display = "none";
  }

  if (ui.btnLogout) ui.btnLogout.textContent = tr("auth.logout");
  if (ui.btnSteamRetry) ui.btnSteamRetry.textContent = tr("steamGate.retry");

  if (
    ui.launcherUpdateGate &&
    !ui.launcherUpdateGate.classList.contains("is-hidden") &&
    ui.launcherUpdateMessage
  ) {
    ui.launcherUpdateMessage.textContent = tr("launcherUpdate.checking");
  }

  if (
    ui.steamGate &&
    !ui.steamGate.classList.contains("is-hidden") &&
    ui.steamGate.classList.contains("is-error")
  ) {
    if (ui.steamGateMessage) ui.steamGateMessage.textContent = tr(getSteamGateMessageKey());
  } else if (
    ui.steamGate &&
    !ui.steamGate.classList.contains("is-hidden") &&
    !ui.steamGate.classList.contains("is-error")
  ) {
    if (ui.steamGateMessage) ui.steamGateMessage.textContent = tr("steamGate.checking");
  }

  updatePlayButton();
});

// ---------------------------------------------------------------------------
// Initialisation
// ---------------------------------------------------------------------------

/** Subscribes to "game did not start" events from the main process. */
function subscribeGameLaunchIssue() {
  window.electronAPI.onGameLaunchIssue?.(async (issue) => {
    try {
      sfx.error();
    } catch {
      // Ignore.
    }

    const ask = (question, yesLabel) =>
      askDialog({
        title: "Игра не открылась",
        message: issue.message,
        question,
        yes: yesLabel,
        no: "Не сейчас",
        reportId: issue.reportId,
      });

    if (issue.suggest === "repair" && state.installPhase === "idle") {
      if (await ask("Проверить файлы игры и починить? Это займёт несколько минут.", "Починить")) {
        await installGame({
          deep: true,
          issueReportId: issue.reportId,
          helperNote: "Помощник: проверяю файлы игры…",
        });
        return;
      }
    } else if (issue.suggest === "elevated") {
      if (
        await ask(
          "Попробовать запустить по-другому? Windows спросит разрешение — нажмите «Да».",
          "Попробовать",
        )
      ) {
        const result = await window.electronAPI?.launchGame?.(state.installPath, state.launchArgs, {
          elevated: true,
        });
        if (result && !result.launched && result.message) {
          showErrorDialog({
            title: "Игра не запустилась",
            message: result.message,
            reportId: result.reportId,
          });
        }
        return;
      }
    } else if (issue.suggest === "close-repair" && state.installPhase === "idle") {
      if (await ask("Закрыть игру и починить файлы? Это займёт несколько минут.", "Починить")) {
        await window.electronAPI?.helperAction?.("close-game");
        await installGame({
          deep: true,
          issueReportId: issue.reportId,
          helperNote: "Помощник: игра закрыта, проверяю файлы…",
        });
        return;
      }
    } else if (issue.suggest === "vcredist") {
      if (
        await ask(
          "Скачать её с сайта Microsoft? Потом установите и снова нажмите «Играть».",
          "Скачать",
        )
      ) {
        await window.electronAPI?.helperAction?.("open-vcredist");
        return;
      }
    }

    const titles = {
      "not-started": "Игра не запустилась",
      hung: "Игра зависла",
    };
    showErrorDialog({
      title: titles[issue.kind] || "Игра закрылась",
      message: issue.message,
      reportId: issue.reportId,
    });
  });
}

async function init() {
  loadInstallPath();
  loadLaunchArgs();

  // Decorative sounds; hover sound is throttled.
  document.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button, .btn") : null;
    if (!button || button.disabled) return;
    if (button.matches(".faq-question, #btn-settings")) return;
    playUiClick();
  });
  document.addEventListener("mouseover", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button, .btn") : null;
    if (!button || button.disabled || button.__woohHoverArmed) return;
    button.__woohHoverArmed = true;
    playUiHover();
  });
  document.addEventListener("mouseout", (event) => {
    const button = event.target instanceof Element ? event.target.closest("button, .btn") : null;
    if (button) button.__woohHoverArmed = false;
  });

  try {
    if (window.i18n) {
      window.i18n.loadLang();
      if (ui.settingLang) ui.settingLang.value = window.i18n.getLang();
      if (ui.btnSteamAuth) ui.btnSteamAuth.innerHTML = window.i18n.getSteamBtnHtml();
    }
  } catch (error) {
    console.error("i18n init error:", error);
  }

  if (ui.installPathInput) ui.installPathInput.value = state.installPath;
  if (ui.launchArgsInput) ui.launchArgsInput.value = state.launchArgs;

  if (window.electronAPI?.onGameInstallProgress) {
    subscribeGameLaunchIssue();
    window.electronAPI.onGameInstallProgress((progress) => {
      if (progress && progress.token !== undefined && progress.token !== installGen) return;
      latestGameInstallProgress = progress;
    });
  }

  if (!gameInstallProgressTimer) {
    gameInstallProgressTimer = setInterval(() => {
      if (latestGameInstallProgress) renderGameInstallProgress(latestGameInstallProgress);
    }, 200);
  }

  startSteamWatch();
  await checkZapretOnStart();

  if (!(await runLauncherSelfUpdate())) return;
  if (!(await checkSteamRunning())) return;
  await continueLauncherInit();
}

function boot() {
  try {
    startServerPolling();
  } catch (error) {
    console.error("server polling failed:", error);
  }

  try {
    init().catch((error) => {
      console.error("init failed:", error);
      updatePlayButton();
    });
  } catch (error) {
    console.error("boot failed:", error);
    updatePlayButton();
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
