"use strict";

/**
 * File-integrity checks.
 *
 * A game install is described by a manifest: `{ files: [{ path, size, sha256 }] }`.
 * Three levels of verification are available:
 *
 *  - {@link quickCheckIntegrity} – only checks that every file exists and has
 *    the expected size. Fast; used for the "before launch" check.
 *  - {@link checkIntegrity} – existence + size + SHA-256. Used for the full
 *    (deep) verification and after downloading.
 *  - {@link smartCheckIntegrity} – trusts a cached (size, mtime, hash) tuple
 *    and only re-hashes files that are critical (.exe/.dll), were changed, or
 *    are unknown. This keeps "Play" responsive on a large install.
 *
 * Player-owned files (configs, maps, temp data) are never overwritten or
 * hashed, so the launcher does not destroy the player's settings.
 */

const { createHash } = require("crypto");
const { createReadStream, existsSync, statSync } = require("fs");
const { access, mkdir, unlink } = require("fs/promises");
const path = require("path");

/**
 * @typedef {Object} ManifestFile
 * @property {string} path  Relative path inside the install directory.
 * @property {number} size  Expected size in bytes.
 * @property {string} sha256 Expected lowercase hex SHA-256.
 */

/**
 * @typedef {Object} IntegrityResult
 * @property {ManifestFile[]} missing   Files that do not exist.
 * @property {ManifestFile[]} corrupted Files with a wrong size or hash.
 * @property {number} valid             Number of verified/trusted files.
 * @property {number} total             Total number of files in the manifest.
 */

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Computes the SHA-256 of a file, streaming it to avoid loading large files
 * into memory.
 *
 * @param {string} filePath
 * @returns {Promise<string>} Lowercase hex digest.
 */
function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Full integrity check: existence + size + SHA-256.
 *
 * @param {string} root Install directory.
 * @param {{ files: ManifestFile[] }} manifest
 * @param {(checked: number, total: number) => void} [onProgress]
 * @param {boolean} [skipPlayerFiles] When true, player-owned files are counted as valid.
 * @returns {Promise<IntegrityResult>}
 */
async function checkIntegrity(root, manifest, onProgress, skipPlayerFiles = false) {
  /** @type {ManifestFile[]} */
  const missing = [];
  /** @type {ManifestFile[]} */
  const corrupted = [];
  let valid = 0;
  const total = manifest.files.length;

  for (let index = 0; index < manifest.files.length; index++) {
    const entry = manifest.files[index];
    const absolutePath = resolveInstallPath(root, entry.path);
    onProgress?.(index + 1, total);

    if (!existsSync(absolutePath)) {
      missing.push(entry);
      continue;
    }
    if (skipPlayerFiles && isPlayerFile(entry.path)) {
      valid++;
      continue;
    }

    const stats = statSync(absolutePath);
    if (stats.size !== entry.size) {
      corrupted.push(entry);
      continue;
    }

    const digest = await hashFile(absolutePath);
    if (digest !== entry.sha256) {
      corrupted.push(entry);
      continue;
    }
    valid++;
  }

  return { missing, corrupted, valid, total };
}

/**
 * Fast integrity check: existence + size only. Never reads file contents.
 *
 * @param {string} root
 * @param {{ files: ManifestFile[] }} manifest
 * @param {(checked: number, total: number) => void} [onProgress]
 * @param {boolean} [skipPlayerFiles]
 * @returns {Promise<IntegrityResult>}
 */
async function quickCheckIntegrity(root, manifest, onProgress, skipPlayerFiles = false) {
  const missing = [];
  const corrupted = [];
  let valid = 0;
  const total = manifest.files.length;

  for (let index = 0; index < manifest.files.length; index++) {
    const entry = manifest.files[index];
    const absolutePath = resolveInstallPath(root, entry.path);
    onProgress?.(index + 1, total);

    if (!existsSync(absolutePath)) {
      missing.push(entry);
      continue;
    }
    if (skipPlayerFiles && isPlayerFile(entry.path)) {
      valid++;
      continue;
    }

    const stats = statSync(absolutePath);
    if (stats.size !== entry.size) {
      corrupted.push(entry);
      continue;
    }
    valid++;
  }

  return { missing, corrupted, valid, total };
}

