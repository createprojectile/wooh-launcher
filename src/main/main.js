"use strict";

/**
 * WoohProject Launcher – Electron main process.
 *
 * Responsibilities:
 *  - creates the frameless main window and the preload bridge;
 *  - exposes IPC handlers used by the renderer (Steam auth, servers, install,
 *    launch, diagnostics, support);
 *  - orchestrates the game update pipeline (verify -> download -> verify);
 *  - launches RustClient.exe (normally, or elevated when Windows requires it);
 *  - watches the game after launch and reports why it did not start.
 *
 * The module is intentionally self-contained: all long-running services live
 * in sibling files and are wired together here.
 */

const { app, BrowserWindow, ipcMain, dialog, net, shell, clipboard } = require("electron");
const dgram = require("dgram");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const {
  getSteamState,
  resolveActiveSteamProfile,
  prewarmSteamSessionTicket,
} = require("./steam-service");
const { applyPendingUpdateIfNeeded, runLauncherUpdate } = require("./launcher-update");
const {
  prepareGameInstall,
  verifyDownloadedFiles,
  verifyGame,
  createGameDownloader,
} = require("./game-update");
const { isPlayerFile, resolveInstallPath } = require("./integrity");
const crypto = require("crypto");
const bugReport = require("./bug-report");
const transport = require("./net-transport");
const helper = require("./helper");
const doctor = require("./net-doctor");
const gameWatch = require("./game-watch");
const zapret = require("./zapret-fix");

const config = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf-8"));
const APP_ICON = path.join(__dirname, "icon.ico");

/** @type {BrowserWindow | null} */
let mainWindow = null;

/**
 * The currently running install. Only one install may run at a time.
 * @type {null | {
 *   id: number,
 *   stage?: string,
 *   manifest?: any,
 *   bytesTotal?: number,
 *   downloader: any,
 *   cancelRequested: false | "PAUSED" | "CANCELLED",
 *   settled: Promise<void>,
 * }}
 */
let activeInstall = null;
let installSequence = 0;

/** Set when the gamemonitoring.ru API starts failing, so we only warn once. */
let serverApiFailing = false;
let lastLaunchAt = 0;
/** @type {null | { pid: number, code: number | null, signal: string | null, at: number }} */
let lastGameExit = null;

// ---------------------------------------------------------------------------
// Logging / crash reporting
// ---------------------------------------------------------------------------

bugReport.init(config, () => {
  const zapretState = zapret.status();
  return {
    network: transport.current(),
    installRunning: Boolean(activeInstall),
    zapret: zapretState
      ? {
          tools: zapretState.tools,
          canFix: zapretState.canFix,
          alreadyFixed: zapretState.alreadyFixed,
        }
      : null,
  };
});

// Chromium's HTTP/2 and QUIC stacks are unreliable through some DPI/VPN
// setups used by the target audience, so the launcher forces HTTP/1.1 + TCP.
app.commandLine.appendSwitch("disable-http2");
app.commandLine.appendSwitch("disable-quic");

process.on("uncaughtException", (error) => {
  console.error("uncaughtException:", error);
  bugReport.report(error, { area: "uncaught-exception" });
});
process.on("unhandledRejection", (error) => {
  console.error("unhandledRejection:", error);
  bugReport.report(error, { area: "unhandled-rejection" });
});

// ---------------------------------------------------------------------------
// Manifest caches (per install path)
// ---------------------------------------------------------------------------

