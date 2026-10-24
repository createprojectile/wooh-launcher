"use strict";

/**
 * Self-update for the launcher itself.
 *
 * A small JSON manifest (`/launcher/manifest.json` by default) describes the
 * newest installer:
 *
 *   { "version": "1.2.6", "file": "WoohProject Launcher Setup 1.2.6.exe",
 *     "size": 123456789, "sha256": "…64 hex chars…" }
 *
 * The installer is downloaded from the configured mirrors, verified and then
 * launched with `/S --force-run` (NSIS silent install). The launcher quits so
 * the installer can replace its files.
 */

const { app } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { DownloadManager } = require("./downloader");
const transport = require("./net-transport");

function netFetch(url, options) {
  return transport.fetchVia(url, options);
}

/** Directory where installers are staged between runs. */
const UPDATE_STATE_DIR = path.join(
  process.env.APPDATA || app.getPath("home"),
  "WoohProject",
  "launcher-update",
);

/**
 * Compares two dotted versions.
 * @returns {number} 1 when a > b, -1 when a < b, 0 when equal.
 */
function compareVersions(a, b) {
  const left = String(a)
    .split(".")
    .map((part) => parseInt(part, 10) || 0);
  const right = String(b)
    .split(".")
    .map((part) => parseInt(part, 10) || 0);

  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const lhs = left[index] || 0;
    const rhs = right[index] || 0;
    if (lhs > rhs) return 1;
    if (lhs < rhs) return -1;
  }
  return 0;
}

/** The directory that contains the installed .exe, or null in development. */
function getInstallRoot() {
  if (!app.isPackaged) return null;
  return path.dirname(process.execPath);
}

function resolveUrl(baseUrl, relativePath) {
  return baseUrl.replace(/\/$/, "") + "/" + String(relativePath).replace(/^\//, "");
}

async function fetchJson(url) {
  const response = await netFetch(url, {
    signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": "WoohLauncher/" + app.getVersion() },
  });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

/** Normalises, validates and deduplicates the mirror list. */
function getSources(config) {
  const seen = new Set();
  return (Array.isArray(config?.mirrors) ? config.mirrors : [])
    .map((source, index) => ({
      name: (source && source.name) || "Источник " + (index + 1),
      url: String((source && source.url) || "")
        .trim()
        .replace(/\/$/, ""),
    }))
    .filter(
      (source) => /^https?:\/\//i.test(source.url) && !seen.has(source.url) && seen.add(source.url),
    );
}

/** Sanity checks for a remote launcher manifest. */
function isValidManifest(manifest) {
  return (
    manifest &&
    typeof manifest.version === "string" &&
    typeof manifest.file === "string" &&
    !/[\\/]|\.\./.test(manifest.file) &&
    Number.isFinite(manifest.size) &&
    manifest.size > 0 &&
    /^[0-9a-f]{64}$/i.test(manifest.sha256 || "")
  );
}

/** Tries every mirror until a valid manifest is found. */
async function fetchManifest(sources, manifestUrl) {
  const errors = [];
  for (const source of sources) {
    try {
      const manifest = await fetchJson(resolveUrl(source.url, manifestUrl));
      if (!isValidManifest(manifest)) throw new Error("некорректный manifest");
      return { manifest, source };
    } catch (error) {
      errors.push(source.name + ": " + (error instanceof Error ? error.message : error));
    }
  }
  throw new Error(errors.join("; ") || "Нет источников");
}

/** Computes the SHA-256 of a file. */
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")))
      .on("error", reject);
  });
}

function emitProgress(webContents, payload) {
  if (webContents && !webContents.isDestroyed()) {
    webContents.send("launcher-update-progress", payload);
  }
}

/**
 * Cleans up the staging directory from a previous run. Called before the main
 * window is created.
 *
 * @returns {Promise<false>}
 */
