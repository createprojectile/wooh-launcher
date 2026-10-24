"use strict";

/**
 * "zapret" / DPI-bypass compatibility helper.
 *
 * Many Russian ISPs throttle or block the download mirrors. Users often run a
 * DPI-bypass tool (zapret, GoodbyeDPI, ByeDPI, SpoofDPI) which restores access
 * to Discord/YouTube but may also interfere with the launcher. For zapret we
 * can safely add the game domains to its exclusion list, so the launcher keeps
 * working while the user's DPI bypass stays enabled.
 *
 * No tool is modified except appending hostnames to a plain-text exclusion
 * list that belongs to zapret.
 */

const { app } = require("electron");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

/** Domains the launcher needs to reach. */
const GAME_DOMAINS = ["huggingface.co", "hf.co", "gamemonitoring.ru"];

/** Runs a console command and returns stdout (empty string on error). */
function run(command, args, timeout = 8000) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout, encoding: "utf-8" }, (error, stdout) =>
      resolve(error && !stdout ? "" : String(stdout || "")),
    );
  });
}

/** `C:\tools\zapret\bin\winws.exe` -> `C:\tools\zapret`. */
function rootFromExe(exePath) {
  const dir = path.dirname(exePath);
  return path.basename(dir).toLowerCase() === "bin" ? path.dirname(dir) : dir;
}

/** A zapret installation contains `bin\winws.exe` and a `lists` directory. */
function looksLikeZapretRoot(root) {
  return (
    fs.existsSync(path.join(root, "bin", "winws.exe")) && fs.existsSync(path.join(root, "lists"))
  );
}

/** Reads the zapret service's ImagePath from the registry. */
async function rootsFromService() {
  const output = await run("reg", [
    "query",
    "HKLM\\SYSTEM\\CurrentControlSet\\Services\\zapret",
    "/v",
    "ImagePath",
  ]);
  const match = output.match(/ImagePath\s+REG_(?:EXPAND_)?SZ\s+"?([^"\r\n]+?winws\.exe)/i);
  return match ? [rootFromExe(match[1])] : [];
}

/**
 * Scans common folders for a zapret installation (depth-limited).
 */
function rootsFromScan() {
  const roots = new Set();
  for (const name of ["desktop", "downloads", "documents", "home"]) {
    try {
      roots.add(app.getPath(name));
    } catch {
      // Some paths may not exist on the current system.
    }
  }
  for (const drive of ["C", "D", "E"]) roots.add(drive + ":\\");

  const found = new Set();
  const scan = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(dir, entry.name);
      if (/zapret|winws|discord.?youtube|bypass/i.test(entry.name) && looksLikeZapretRoot(child)) {
        found.add(child);
      } else if (
        depth > 0 &&
        /zapret|discord|youtube|bypass|soft|programs?|tools/i.test(entry.name)
      ) {
        scan(child, depth - 1);
      }
    }
  };

  for (const root of roots) scan(root, 1);
  return [...found];
}

/**
 * Picks the exclusion list that the user's zapret build actually uses.
 * Some builds ship `list-exclude-user.txt` and reference it from a .bat file.
 */
function exclusionFile(root) {
  const listsDir = path.join(root, "lists");
  let usesUserList = false;
  try {
    usesUserList = fs
      .readdirSync(root)
      .filter((name) => name.toLowerCase().endsWith(".bat"))
      .some((name) =>
        fs.readFileSync(path.join(root, name), "utf-8").includes("list-exclude-user.txt"),
      );
  } catch {
    // No .bat files: use the standard list.
  }
  return path.join(listsDir, usesUserList ? "list-exclude-user.txt" : "list-exclude.txt");
}

/**
 * Appends the game domains to an exclusion list.
 * @returns {string[]} The domains that were added.
 */