/** Removes server URLs from a message before it is shown to the user. */
function publicMessage(message) {
  return String(message ?? "")
    .replace(/https?:\/\/[^\s"'<>)]+/gi, "[сервер]")
    .replace(/\b[\w.-]*huggingface\.co[^\s"'<>)]*/gi, "[сервер]")
    .replace(/\b[\w.-]+\.hf\.co\b[^\s"'<>)]*/gi, "[сервер]")
    .replace(/\bdatasets\/[\w.-]+\/[\w.-]+[^\s"'<>)]*/gi, "[сервер]");
}

/** Returns the cached-manifest path for an install directory (creating the folder). */
function manifestCachePath(installPath) {
  const cacheDir = path.join(app.getPath("userData"), "manifests");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    // Ignore: the write below will fail with a useful error.
  }
  const key = crypto
    .createHash("sha1")
    .update(path.resolve(installPath))
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheDir, "manifest-" + key + ".json");
}

/** Stores the manifest for offline verification (the internal `__source` is stripped). */
function writeManifestCache(installPath, manifest) {
  if (!installPath || !manifest || !Array.isArray(manifest.files)) return;
  try {
    const serializable = { ...manifest };
    delete serializable.__source;
    fs.writeFileSync(manifestCachePath(installPath), JSON.stringify(serializable), "utf-8");
    tryRemoveLegacyManifest(installPath);
  } catch (error) {
    console.warn("manifest cache write failed:", error);
  }
}

function readManifestCache(installPath) {
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestCachePath(installPath), "utf-8"));
    return manifest && Array.isArray(manifest.files) ? manifest : null;
  } catch {
    return null;
  }
}

function verifiedCachePath(installPath) {
  return manifestCachePath(installPath).replace(/manifest-([0-9a-f]+)\.json$/, "verified-$1.json");
}

/** Reads the cache of already-verified files ({ path: { size, mtimeMs, sha256 } }). */
function readVerifiedCache(installPath) {
  try {
    return JSON.parse(fs.readFileSync(verifiedCachePath(installPath), "utf-8")) || {};
  } catch {
    return {};
  }
}

function writeVerifiedCache(installPath, verified) {
  try {
    fs.writeFileSync(verifiedCachePath(installPath), JSON.stringify(verified || {}), "utf-8");
  } catch (error) {
    console.warn("verified cache write failed:", error);
  }
}

/** Adds freshly verified files to the cache. */
function markVerified(installPath, verified, files) {
  const next = { ...(verified || {}) };
  for (const file of files || []) {
    try {
      const stats = fs.statSync(resolveInstallPath(installPath, file.path));
      next[file.path] = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        sha256: file.sha256,
      };
    } catch {
      // The file disappeared between download and verification.
    }
  }
  return next;
}

/** Older launcher versions stored the manifest inside the install directory. */
function tryRemoveLegacyManifest(installPath) {
  const legacy = path.join(installPath, ".woohlauncher-manifest.json");
  try {
    if (fs.existsSync(legacy)) fs.unlinkSync(legacy);
  } catch {
    // Ignore: not critical.
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

if (process.platform === "win32") {
  app.setAppUserModelId("com.woohproject.launcher");
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 700,
    resizable: false,
    frame: false,
    show: false,
    backgroundColor: "#0d0d0d",
    center: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
    icon: APP_ICON,
  });

  bugReport.attachRenderer(mainWindow.webContents);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.webContents.on("before-input-event", (_event, input) => {
    if (input.key === "F12" && input.type === "keyDown") {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("Load failed:", errorCode, errorDescription);
  });

  // All external links open in the user's browser, never inside the launcher.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://") && url !== mainWindow.webContents.getURL()) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

/** Creates a desktop shortcut on first run of the packaged app. */
function ensureDesktopShortcut() {
  if (process.platform !== "win32" || !app.isPackaged) return;
  try {
    const desktop = app.getPath("desktop");
    const shortcutPath = path.join(desktop, "WoohProject Launcher.lnk");
    const target = process.execPath;

    let alreadyValid = false;
    if (fs.existsSync(shortcutPath)) {
      try {
        alreadyValid =
          path.resolve(shell.readShortcutLink(shortcutPath).target).toLowerCase() ===
          path.resolve(target).toLowerCase();
      } catch {
        alreadyValid = false;
      }
    }
    if (alreadyValid) return;

    const created = shell.writeShortcutLink(
      shortcutPath,
      fs.existsSync(shortcutPath) ? "replace" : "create",
      {
        target,
        cwd: path.dirname(target),
        icon: target,
        iconIndex: 0,
        description: "WoohProject Launcher",
        appUserModelId: "com.woohproject.launcher",
      },
    );
    console.log(
      "[shortcut] ярлык на рабочем столе " +
        (created ? "создан" : "НЕ удалось создать") +
        ": " +
        shortcutPath,
    );
  } catch (error) {
    console.error("ensureDesktopShortcut error:", error);
  }
}

app.whenReady().then(async () => {
  try {
    const applied = await applyPendingUpdateIfNeeded();
    if (applied) console.log("Pending launcher update applied");
  } catch (error) {
    console.error("applyPendingUpdateIfNeeded error:", error);
  }

  try {
    await transport.init();
  } catch (error) {
    console.error("transport init error:", error);
  }

  ensureDesktopShortcut();
  createWindow();
});

app.on("window-all-closed", () => app.quit());

// ---------------------------------------------------------------------------
// Window controls
// ---------------------------------------------------------------------------

ipcMain.on("window-minimize", () => {
  if (mainWindow) mainWindow.minimize();
});
ipcMain.on("window-close", () => {
  if (mainWindow) mainWindow.close();
});

// ---------------------------------------------------------------------------
// Zapret (DPI bypass) helpers
// ---------------------------------------------------------------------------

ipcMain.handle("zapret-detect", async () => {
  try {
    return await zapret.detect();
  } catch (error) {
    console.warn("[zapret] проверка не удалась:", error?.message);
    return { tools: [], canFix: false };
  }
});

ipcMain.handle("zapret-fix", async () => {
  try {
    return await zapret.applyFix();
  } catch (error) {
    console.warn("[zapret] исправить не удалось:", error?.message);
    return { ok: false };
  }
});

// ---------------------------------------------------------------------------
// Steam
// ---------------------------------------------------------------------------

ipcMain.handle("is-steam-running", async () => {
  try {
    return await getSteamState();
  } catch (error) {
    console.error("is-steam-running error:", error);
    return { running: false, loggedIn: false, ready: false };
  }
});

ipcMain.handle("steam-auth", async () => {
  try {
    const profile = await resolveActiveSteamProfile();
    if (profile?.steamId && config.steamAuth?.appId) {
      prewarmSteamSessionTicket(config.steamAuth.appId);
    }
    return profile;
  } catch (error) {
    console.error("Steam auth error:", error);
    return null;
  }
});

// ---------------------------------------------------------------------------
// Server query (A2S / gamemonitoring fallback)
// ---------------------------------------------------------------------------

/**
 * Sends an A2S_INFO request to a Source-engine server and parses the reply.
 * Handles the challenge-response handshake used by newer servers.
 *
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 */
function querySourceServer(host, port, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    const request = Buffer.concat([
      Buffer.from([255, 255, 255, 255, 84]),
      Buffer.from("Source Engine Query\0"),
    ]);

    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      reject(new Error("таймаут"));
    }, timeoutMs);

    socket.on("error", (error) => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }
      reject(error);
    });

    socket.on("message", (message) => {
      // 0x41 'A' = challenge packet: repeat the request with the challenge bytes.
      if (message[4] === 65) {
        socket.send(Buffer.concat([request, message.subarray(5, 9)]), port, host);
        return;
      }

      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Already closed.
      }

      try {
        let offset = 6;
        const readString = () => {
          const end = message.indexOf(0, offset);
          const value = message.toString("utf8", offset, end);
          offset = end + 1;
          return value;
        };

        const name = readString();
        const map = readString();
        readString(); // folder
        readString(); // game
        offset += 2; // app id (short)

        const reportedPlayers = message[offset++];
        const reportedMaxPlayers = message[offset++];
        offset += 5; // bots, server type, environment, visibility, VAC
        readString(); // version

        const extraFlags = message[offset++];
        if (extraFlags & 128) offset += 2; // port
        if (extraFlags & 16) offset += 8; // SteamID
        if (extraFlags & 64) {
          offset += 2; // SourceTV port
          readString(); // SourceTV name
        }
        const keywords = extraFlags & 32 ? readString() : "";

        const readKeyword = (keyword) => {
          const match = keywords.match(new RegExp("(?:^|,)" + keyword + "(\\d+)"));
          return match ? Number(match[1]) : null;
        };

        const currentPlayers = readKeyword("cp") ?? reportedPlayers;
        resolve({
          hostname: name,
          map,
          numplayers: currentPlayers,
          queueplayers: Math.max(0, reportedPlayers - currentPlayers, readKeyword("qp") || 0),
          maxplayers: readKeyword("mp") ?? reportedMaxPlayers,
          status: true,
          source: "a2s",
        });
      } catch (error) {
        reject(error);
      }
    });

    socket.send(request, port, host);
  });
}