async function applyPendingUpdateIfNeeded() {
  try {
    fs.rmSync(UPDATE_STATE_DIR, { recursive: true, force: true });
  } catch (error) {
    console.warn("Failed to cleanup launcher update dir:", error);
  }
  return false;
}

/**
 * Downloads and verifies the installer from the first working mirror.
 *
 * @param {{ version: string, file: string, size: number, sha256: string }} manifest
 * @param {Array<{ name: string, url: string }>} sources
 * @param {string} downloadPath
 * @param {object} config
 * @param {Electron.WebContents} [webContents]
 * @returns {Promise<string>} Path to the verified installer.
 */
async function downloadInstaller(manifest, sources, downloadPath, config, webContents) {
  const targetDir = path.join(UPDATE_STATE_DIR, manifest.version);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, manifest.file);
  const errors = [];

  for (const source of sources) {
    const manager = new DownloadManager(config.downloadConcurrency || 4);
    manager.on("progress", (progress) => {
      emitProgress(webContents, {
        phase: "downloading",
        messageKey: "launcherUpdate.downloading",
        ...progress,
        source: source.name,
      });
    });

    try {
      await manager.downloadAll([{ path: manifest.file, size: manifest.size }], targetDir, [
        { name: source.name, url: resolveUrl(source.url, downloadPath) },
      ]);

      emitProgress(webContents, {
        phase: "verifying",
        messageKey: "launcherUpdate.verifyingDownload",
      });

      const digest = await sha256File(targetPath);
      if (
        fs.statSync(targetPath).size !== manifest.size ||
        digest !== manifest.sha256.toLowerCase()
      ) {
        throw new Error("хэш установщика не совпал с манифестом");
      }
      return targetPath;
    } catch (error) {
      errors.push(source.name + ": " + (error instanceof Error ? error.message : error));
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        // Ignore.
      }
    }
  }

  throw new Error(errors.join("; "));
}

/** Starts the NSIS installer in silent mode. */
function launchInstaller(installerPath) {
  const child = spawn(installerPath, ["/S", "--force-run"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
}

/**
 * Checks for a newer launcher version and, when found, downloads the
 * installer and restarts.
 *
 * @param {object} config `launcherUpdate` section of config.json
 * @param {Electron.WebContents} [webContents]
 */
async function runLauncherUpdate(config, webContents) {
  if (!config?.enabled) return { ok: true, status: "disabled" };

  const sources = getSources(config);
  if (sources.length === 0) return { ok: true, status: "not_configured" };
  if (!getInstallRoot()) return { ok: true, status: "dev_skip" };

  emitProgress(webContents, {
    phase: "checking",
    messageKey: "launcherUpdate.checking",
  });

  let manifest;
  let source;
  try {
    ({ manifest, source } = await fetchManifest(
      sources,
      config.manifestUrl || "/launcher/manifest.json",
    ));
  } catch (error) {
    console.error("Launcher manifest fetch failed:", error);
    return { ok: true, status: "manifest_unreachable" };
  }

  const currentVersion = app.getVersion();
  if (compareVersions(manifest.version, currentVersion) <= 0) {
    return { ok: true, status: "up_to_date", version: currentVersion };
  }

  const orderedSources = [source, ...sources.filter((candidate) => candidate !== source)];
  const downloadPath = config.downloadPath || "/launcher";

  let installerPath;
  try {
    installerPath = await downloadInstaller(
      manifest,
      orderedSources,
      downloadPath,
      config,
      webContents,
    );
  } catch (error) {
    console.error("Launcher installer download failed:", error);
    return { ok: false, status: "download_failed", message: error.message };
  }

  emitProgress(webContents, {
    phase: "restarting",
    messageKey: "launcherUpdate.restarting",
  });
  launchInstaller(installerPath);
  setTimeout(() => app.quit(), 600);

  return { ok: true, status: "restarting", version: manifest.version };
}

module.exports = {
  UPDATE_STATE_DIR,
  applyPendingUpdateIfNeeded,
  runLauncherUpdate,
  compareVersions,
  getInstallRoot,
};