/**
 * Player-owned paths. `maps/` and `temp/` are written by the game itself and
 * `.cfg` files contain the player's settings, so they must be left alone.
 */
function isPlayerFile(relativePath) {
  return /\.cfg$/i.test(relativePath) || /^(maps|temp)\//i.test(relativePath);
}

/** Executables and libraries are always re-hashed because they are the most likely to be tampered with. */
function isCritical(relativePath) {
  return /\.(exe|dll)$/i.test(relativePath);
}

/**
 * Resolves a manifest path inside the install directory and rejects absolute
 * paths or `..` traversal. Mirrors are third-party datasets, so a manifest
 * must never be able to write outside the chosen install folder.
 *
 * @param {string} root
 * @param {string} relativePath
 * @returns {string}
 */
function resolveInstallPath(root, relativePath) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(rootPath, relativePath);
  if (targetPath !== rootPath && !targetPath.startsWith(rootPath + path.sep)) {
    throw new Error("Некорректный путь в manifest: " + relativePath);
  }
  return targetPath;
}

/**
 * "Smart" check used before launching the game.
 *
 * A file is trusted when the cached record matches the file's size, mtime and
 * the manifest hash. Everything else is hashed. Unknown files that already
 * differ from the manifest recorded at install time are also hashed, which
 * catches files replaced after the previous launch.
 *
 * @param {string} root
 * @param {{ files: ManifestFile[] }} manifest
 * @param {(checked: number, total: number) => void} [onProgress]
 * @param {Record<string, { size: number, mtimeMs: number, sha256: string }>} [verifiedCache]
 * @param {Record<string, string> | null} [installedSha] path -> hash from the previous manifest
 */
async function smartCheckIntegrity(
  root,
  manifest,
  onProgress,
  verifiedCache = {},
  installedSha = null,
) {
  /** @type {ManifestFile[]} */
  const missing = [];
  /** @type {ManifestFile[]} */
  const corrupted = [];
  /** @type {Record<string, { size: number, mtimeMs: number, sha256: string }>} */
  const verified = {};

  let valid = 0;
  let hashed = 0;
  const total = manifest.files.length;

  for (let index = 0; index < total; index++) {
    const entry = manifest.files[index];
    const absolutePath = resolveInstallPath(root, entry.path);
    onProgress?.(index + 1, total);

    let stats;
    try {
      stats = statSync(absolutePath);
    } catch {
      missing.push(entry);
      continue;
    }

    if (isPlayerFile(entry.path)) {
      valid++;
      continue;
    }

    if (stats.size !== entry.size) {
      corrupted.push(entry);
      continue;
    }

    const cached = verifiedCache[entry.path];
    const cacheMatches =
      cached &&
      cached.size === stats.size &&
      cached.mtimeMs === stats.mtimeMs &&
      cached.sha256 === entry.sha256;
    const changedSinceInstall =
      !cached && installedSha && installedSha[entry.path] !== entry.sha256;

    if (isCritical(entry.path) || (cached && !cacheMatches) || changedSinceInstall) {
      hashed++;
      let digest = null;
      try {
        digest = await hashFile(absolutePath);
      } catch {
        // Unreadable file: treat it as corrupted below.
      }
      if (digest !== entry.sha256) {
        corrupted.push(entry);
        continue;
      }
    }

    verified[entry.path] = {
      size: stats.size,
      mtimeMs: stats.mtimeMs,
      sha256: entry.sha256,
    };
    valid++;
  }

  return { missing, corrupted, valid, total, hashed, verified };
}

/** Combines missing and corrupted files into the list that has to be downloaded. */
function getFilesToDownload(result) {
  return [...result.missing, ...result.corrupted];
}

/** Creates the parent directory of `filePath` (recursively). */
async function ensureParentDir(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
}

/** Deletes `filePath` if it exists. Missing files are ignored. */
async function removeFileIfExists(filePath) {
  if (existsSync(filePath)) await unlink(filePath);
}

module.exports = {
  fileExists,
  hashFile,
  checkIntegrity,
  quickCheckIntegrity,
  smartCheckIntegrity,
  isPlayerFile,
  resolveInstallPath,
  getFilesToDownload,
  ensureParentDir,
  removeFileIfExists,
};