/**
 * Returns live server info: direct A2S query when the address is configured,
 * otherwise the gamemonitoring.ru HTTP API.
 */
ipcMain.handle("fetch-server-data", async (_event, serverId) => {
  const configuredAddress = config?.serverQuery?.[String(serverId)];
  if (configuredAddress) {
    const [host, port] = String(configuredAddress).split(":");
    try {
      return { response: await querySourceServer(host, Number(port)) };
    } catch {
      // Fall through to the public monitoring API.
    }
  }

  return new Promise((resolve) => {
    if (!serverId) {
      resolve(null);
      return;
    }

    const fail = (reason) => {
      if (!serverApiFailing) {
        console.warn("[servers] мониторинг онлайна недоступен: " + reason);
      }
      serverApiFailing = true;
      resolve(null);
    };

    const request = net.request("https://api.gamemonitoring.ru/servers/" + serverId);
    let body = "";
    request.on("response", (response) => {
      response.on("data", (chunk) => {
        body += chunk.toString();
      });
      response.on("error", (error) => fail(error?.message));
      response.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          if (serverApiFailing) console.log("[servers] мониторинг снова доступен");
          serverApiFailing = false;
          resolve(parsed);
        } catch {
          fail("некорректный ответ");
        }
      });
    });
    request.on("error", (error) => fail(error?.message));
    request.end();
  });
});

/** Opens a folder picker and returns the chosen install directory. */
ipcMain.handle("select-install-path", async (_event, language) => {
  const title = language === "en" ? "Select install folder" : "Выберите папку для установки";
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory"],
    title,
  });
  if (result.canceled) return null;

  const selected = result.filePaths[0];
  if (!selected) return null;

  const installPath =
    path.basename(selected).toLowerCase() === "woohrustclient"
      ? selected
      : path.join(selected, "WoohRustClient");
  try {
    fs.mkdirSync(installPath, { recursive: true });
  } catch (error) {
    console.error("mkdir install path failed:", error);
  }
  return installPath;
});

// ---------------------------------------------------------------------------
// Launcher self-update
// ---------------------------------------------------------------------------

ipcMain.handle("launcher-update", async () => {
  try {
    const result = await runLauncherUpdate(config.launcherUpdate, mainWindow?.webContents);

    if (result && result.ok === false && result.message) {
      console.error("launcher-update failed (" + result.status + "): " + result.message);
      result.reportId = bugReport.report(new Error(result.message), {
        area: "launcher-update",
        status: result.status,
      });
    }
    if (result && result.message) result.message = publicMessage(result.message);
    return result;
  } catch (error) {
    console.error("launcher-update error:", error);
    const reportId = bugReport.report(error, { area: "launcher-update" });
    return {
      ok: false,
      status: "error",
      message: publicMessage(error.message),
      reportId,
    };
  }
});

// ---------------------------------------------------------------------------
// Game installation
// ---------------------------------------------------------------------------

ipcMain.handle("verify-files", async (_event, installPath) => {
  try {
    if (!installPath || !fs.existsSync(installPath)) {
      return {
        verified: false,
        installed: false,
        message: "Папка установки не задана",
      };
    }

    const result = await verifyGame(config, installPath);
    if (result.installed) writeManifestCache(installPath, result.manifest);

    return {
      verified: result.installed,
      installed: result.installed,
      missing: result.missing.length,
      corrupted: result.corrupted.length,
      valid: result.valid,
      total: result.total,
      filesToDownload: result.filesToDownload?.length ?? 0,
    };
  } catch (error) {
    console.error("verify-files error:", error);
    return {
      verified: false,
      installed: false,
      message: publicMessage(error.message),
    };
  }
});

