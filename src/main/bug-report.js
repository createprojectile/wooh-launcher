"use strict";

/**
 * Logging and crash/error reporting.
 *
 * Every console message is mirrored into `%APPDATA%/wooh-launcher/logs/launcher.log`.
 * When an error is reported, a JSON report is written to
 * `%APPDATA%/wooh-launcher/reports/`. Reports are scrubbed: the user's home
 * directory and all download URLs are replaced with placeholders, so the file
 * can be sent to support without leaking private data or the CDN address.
 *
 * Reports are deduplicated for 30 seconds so a failing download does not
 * create hundreds of files.
 */

const { app } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const util = require("util");
const crypto = require("crypto");

const RING_SIZE = 400;
const MAX_REPORTS = 60;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const DEDUPE_MS = 30 * 1000;
const SUMMARY_MAX = 3500;

/** In-memory tail of the log, attached to every report. */
const ring = [];
let logStream = null;
let contextProvider = () => ({});
let lastReport = { sig: null, at: 0, id: null };
let initialized = false;

const escRe = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const homeRe = new RegExp(
  [os.homedir(), os.homedir().replace(/\\/g, "/")].map(escRe).join("|"),
  "gi",
);

/** Removes the user's home path and all server URLs from a string. */
function scrubPaths(value) {
  return String(value)
    .replace(homeRe, "%USERPROFILE%")
    .replace(/https?:\/\/[^\s"'<>)]+/gi, "[сервер]")
    .replace(/\b[\w.-]*huggingface\.co[^\s"'<>)]*/gi, "[сервер]")
    .replace(/\b[\w.-]+\.hf\.co\b[^\s"'<>)]*/gi, "[сервер]")
    .replace(/\bdatasets\/[\w.-]+\/[\w.-]+[^\s"'<>)]*/gi, "[сервер]");
}

/** Recursively scrubs strings inside arrays/objects. */
function scrubDeep(value) {
  if (typeof value === "string") return scrubPaths(value);
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) result[key] = scrubDeep(child);
    return result;
  }
  return value;
}

function dirs() {
  const userData = app.getPath("userData");
  return {
    logs: path.join(userData, "logs"),
    reports: path.join(userData, "reports"),
  };
}

/** Formats console arguments the same way Node's console does. */
function format(args) {
  return args
    .map((arg) => {
      if (arg instanceof Error) return arg.stack || arg.message;
      if (typeof arg === "string") return arg;
      return util.inspect(arg, { depth: 4, breakLength: 200 });
    })
    .join(" ");
}

function write(level, source, message) {
  const line =
    new Date().toISOString() +
    " [" +
    level +
    "]" +
    (source ? " [" + source + "]" : "") +
    " " +
    scrubPaths(message);

  ring.push(line);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  if (logStream) {
    try {
      logStream.write(line + "\n");
    } catch {
      // The stream may be closed during shutdown.
    }
  }
}

/** Redirects console.* into the log ring/file while keeping the original output. */
function hookConsole() {
  for (const level of ["log", "info", "warn", "error"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      try {
        write(level.toUpperCase(), "main", format(args));
      } catch {
        // Never let logging break the caller.
      }
      original(...args);
    };
  }
}

/**
 * Initialises logging. Must be called before the window is created.
 *
 * @param {object} _config Unused; kept for the call-site signature.
 * @param {() => object} [provider] Returns extra context for every report.
 */
function init(_config, provider) {
  if (initialized) return;
  initialized = true;
  if (typeof provider === "function") contextProvider = provider;

  const { logs, reports } = dirs();
  try {
    fs.mkdirSync(logs, { recursive: true });
    fs.mkdirSync(reports, { recursive: true });
  } catch {
    // Read-only userData is not fatal.
  }

  const logFile = path.join(logs, "launcher.log");
  try {
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > MAX_LOG_BYTES) {
      fs.renameSync(logFile, path.join(logs, "launcher.old.log"));
    }
    logStream = fs.createWriteStream(logFile, { flags: "a" });
  } catch {
    // Fall back to the in-memory ring only.
  }

  hookConsole();
  console.log(
    "=== WoohProject Launcher " +
      app.getVersion() +
      " старт (electron " +
      process.versions.electron +
      ", " +
      os.platform() +
      " " +
      os.release() +
      ") ===",
  );
}

/** Attaches renderer console forwarding and crash reporting to a window. */
function attachRenderer(webContents) {
  webContents.on("console-message", (event) => {
    const levelName =
      typeof event?.level === "string"
        ? event.level
        : ["VERBOSE", "INFO", "WARN", "ERROR"][event?.level] || "INFO";
    const text = event?.message ?? "";
    const source = event?.sourceId;
    const lineNumber = event?.lineNumber;

    write(
      String(levelName).toUpperCase(),
      "ui",
      "" + text + (source ? " (" + path.basename(String(source)) + ":" + lineNumber + ")" : ""),
    );
  });

  webContents.on("render-process-gone", (_event, details) => {
    report(new Error("Окно лаунчера упало: " + details?.reason), {
      area: "renderer-crash",
      details,
    });
  });
}

function normalizeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      httpStatus: error.httpStatus,
      stack: error.stack,
    };
  }
  if (error && typeof error === "object") {
    return {
      name: error.name || "Error",
      message: error.message || util.inspect(error),
      code: error.code,
      stack: error.stack,
    };
  }
  return { name: "Error", message: String(error) };
}

function systemInfo() {
  return {
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    locale: (() => {
      try {
        return app.getLocale();
      } catch {
        return null;
      }
    })(),
    cpus: os.cpus()?.length,
    totalMemGB: +(os.totalmem() / 1_073_741_824).toFixed(1),
    freeMemGB: +(os.freemem() / 1_073_741_824).toFixed(1),
    uptimeMin: Math.round(os.uptime() / 60),
  };
}

/** Keeps only the newest MAX_REPORTS report files. */
function pruneReports() {
  const { reports } = dirs();
  try {
    const files = fs
      .readdirSync(reports)
      .filter((name) => name.startsWith("report-"))
      .sort();
    for (const name of files.slice(0, Math.max(0, files.length - MAX_REPORTS))) {
      try {
        fs.unlinkSync(path.join(reports, name));
      } catch {
        // Ignore files that are locked.
      }
    }
  } catch {
    // Ignore a missing directory.
  }
}

/**
 * Creates a report file for an error.
 *
 * @param {any} error
 * @param {object} [context]
 * @returns {string | null} Report id, or null when writing failed.
 */
function report(error, context = {}) {
  try {
    const normalized = normalizeError(error);
    const signature =
      (context.area || "") + "|" + (normalized.code || "") + "|" + normalized.message;
    const now = Date.now();

    if (!context.noDedupe && lastReport.sig === signature && now - lastReport.at < DEDUPE_MS) {
      return lastReport.id;
    }

    const id = ("" + now.toString(36) + crypto.randomBytes(2).toString("hex")).toUpperCase();

    let extraContext = {};
    try {
      extraContext = contextProvider() || {};
    } catch {
      // Ignore a broken context provider.
    }

    const payload = {
      id,
      createdAt: new Date(now).toISOString(),
      app: {
        version: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        packaged: app.isPackaged,
      },
      system: systemInfo(),
      error: normalized,
      context: { ...extraContext, ...context },
      log: ring.slice(),
    };

    const json = JSON.stringify(scrubDeep(payload), null, 2);
    const reportPath = path.join(
      dirs().reports,
      "report-" + new Date(now).toISOString().replace(/[:.]/g, "-") + "-" + id + ".json",
    );

    fs.writeFileSync(reportPath, json, "utf-8");
    pruneReports();

    lastReport = { sig: signature, at: now, id };
    write("ERROR", "report", "Создан отчёт " + id + ": " + normalized.message);
    return id;
  } catch (error) {
    try {
      write("ERROR", "report", "Не удалось создать отчёт: " + error.message);
    } catch {
      // Nothing else we can do.
    }
    return null;
  }
}

/** Finds a report file by its id. */
function findReportFile(id) {
  const { reports } = dirs();
  try {
    const name = fs
      .readdirSync(reports)
      .filter((entry) => entry.startsWith("report-") && entry.includes(String(id)))
      .sort()
      .pop();
    return name ? path.join(reports, name) : null;
  } catch {
    return null;
  }
}

/**
 * Builds the text that is copied to the clipboard when the user clicks
 * "Отправить в поддержку".
 *
 * @param {string} [reportId]
 */
function supportBundle(reportId) {
  const file = reportId ? findReportFile(reportId) : null;
  let parsed = null;
  if (file) {
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    } catch {
      // Corrupted report: fall back to the in-memory log.
    }
  }

  const lines = [];
  lines.push("🐞 Ошибка лаунчера WoohProject");
  lines.push("Код отчёта: " + (parsed?.id || reportId || "—"));
  lines.push(
    "Версия: " +
      (parsed?.app?.version || app.getVersion()) +
      " · Windows " +
      (parsed?.system?.release || os.release()),
  );
  if (parsed?.context?.area) {
    lines.push(
      "Где: " +
        parsed.context.area +
        (parsed.context.stage ? " (" + parsed.context.stage + ")" : ""),
    );
  }
  lines.push("Ошибка: " + (parsed?.error?.message || "—"));
  if (parsed?.context?.helper?.message) {
    lines.push("Помощник: " + parsed.context.helper.message);
  }

  const newline = "\n";
  const stack = String(parsed?.error?.stack || "")
    .split(newline)
    .slice(1, 6)
    .map((line) => line.trim())
    .join(newline);

  let text = lines.join(newline);
  if (stack) text += "" + newline + newline + "Стек:" + newline + stack;

  const logTail = (parsed?.log || ring).slice(-25).join(newline);
  const budget = SUMMARY_MAX - text.length - 40;
  if (budget > 200) {
    text +=
      "" +
      newline +
      newline +
      "Лог (хвост):" +
      newline +
      (logTail.length > budget ? "…" + logTail.slice(-budget) : logTail);
  }

  return { file, text: scrubPaths(text) };
}

function reportsDir() {
  return dirs().reports;
}

/** Returns the last `count` log lines. */
function logTail(count = 120) {
  return ring.slice(-count);
}

module.exports = {
  init,
  attachRenderer,
  report,
  reportsDir,
  logTail,
  write,
  supportBundle,
};
