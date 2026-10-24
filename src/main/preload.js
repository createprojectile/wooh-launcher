"use strict";

/**
 * Preload bridge.
 *
 * Exposes a narrow, typed-by-convention API to the renderer through
 * `contextBridge`. The renderer has no Node.js access (contextIsolation is on,
 * nodeIntegration is off); every operation goes through an IPC channel listed
 * here.
 */

const { contextBridge, ipcRenderer } = require("electron");

/**
 * Subscribes to a main-process event.
 * @param {string} channel
 * @param {(payload: any) => void} callback
 * @returns {() => void} Unsubscribe function.
 */
function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld("electronAPI", {
  // Window controls
  minimize: () => ipcRenderer.send("window-minimize"),
  close: () => ipcRenderer.send("window-close"),

  // Steam
  steamAuth: () => ipcRenderer.invoke("steam-auth"),
  isSteamRunning: () => ipcRenderer.invoke("is-steam-running"),

  // Servers
  fetchServerData: (serverId) => ipcRenderer.invoke("fetch-server-data", serverId),

  // Install / update
  selectInstallPath: (language) => ipcRenderer.invoke("select-install-path", language),
  verifyFiles: (installPath) => ipcRenderer.invoke("verify-files", installPath),
  quickCheckLocal: (installPath) => ipcRenderer.invoke("verify-files-local", installPath),
  installGame: (installPath, token, options) =>
    ipcRenderer.invoke("install-game", installPath, token, options),
  pauseGameInstall: () => ipcRenderer.invoke("install-game-pause"),
  resumeGameInstall: () => ipcRenderer.invoke("install-game-resume"),
  cancelGameInstall: () => ipcRenderer.invoke("install-game-cancel"),
  onGameInstallProgress: (callback) => subscribe("game-install-progress", callback),

  // Launch
  launchGame: (installPath, launchArgs, options) =>
    ipcRenderer.invoke("launch-game", installPath, launchArgs, options),
  onGameLaunchIssue: (callback) => subscribe("game-launch-issue", callback),

  // Helpers / diagnostics
  helperAction: (action) => ipcRenderer.invoke("helper-action", action),
  reportError: (payload) => ipcRenderer.invoke("report-error", payload),
  diagnoseNetwork: (installPath) => ipcRenderer.invoke("net-diagnose", installPath),
  onNetDiagnoseProgress: (callback) => subscribe("net-diagnose-progress", callback),
  diagnoseGame: (installPath) => ipcRenderer.invoke("game-diagnose", installPath),
  zapretDetect: () => ipcRenderer.invoke("zapret-detect"),
  zapretFix: () => ipcRenderer.invoke("zapret-fix"),

  // Support
  openReportsFolder: () => ipcRenderer.invoke("open-reports-folder"),
  supportSend: (reportId, channel) => ipcRenderer.invoke("support-send", reportId, channel),
  supportLinks: () => ipcRenderer.invoke("support-links"),

  // Launcher self-update
  launcherUpdate: () => ipcRenderer.invoke("launcher-update"),
  onLauncherUpdateProgress: (callback) => subscribe("launcher-update-progress", callback),
});