/** Deletes leftover `.download` / `.wooh-old-*` files from previous runs. */
function removeLegacyDownloadTemps(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      removeLegacyDownloadTemps(fullPath);
      continue;
    }
    if (
      /\.download(\.part\d+)?(\.download)?$/i.test(entry.name) ||
      /\.wooh-old-\d+$/i.test(entry.name)
    ) {
      try {
        fs.unlinkSync(fullPath);
      } catch {
        // Ignore locked files.
      }
    }
  }
}

function deleteStagedCorrupted(installPath, result) {
  for (const file of result?.corrupted || []) {
    try {
      fs.unlinkSync(resolveInstallPath(installPath, file.path));
    } catch {
      // Ignore.
    }
  }
}

/**
 * Builds the list of "targets" for the network doctor: the manifest plus one
 * large file, so a mirror is only considered healthy when it can actually
 * serve a sustained download.
 *
 * @param {any} manifest
 * @param {string} installPath
 * @param {string} [preferredFile]
 */
function doctorTargets(manifest, installPath, preferredFile) {
  let effectiveManifest = manifest;
  if (!effectiveManifest && installPath) {
    try {
      effectiveManifest = JSON.parse(fs.readFileSync(manifestCachePath(installPath), "utf-8"));
    } catch {
      // No cache: only the manifest will be probed.
    }
  }

  let manifestPath = config.gameCdn?.manifestPath || "/manifest.json";
  if (!manifestPath.startsWith("/")) manifestPath = "/" + manifestPath;

  const sampleFile =
    preferredFile ||
    effectiveManifest?.files?.find((file) => file.size > 8_000_000 && file.size < 64_000_000)?.path;
  const sampleUrl = sampleFile
    ? "/" + sampleFile.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/")
    : null;

  return (config.gameCdn?.mirrors || [])
    .map((mirror, index) => ({
      name: mirror?.name || "HF #" + (index + 1),
      url: String(mirror?.url || mirror || "").replace(/\/$/, ""),
    }))
    .filter((source) => /^https?:\/\//i.test(source.url))
    .map((source) => ({
      name: source.name,
      urls: [
        source.url + manifestPath,
        ...(sampleUrl ? [{ url: source.url + sampleUrl, sustained: true }] : []),
      ],
    }));
}

/** Runs the recovery helper and files a bug report for a failed install. */
async function assistInstallError(error, install, installPath, sendProgress) {
  let fix = { kind: "unknown", autoRetry: false, message: null };
  try {
    fix = await helper.tryFix(error, {
      installPath,
      targets: doctorTargets(install.manifest, installPath, error?.filePath),
      failedFile: error?.filePath,
      bytesNeeded: install.bytesTotal
        ? Math.max(0, install.bytesTotal - (install.downloader?.downloadedBytes || 0))
        : 0,
      onProgress: (text) => sendProgress({ phase: "helper", text }),
      shouldStop: () => install.cancelRequested === "CANCELLED",
    });
  } catch (helperError) {
    console.error("helper failed:", helperError);
  }

  const reportId = bugReport.report(error, {
    area: "install-game",
    stage: install.stage,
    details: error?.details,
    helper: {
      kind: fix.kind,
      autoRetry: fix.autoRetry,
      message: fix.message,
      diagnosis: fix.diagnosis,
    },
  });

  return {
    ok: false,
    message: publicMessage(fix.message || error?.message || String(error)),
    reportId,
    helper: {
      kind: fix.kind,
      autoRetry: Boolean(fix.autoRetry),
      confirm: fix.confirm || null,
    },
  };
}

/**
 * Installs or updates the game.
 *
 * Modes:
 *  - normal: quick size check, download only what is missing;
 *  - `deep`: full SHA-256 check, re-download corrupted files;
 *  - `smart`: trust the verified cache, re-hash only critical/changed files
 *    (used before every launch).
 */
ipcMain.handle("install-game", async (_event, installPath, token, options = {}) => {
  // A new install supersedes the previous one.
  const previous = activeInstall;
  if (previous) {
    previous.cancelRequested = "CANCELLED";
    previous.downloader?.cancel();
    try {
      await previous.settled;
    } catch {
      // Ignore.
    }
  }

  let settle;
  const install = {
    id: ++installSequence,
    downloader: null,
    cancelRequested: false,
    settled: new Promise((resolve) => {
      settle = resolve;
    }),
  };
  activeInstall = install;

  const webContents = mainWindow?.webContents;
  const sendProgress = (payload) => {
    if (webContents && !webContents.isDestroyed()) {
      webContents.send("game-install-progress", { ...payload, token });
    }
  };
  const cancelledResult = {
    ok: false,
    cancelled: true,
    message: "Установка отменена",
  };

  /** Sends progress and throws when the user pressed Cancel. */
  const checkCancelled = (payload) => {
    if (install.cancelRequested === "CANCELLED") {
      const error = new Error("Отменено");
      error.code = "CANCELLED";
      throw error;
    }
    sendProgress(payload);
  };

  try {
    install.stage = "prepare";
    if (!installPath) {
      return { ok: false, message: "Папка установки не задана" };
    }
    fs.mkdirSync(installPath, { recursive: true });
    removeLegacyDownloadTemps(installPath);

    const smart = Boolean(options.smart) && !options.deep;
    const cachedManifest = smart ? readManifestCache(installPath) : null;
    const verifyStartedAt = Date.now();

    const prepared = await prepareGameInstall(config, installPath, checkCancelled, {
      deep: Boolean(options.deep),
      smart,
      verified: smart ? readVerifiedCache(installPath) : null,
      installedSha: cachedManifest
        ? Object.fromEntries(cachedManifest.files.map((file) => [file.path, file.sha256]))
        : null,
      fallbackManifest: cachedManifest,
    });

    if (install.cancelRequested === "CANCELLED") return cancelledResult;
    install.manifest = prepared.manifest;

    if (smart) {
      console.log(
        "[verify] проверка перед запуском: " +
          prepared.total +
          " файлов, по sha256 " +
          prepared.hashed +
          ", плохих " +
          (prepared.filesToDownload || []).length +
          (prepared.offline ? ", без связи с сервером" : "") +
          " — " +
          (Date.now() - verifyStartedAt) +
          " мс",
      );
      writeVerifiedCache(installPath, prepared.verified);
    }

    if (prepared.installed) {
      writeManifestCache(installPath, prepared.manifest);
      console.log("[install] все файлы на месте — загрузка не нужна");
      return { ok: true, status: "up_to_date", installed: true };
    }

    install.bytesTotal = (prepared.filesToDownload || []).reduce(
      (sum, file) => sum + (file.size || 0),
      0,
    );
    console.log(
      "[install] к загрузке " +
        prepared.filesToDownload.length +
        " файлов, " +
        (install.bytesTotal / 1_073_741_824).toFixed(2) +
        " ГБ",
    );

    install.stage = "download";
    const downloader = createGameDownloader(config, (progress) =>
      sendProgress({ phase: "downloading", ...progress }),
    );
    downloader.on("source-failed", (event) =>
      console.warn(
        "[install] источник " + event.source + " не отдал " + event.file + ": " + event.error,
      ),
    );
    install.downloader = downloader;
    if (install.cancelRequested === "PAUSED") downloader.pause();

    await downloader.downloadAll(prepared.filesToDownload, installPath, prepared.servers);
    if (install.cancelRequested === "CANCELLED") return cancelledResult;

    install.stage = "verify";
    const verification = await verifyDownloadedFiles(
      installPath,
      prepared.filesToDownload,
      (checked, total) => {
        checkCancelled({ phase: "verifying-download", checked, total });
      },
    );

    if ((verification.missing?.length || 0) > 0 || (verification.corrupted?.length || 0) > 0) {
      deleteStagedCorrupted(installPath, verification);
      const error = new Error("Проверка скачанных файлов не пройдена.");
      error.details = {
        missing: (verification.missing || []).slice(0, 30).map((file) => file.path),
        corrupted: (verification.corrupted || []).slice(0, 30).map((file) => file.path),
      };
      throw error;
    }

    writeManifestCache(installPath, prepared.manifest);
    writeVerifiedCache(
      installPath,
      markVerified(
        installPath,
        smart ? prepared.verified : readVerifiedCache(installPath),
        prepared.filesToDownload,
      ),
    );
    console.log("[install] установка завершена");
    return {
      ok: true,
      status: "updated",
      installed: true,
      fixed: prepared.filesToDownload.length,
    };
  } catch (error) {
    if (install.cancelRequested === "CANCELLED" || error?.code === "CANCELLED") {
      return cancelledResult;
    }
    console.error("install-game error (этап " + install.stage + "):", error);
    const assisted = await assistInstallError(error, install, installPath, sendProgress);
    return install.cancelRequested === "CANCELLED" ? cancelledResult : assisted;
  } finally {
    if (activeInstall === install) activeInstall = null;
    settle();
  }
});

/**
 * Fast local check used before launch: compares file sizes against the cached
 * manifest without any network access.
 */
ipcMain.handle("verify-files-local", async (_event, installPath) => {
  try {
    if (!installPath || !fs.existsSync(installPath)) {
      return { ok: false, reason: "NO_PATH" };
    }

    const cachedPath = manifestCachePath(installPath);
    const legacyPath = path.join(installPath, ".woohlauncher-manifest.json");
    const manifestPath = fs.existsSync(cachedPath)
      ? cachedPath
      : fs.existsSync(legacyPath)
        ? legacyPath
        : null;
    if (!manifestPath) return { ok: false, reason: "NO_CACHE" };

    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
    } catch {
      return { ok: false, reason: "NO_CACHE" };
    }
    if (!manifest || !Array.isArray(manifest.files)) return { ok: false, reason: "NO_CACHE" };

    const checks = manifest.files.map(
      (file) =>
        new Promise((resolve) => {
          fs.stat(resolveInstallPath(installPath, file.path), (error, stats) => {
            if (error) {
              resolve({ ok: false, path: file.path, reason: "missing" });
              return;
            }
            if (isPlayerFile(file.path)) {
              resolve({ ok: true });
              return;
            }
            if (stats.size !== file.size) {
              resolve({ ok: false, path: file.path, reason: "size" });
              return;
            }
            resolve({ ok: true });
          });
        }),
    );

    const results = await Promise.all(checks);
    const problems = results.filter((result) => !result.ok);
    return { ok: problems.length === 0, missing: problems.length, total: results.length };
  } catch (error) {
    console.error("verify-files-local error:", error);
    return { ok: false, reason: "ERROR", message: publicMessage(error.message) };
  }
});