function addDomains(filePath) {
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    // The list does not exist yet; it will be created.
  }

  const lines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
  const missing = GAME_DOMAINS.filter((domain) => !lines.has(domain));
  if (!missing.length) return [];

  const leadingNewline = existing && !/\r?\n$/.test(existing) ? "\r\n" : "";
  fs.appendFileSync(filePath, "" + leadingNewline + missing.join("\r\n") + "\r\n", "utf-8");
  return missing;
}

/** Known DPI-bypass processes and the display name shown to the user. */
const DPI_PROCESSES = {
  "winws.exe": "zapret",
  "goodbyedpi.exe": "GoodbyeDPI",
  "ciadpi.exe": "ByeDPI",
  "byedpi.exe": "ByeDPI",
  "spoofdpi.exe": "SpoofDPI",
};

/** Returns the list of running DPI-bypass tools (display names). */
async function runningTools() {
  if (process.platform !== "win32") return [];
  const output = (await run("tasklist", ["/FO", "CSV", "/NH"])).toLowerCase();
  return [
    ...new Set(
      Object.keys(DPI_PROCESSES)
        .filter((processName) => output.includes('"' + processName + '"'))
        .map((processName) => DPI_PROCESSES[processName]),
    ),
  ];
}

/** Returns the game domains missing from an exclusion list. */
function missingDomains(filePath) {
  let existing = "";
  try {
    existing = fs.readFileSync(filePath, "utf-8");
  } catch {
    // Missing file means every domain is missing.
  }
  const lines = new Set(
    existing
      .split(/\r?\n/)
      .map((line) => line.trim().toLowerCase())
      .filter(Boolean),
  );
  return GAME_DOMAINS.filter((domain) => !lines.has(domain));
}

/** @type {{ tools: string[], fixable: string[], canFix: boolean, alreadyFixed: boolean } | null} */
let lastResult = null;

/**
 * Detects running DPI-bypass tools and whether zapret can be patched.
 */
async function detect() {
  const result = {
    tools: [],
    fixable: [],
    canFix: false,
    alreadyFixed: false,
  };
  if (process.platform !== "win32") return result;

  result.tools = await runningTools();

  if (result.tools.includes("zapret")) {
    const roots = new Set(
      [...(await rootsFromService()), ...rootsFromScan()].filter(looksLikeZapretRoot),
    );
    for (const root of roots) {
      const listPath = exclusionFile(root);
      if (missingDomains(listPath).length) result.fixable.push(listPath);
    }
    result.canFix = result.fixable.length > 0;
    result.alreadyFixed = roots.size > 0 && !result.canFix;
  }

  if (result.tools.length) {
    console.log(
      `[zapret] запущено: ${result.tools.join(", ")}; можно исправить: ${result.canFix}; ` +
        `уже исправлено: ${result.alreadyFixed}`,
    );
  }
  lastResult = result;
  return result;
}

/** Appends the game domains to every fixable exclusion list. */
async function applyFix() {
  const result = lastResult || (await detect());
  const summary = { added: [], errors: [] };

  for (const listPath of result.fixable) {
    try {
      const added = addDomains(listPath);
      if (added.length) summary.added.push(listPath);
    } catch (error) {
      summary.errors.push(error.code || error.message);
    }
  }

  console.log(
    `[zapret] игрок разрешил исправить: дописано в ${summary.added.length} файл(ов), ` +
      `ошибок ${summary.errors.length}`,
  );
  lastResult = {
    ...result,
    fixable: [],
    canFix: false,
    alreadyFixed: summary.added.length > 0 || result.alreadyFixed,
  };

  return {
    ok: summary.added.length > 0 && !summary.errors.length,
    ...summary,
  };
}

/** Last detection result (used by the bug-report context provider). */
function status() {
  return lastResult;
}

module.exports = {
  detect,
  applyFix,
  status,
  GAME_DOMAINS,
  _internal: {
    rootsFromScan,
    exclusionFile,
    addDomains,
    looksLikeZapretRoot,
  },
};
