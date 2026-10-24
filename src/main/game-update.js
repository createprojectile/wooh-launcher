"use strict";

/**
 * Game manifest fetching and update orchestration.
 *
 * The game files live on one or more HTTP mirrors. Each mirror serves
 * `manifest.json` (a list of files with size + SHA-256) and the files
 * themselves. This module:
 *  - normalises the mirror list from config.json;
 *  - fetches the manifest (with fallbacks);
 *  - verifies the local installation (quick/full/smart);
 *  - downloads the missing/corrupted files.
 */

const fs = require("fs");
const {
  checkIntegrity,
  quickCheckIntegrity,
  smartCheckIntegrity,
  getFilesToDownload,
} = require("./integrity");
const { DownloadManager } = require("./downloader");
const transport = require("./net-transport");

/** User-Agent used for manifest requests. */
const MANIFEST_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function netFetch(url, options) {
  return transport.fetchVia(url, options);
}

function getCdnConfig(config) {
  return config.gameCdn || {};
}

/**
 * Turns a config entry (string or object) into `{ name, url }`.
 * Returns null for unusable/unsafe URLs.
 *
 * @param {string | { name?: string, url?: string }} source
 * @param {string} [fallbackName]
 */
function normalizeSource(source, fallbackName) {
  if (!source) return null;
  const url = (typeof source === "string" ? source : source.url || "").trim().replace(/\/$/, "");
  if (!/^https?:\/\//i.test(url)) return null;
  const name = (typeof source === "object" && source.name) || fallbackName || new URL(url).host;
  return { name, url };
}

/** Removes duplicate mirror URLs while preserving order. */
function dedupeSources(sources) {
  const seen = new Set();
  return sources.filter((source) => source && !seen.has(source.url) && seen.add(source.url));
}

/** Returns the normalised mirror list from config.json. */
function getConfigSources(config) {
  const mirrors = getCdnConfig(config).mirrors;
  if (!Array.isArray(mirrors)) return [];
  return dedupeSources(
    mirrors.map((source, index) => normalizeSource(source, "HF #" + (index + 1))),
  );
}

/**
 * Fetches and validates `manifest.json` from one mirror.
 *
 * @param {{ name: string, url: string }} source
 * @param {string} manifestPath
 */
async function fetchManifestFrom(source, manifestPath) {
  const response = await netFetch(source.url + manifestPath, {
    signal: AbortSignal.timeout(20_000),
    headers: {
      "User-Agent": MANIFEST_USER_AGENT,
      Accept: "application/json, */*",
    },
  });
  if (!response.ok) throw new Error(source.name + ": HTTP " + response.status);
  const manifest = await response.json();
  if (!manifest || !Array.isArray(manifest.files)) {
    throw new Error(source.name + ": некорректный manifest");
  }
  return manifest;
}

/**
 * Tries every configured mirror until one returns a valid manifest.
 * The successful source is attached as a non-enumerable `__source` property.
 *
 * @param {object} config
 */
async function fetchGameManifest(config) {
  const sources = getConfigSources(config);
  if (sources.length === 0) {
    throw new Error("CDN не настроен: заполните gameCdn.mirrors в config.json");
  }

  let manifestPath = getCdnConfig(config).manifestPath || "/manifest.json";
  if (!manifestPath.startsWith("/")) manifestPath = "/" + manifestPath;

  const errors = [];
  for (const source of sources) {
    try {
      const manifest = await fetchManifestFrom(source, manifestPath);
      manifest.__source = source;
      return manifest;
    } catch (error) {
      errors.push(error.message);
    }
  }
  throw new Error("Ни один источник не отдал manifest:\n" + errors.join("\n"));
}

/**
 * Returns the download sources, with the mirror that produced the manifest
 * first (it is known to be reachable).
 *
 * @param {object} config
 * @param {any} manifest
 */
function getDownloadServers(config, manifest) {
  const sources = getConfigSources(config);
  const primary = manifest?.__source;
  if (primary) sources.sort((a, b) => (b.url === primary.url) - (a.url === primary.url));
  return sources;
}

/**
 * Checks the installed game against the manifest.
 *
 * @param {object} config
 * @param {string} installPath
 * @param {(checked: number, total: number) => void} [onProgress]
 * @param {{
 *   fast?: boolean,
 *   smart?: boolean,
 *   verified?: Record<string, { size: number, mtimeMs: number, sha256: string }>,
 *   installedSha?: Record<string, string> | null,
 *   fallbackManifest?: any,
 * }} [options]
 */
async function verifyGame(config, installPath, onProgress, options = {}) {
  const useFastCheck = options.fast !== false;

  if (!installPath || !fs.existsSync(installPath)) {
    return {
      installed: false,
      missing: [],
      corrupted: [],
      valid: 0,
      total: 0,
    };
  }

  let manifest;
  let offline = false;
  try {
    manifest = await fetchGameManifest(config);
  } catch (error) {
    if (!options.fallbackManifest) throw error;
    console.warn("[verify] манифест с сервера не получен — проверяю по сохранённому");
    manifest = options.fallbackManifest;
    offline = true;
  }

  let result;
  if (options.smart) {
    result = await smartCheckIntegrity(
      installPath,
      manifest,
      onProgress,
      options.verified || {},
      options.installedSha || null,
    );
  } else {
    const check = useFastCheck ? quickCheckIntegrity : checkIntegrity;
    result = await check(installPath, manifest, onProgress, true);
  }

  const filesToDownload = getFilesToDownload(result);
  return {
    installed: filesToDownload.length === 0,
    missing: result.missing,
    corrupted: result.corrupted,
    valid: result.valid,
    total: result.total,
    manifest,
    filesToDownload,
    offline,
    hashed: result.hashed,
    verified: result.verified,
  };
}

/**
 * Downloads the provided file list.
 *
 * @param {object} config
 * @param {string} installPath
 * @param {any} manifest
 * @param {Array<{ path: string, size: number }>} files
 * @param {(progress: object) => void} [onProgress]
 */
async function downloadGame(config, installPath, manifest, files, onProgress) {
  if (!files || files.length === 0) {
    return { downloaded: true, filesCount: 0 };
  }

  fs.mkdirSync(installPath, { recursive: true });
  const cdnConfig = getCdnConfig(config);
  const servers = getDownloadServers(config, manifest);
  const manager = new DownloadManager(cdnConfig.downloadConcurrency || 8);
  if (onProgress) manager.on("progress", (progress) => onProgress(progress));

  await manager.downloadAll(files, installPath, servers);
  return { downloaded: true, filesCount: files.length };
}

/** Creates a configured DownloadManager wired to a progress callback. */
function createGameDownloader(config, onProgress) {
  const cdnConfig = getCdnConfig(config);
  const manager = new DownloadManager(cdnConfig.downloadConcurrency || 8);
  if (onProgress) manager.on("progress", (progress) => onProgress(progress));
  return manager;
}

/**
 * The "install/update" entry point used by the main process.
 *
 * @param {object} config
 * @param {string} installPath
 * @param {(progress: object) => void} [onProgress]
 * @param {{
 *   deep?: boolean,
 *   smart?: boolean,
 *   verified?: object,
 *   installedSha?: Record<string, string> | null,
 *   fallbackManifest?: any,
 * }} [options]
 */
async function prepareGameInstall(config, installPath, onProgress, options = {}) {
  const result = await verifyGame(
    config,
    installPath,
    (checked, total) => onProgress?.({ phase: "verifying", checked, total }),
    {
      fast: !options.deep,
      smart: Boolean(options.smart) && !options.deep,
      verified: options.verified,
      installedSha: options.installedSha,
      fallbackManifest: options.fallbackManifest,
    },
  );
  return {
    ...result,
    servers: result.manifest ? getDownloadServers(config, result.manifest) : [],
  };
}

/**
 * Full hash verification of freshly downloaded files.
 * Unlike the pre-launch check, player files are verified here too.
 */
async function verifyDownloadedFiles(installPath, files, onProgress) {
  return checkIntegrity(installPath, { files }, onProgress);
}

/** Verify + download in one call (used by headless/alternate entry points). */
async function ensureGame(config, installPath, onProgress) {
  const result = await verifyGame(
    config,
    installPath,
    (checked, total) => onProgress?.({ phase: "verifying", checked, total }),
    { fast: true },
  );

  if (result.installed) return { status: "up_to_date", ...result };

  onProgress?.({
    phase: "download_needed",
    filesCount: result.filesToDownload.length,
  });
  await downloadGame(config, installPath, result.manifest, result.filesToDownload, (progress) => {
    onProgress?.({ phase: "downloading", ...progress });
  });
  return { status: "updated", ...result };
}

module.exports = {
  createGameDownloader,
  prepareGameInstall,
  verifyDownloadedFiles,
  fetchGameManifest,
  verifyGame,
  downloadGame,
  ensureGame,
  getDownloadServers,
};