ipcMain.handle("install-game-pause", () => {
  const install = activeInstall;
  if (!install || install.cancelRequested === "CANCELLED") return { ok: false };
  install.cancelRequested = "PAUSED";
  install.downloader?.pause();
  return { ok: true };
});

ipcMain.handle("install-game-resume", () => {
  const install = activeInstall;
  if (!install || install.cancelRequested === "CANCELLED") return { ok: false };
  install.cancelRequested = false;
  install.downloader?.resume();
  return { ok: true };
});

ipcMain.handle("install-game-cancel", async () => {
  const install = activeInstall;
  if (!install) return { ok: true };
  install.cancelRequested = "CANCELLED";
  install.downloader?.cancel();
  await Promise.race([install.settled, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  return { ok: true };
});

ipcMain.handle("helper-action", async (_event, action) => {
  try {
    if (action === "open-vcredist") {
      await shell.openExternal("https://aka.ms/vs/17/release/vc_redist.x64.exe");
      return { ok: true };
    }
    const result = await helper.applyAction(action);
    console.log("[helper] действие " + action + ": " + (result.ok ? "ok" : "не удалось"));
    return result;
  } catch (error) {
    console.error("helper-action error:", error);
    return { ok: false };
  }
});

// ---------------------------------------------------------------------------
// Diagnostics and support
// ---------------------------------------------------------------------------

ipcMain.handle("report-error", (_event, payload) => {
  const error = new Error(String(payload?.message || "Ошибка интерфейса"));
  if (payload?.stack) error.stack = String(payload.stack);
  return bugReport.report(error, {
    area: payload?.area || "ui",
    ...(payload?.context || {}),
  });
});

ipcMain.handle("net-diagnose", async (_event, installPath) => {
  const webContents = mainWindow?.webContents;
  const sendProgress = (text) => {
    if (webContents && !webContents.isDestroyed()) {
      webContents.send("net-diagnose-progress", { text });
    }
  };

  try {
    const diagnosis = await doctor.diagnose(doctorTargets(null, installPath), sendProgress);
    console.log(
      "[net-doctor] ручная проверка: " +
        (diagnosis.ok ? "ok" : diagnosis.cause) +
        " — " +
        diagnosis.message,
    );

    const reportId = diagnosis.ok
      ? null
      : bugReport.report(new Error(diagnosis.message), {
          area: "net-diagnose",
          diagnosis,
        });

    return {
      ok: diagnosis.ok,
      changed: Boolean(diagnosis.changed),
      message: publicMessage(diagnosis.message),
      reportId,
    };
  } catch (error) {
    const reportId = bugReport.report(error, { area: "net-diagnose" });
    return { ok: false, message: publicMessage(error.message), reportId };
  }
});

ipcMain.handle("support-send", async (_event, reportId, channel) => {
  try {
    const { file, text } = bugReport.supportBundle(reportId);
    clipboard.writeText(text);
    if (file) shell.showItemInFolder(file);

    const links = config.support || {};
    const target = links[channel] || links.telegram || links.discord;
    if (target && /^https:\/\//i.test(target)) await shell.openExternal(target);

    console.log(
      "[support] отчёт " +
        (reportId || "—") +
        " подготовлен для отправки (" +
        (channel || "telegram") +
        ")",
    );
    return { ok: true, hasFile: Boolean(file) };
  } catch (error) {
    console.error("support-send error:", error);
    return { ok: false };
  }
});

ipcMain.handle("support-links", () => {
  const links = config.support || {};
  return { telegram: Boolean(links.telegram), discord: Boolean(links.discord) };
});

ipcMain.handle("open-reports-folder", async () => {
  try {
    await shell.openPath(bugReport.reportsDir());
    return true;
  } catch {
    return false;
  }
});

// ---------------------------------------------------------------------------
// Launch arguments and game launch
// ---------------------------------------------------------------------------

/**
 * Splits a command-line string into arguments, honouring double quotes.
 * Supports the simple syntax users type into the "Launch arguments" field.
 *
 * @param {unknown} input
 */
function parseLaunchArgs(input) {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text) return [];

  const args = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && /\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) args.push(current);
  return args;
}

function exitCodeHex(code) {
  return typeof code === "number"
    ? "0x" + (code >>> 0).toString(16).toUpperCase().padStart(8, "0")
    : null;
}

/** Manual "Game won't start" diagnostics from the settings dialog. */
ipcMain.handle("game-diagnose", async (_event, installPath) => {
  try {
    const since = lastLaunchAt || Date.now() - 30 * 60 * 1000;
    const diagnostics = await gameWatch.snapshot(installPath || "", since);
    const processes = diagnostics.processes || [];
    const noWindow = processes.length > 0 && processes.every((process) => !process.hasWindow);
    const logs =
      (diagnostics.playerLog?.tail || "") + "\n" + (diagnostics.playerLog?.prevTail || "");
    const steamFail =
      /SteamClient\.get_SteamId|SteamPlatform\.Initialize[^\n]*\n?[^\n]*Exception|NullReferenceException[\s\S]{0,200}Steamworks/i.test(
        logs,
      );

    console.log(
      "[game-diagnose] процессов=" +
        processes.length +
        " безОкна=" +
        noWindow +
        " vc=" +
        diagnostics.vcRuntime +
        " админ=" +
        diagnostics.account?.isAdmin +
        " steamFail=" +
        steamFail +
        " нет файлов=" +
        (diagnostics.missingKeyFiles.join(",") || "—"),
    );

    const reportId = bugReport.report(new Error("Игра не запускается (диагностика по кнопке)"), {
      area: "game-diagnose",
      noDedupe: true,
      installPath,
      lastLaunchAt: lastLaunchAt ? new Date(lastLaunchAt).toISOString() : null,
      diagnostics,
    });

    return {
      reportId,
      running: processes.length > 0,
      noWindow,
      vcRuntime: diagnostics.vcRuntime,
      missingKeyFiles: diagnostics.missingKeyFiles,
      playerLogUpdated: Boolean(diagnostics.playerLog?.updatedThisLaunch),
      steamFail,
    };
  } catch (error) {
    console.error("game-diagnose error:", error);
    return { reportId: bugReport.report(error, { area: "game-diagnose" }) };
  }
});

ipcMain.handle("launch-game", async (_event, installPath, launchArgs, options = {}) => {
  const launchedAt = Date.now();
  lastLaunchAt = launchedAt;

  const previousPids = await gameWatch.gamePids().catch(() => new Set());
  const elevated = Boolean(options.elevated);

  let result = await launchGameImpl(installPath, launchArgs, { elevated });
  let probe = null;
  let smartAppControl = null;

  // A normal spawn can fail with an unhelpful error when Windows blocks the
  // process. Probe through PowerShell to obtain the real Win32 error code.
  if (!result.launched && !elevated && result.cause) {
    const exePath = path.join(installPath, "RustClient.exe");
    [probe, smartAppControl] = await Promise.all([
      gameWatch.probeLaunch(exePath, parseLaunchArgs(launchArgs), installPath).catch((error) => ({
        ok: false,
        code: null,
        message: error.message,
      })),
      gameWatch.smartAppControlState().catch(() => null),
    ]);

    console.warn(
      "[launch] обычный запуск не удался (" +
        result.error +
        "); проба: " +
        (probe.ok ? "запущено, pid " + probe.pid : "код " + probe.code + " — " + probe.message) +
        "; Smart App Control=" +
        (smartAppControl ?? "—"),
    );

    if (probe.ok) {
      result = { launched: true, mode: "normal" };
    } else {
      const advice = await helper.launchBlockAdvice(
        probe.code,
        probe.message,
        smartAppControl,
        installPath,
      );
      if (advice.error === "ELEVATION") {
        result = await launchGameImpl(installPath, launchArgs, { elevated: true });
      } else {
        result = {
          launched: false,
          error: advice.error,
          message: advice.message,
          cause: result.cause,
        };
      }
    }
  }

  if (!result.launched) {
    console.warn(
      "[launch] не запущено: " + result.error + " — " + String(result.message).split("\n")[0],
    );
    const antivirus = await gameWatch.antivirusNames().catch(() => []);
    result.reportId = bugReport.report(result.cause || new Error(result.message), {
      area: "launch-game",
      error: result.error,
      installPath,
      antivirus,
      launchProbe: probe,
      smartAppControl,
    });
    delete result.cause;
  } else {
    console.log(
      "[launch] запуск отправлен (режим: " +
        (result.mode === "elevated" ? "с правами администратора" : "обычный") +
        ") — слежу за процессом игры",
    );
    void watchLaunch(installPath, launchedAt, previousPids, result.mode);
  }

  return result;
});

/**
 * Watches the game after a successful launch and notifies the renderer with a
 * human-readable reason when it fails to start.
 */
async function watchLaunch(installPath, startedAt, previousPids, mode = "normal") {
  try {
    const problem = await gameWatch.watch({
      installPath,
      startedAt,
      prevPids: previousPids,
    });
    if (!problem) {
      console.log("[launch] игра работает");
      return;
    }

    const diagnostics = problem.diag;
    const runtimeSec = problem.runtimeMs != null ? Math.round(problem.runtimeMs / 1000) : null;

    // The exit event may arrive a moment after the process disappears.
    for (
      let attempt = 0;
      attempt < 10 && !(lastGameExit && lastGameExit.at >= startedAt);
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const exitInfo =
      lastGameExit && lastGameExit.at >= startedAt
        ? {
            code: lastGameExit.code,
            hex: exitCodeHex(lastGameExit.code),
            signal: lastGameExit.signal,
          }
        : null;
    diagnostics.exit = exitInfo;

    console.warn(
      "[launch] проблема: " +
        problem.kind +
        (runtimeSec != null ? " (" + runtimeSec + " с)" : "") +
        "; режим=" +
        mode +
        "; код выхода=" +
        (exitInfo?.hex || "—") +
        "; модуль=" +
        (diagnostics.windows?.faultingModule || "—") +
        "; vc=" +
        diagnostics.vcRuntime +
        "; нет файлов=" +
        (diagnostics.missingKeyFiles.join(",") || "—") +
        "; логи игры=" +
        ((diagnostics.gameLogs || []).map((log) => log.file).join(",") || "—"),
    );

    const thirdPartyAntivirus = (diagnostics.windows?.antivirus || []).filter(
      (name) => !/defender|защитник/i.test(name),
    );
    const silentEarlyExit =
      problem.kind === "early-exit" &&
      !diagnostics.playerLog?.updatedThisLaunch &&
      !diagnostics.windows?.faultingModule &&
      !diagnostics.unityCrash;
    const steamLog = diagnostics.playerLog?.updatedThisLaunch
      ? String(diagnostics.playerLog.tail || "")
      : "";
    const steamFail =
      /SteamClient\.get_SteamId|SteamPlatform\.Initialize[^\n]*\n?[^\n]*Exception|NullReferenceException[\s\S]{0,200}Steamworks/i.test(
        steamLog,
      );

    let message;
    let suggestion = null;

    if (steamFail) {
      message =
        "Игра не видит Steam. Закройте Steam полностью (Steam → Выход), откройте снова и нажмите «Играть».";
    } else if (diagnostics.missingKeyFiles.length) {
      message = "Не хватает файлов игры. Их мог удалить антивирус.";
      suggestion = "repair";
    } else if (problem.kind === "hung") {
      message = "Игра зависла и не открылась. Обычно это из-за испорченных файлов игры.";
      suggestion = "close-repair";
    } else if (problem.kind === "not-started" && mode !== "elevated") {
      message = "Игра не запустилась.";
      suggestion = "elevated";
    } else if (problem.kind === "not-started") {
      message =
        "Игра не запустилась. Если Windows спрашивала «Разрешить изменения?», нужно нажать «Да».";
    } else if (!diagnostics.vcRuntime) {
      message = "Игре не хватает программы от Microsoft (Visual C++).";
      suggestion = "vcredist";
    } else if (silentEarlyExit && thirdPartyAntivirus.length) {
      message =
        "Игру сразу закрывает антивирус «" +
        thirdPartyAntivirus.join("», «") +
        "».\n\n" +
        "Что сделать:\n" +
        "1. Открой антивирус.\n" +
        "2. Найди «Белый список», «Доверенные» или «Исключения».\n" +
        "3. Добавь туда папку с игрой:\n" +
        installPath +
        "\n" +
        "4. Если там есть «Песочница» — выключи её для игры.\n" +
        "5. Нажми «Играть».\n\n" +
        "Или выключи антивирус, пока играешь: правой кнопкой по его значку возле часов → «Выход» или «Отключить защиту».";
    } else {
      message = "Игра закрылась сразу после запуска.";
      suggestion = "repair";
    }

    const reportId = bugReport.report(
      new Error(
        "Игра: " +
          problem.kind +
          (diagnostics.windows?.faultingModule
            ? ", сбойный модуль " + diagnostics.windows.faultingModule
            : ""),
      ),
      {
        area: "game-launch",
        installPath,
        launchMode: mode,
        steamFail,
        diagnostics,
      },
    );

    const webContents = mainWindow?.webContents;
    if (webContents && !webContents.isDestroyed()) {
      webContents.send("game-launch-issue", {
        kind: problem.kind,
        message,
        suggest: suggestion,
        reportId,
      });
    }
  } catch (error) {
    console.error("watchLaunch error:", error);
  }
}

/**
 * Starts RustClient.exe.
 *
 * "Elevated" means `cmd.exe /c start` is used, which lets Windows show its
 * UAC prompt. Normal mode spawns the game directly with the `RunAsInvoker`
 * compatibility layer so it does not inherit the launcher's privileges.
 */
async function launchGameImpl(installPath, launchArgs, { elevated = false } = {}) {
  try {
    if (!installPath) {
      return {
        launched: false,
        error: "INSTALL_PATH",
        message: "Папка клиента не выбрана.",
      };
    }

    const exePath = path.join(installPath, "RustClient.exe");
    let stats = null;
    try {
      stats = fs.statSync(exePath);
    } catch {
      stats = null;
    }
    if (!stats || !stats.isFile()) {
      return {
        launched: false,
        error: "GAME_EXE_MISSING",
        message: "Игра не найдена. Нажмите «Установить».",
      };
    }
    if (stats.size < 2) {
      return {
        launched: false,
        error: "GAME_EXE_INVALID",
        message: "Файл игры испорчен. Нажмите «Играть» — лаунчер скачает его заново.",
      };
    }

    // Windows executables start with "MZ".
    try {
      const fd = fs.openSync(exePath, "r");
      const header = Buffer.alloc(2);
      fs.readSync(fd, header, 0, 2, 0);
      fs.closeSync(fd);
      if (header[0] !== 77 || header[1] !== 90) {
        return {
          launched: false,
          error: "GAME_EXE_INVALID",
          message: "Файл игры испорчен. Нажмите «Играть» — лаунчер скачает его заново.",
        };
      }
    } catch {
      // If the header cannot be read, let the spawn attempt produce the error.
    }

    if (!fs.existsSync(path.join(installPath, "RustClient_Data"))) {
      return {
        launched: false,
        error: "GAME_INCOMPLETE",
        message: "Игра скачана не до конца. Нажмите «Играть» — лаунчер докачает.",
      };
    }

    const args = parseLaunchArgs(launchArgs);

    if (!elevated) {
      const env = {
        ...process.env,
        __COMPAT_LAYER: "RunAsInvoker",
      };
      for (const key of Object.keys(env)) {
        if (key.startsWith("ELECTRON_")) delete env[key];
      }

      await new Promise((resolve, reject) => {
        const child = spawn(exePath, args, {
          cwd: installPath,
          env,
          detached: true,
          stdio: "ignore",
        });
        child.once("exit", (code, signal) => {
          lastGameExit = {
            pid: child.pid,
            code,
            signal,
            at: Date.now(),
          };
        });
        child.once("spawn", () => {
          child.unref();
          resolve();
        });
        child.once("error", reject);
      });

      return { launched: true, mode: "normal" };
    }

    // Elevated launch: `start` lets Windows raise the UAC prompt.
    const quote = (value) => '"' + String(value).replace(/"/g, "") + '"';
    const command = (
      '/d /s /c start "" /d ' +
      quote(installPath) +
      " " +
      quote(exePath) +
      " " +
      args.map(quote).join(" ")
    ).trim();

    await new Promise((resolve, reject) => {
      const child = spawn(process.env.ComSpec || "cmd.exe", [command], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
      });
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
      child.once("error", reject);
    });

    return { launched: true, mode: "elevated" };
  } catch (error) {
    console.error("launch-game error:", error);
    return {
      launched: false,
      error: error.code || "UNKNOWN",
      message: "Не удалось запустить игру.",
      cause: error,
    };
  }
}
