"use strict";

/**
 * Game process monitoring and post-mortem diagnostics.
 *
 * After "Play" the launcher watches RustClient.exe to detect three typical
 * failures: the process never starts, it exits within the first 90 seconds, or
 * it is running but never creates a window ("hung"). In each case a diagnostic
 * bundle is collected: system event log entries, Visual C++ runtime presence,
 * antivirus products, Unity player logs, crash dumps and the account's admin
 * status. The bundle is attached to the bug report so support can help without
 * a remote session.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const EXE = "RustClient.exe";
const START_TIMEOUT_MS = 45_000;
const EARLY_EXIT_MS = 90_000;
const POLL_MS = 1000;

/** Runs a command and returns stdout as UTF-8. */
function run(command, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout, encoding: "utf-8", maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => resolve(error && !stdout ? "" : String(stdout || "")),
    );
  });
}

/** Returns the PIDs of running RustClient.exe processes. */
async function gamePids() {
  if (process.platform !== "win32") return new Set();
  const output = await run("tasklist", ["/FI", "IMAGENAME eq " + EXE, "/FO", "CSV", "/NH"]);
  return new Set(
    [...output.matchAll(/"RustClient\.exe","(\d+)"/gi)].map((match) => Number(match[1])),
  );
}

/**
 * Runs a console command and decodes its output using the OEM code page 866
 * (Russian Windows console encoding).
 */
function runConsole(command, args, timeout = 10_000) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout, encoding: "buffer", maxBuffer: 4 * 1024 * 1024 },
      (_error, stdout) => {
        const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.alloc(0);
        try {
          resolve(new TextDecoder("ibm866").decode(buffer));
        } catch {
          resolve(buffer.toString("latin1"));
        }
      },
    );
  });
}

/** Detects the "N/A" window title that a windowless process reports. */
function isNoWindowTitle(title) {
  const text = String(title || "").trim();
  return text === "" || /^(n\/a|н\/д|-)$/i.test(text) || (text.length <= 5 && text.includes("/"));
}

/** Returns detailed information about running RustClient.exe processes. */
async function processInfo() {
  if (process.platform !== "win32") return [];
  const output = await runConsole("tasklist", [
    "/V",
    "/FI",
    "IMAGENAME eq " + EXE,
    "/FO",
    "CSV",
    "/NH",
  ]);

  const processes = [];
  for (const line of output.split(/\r?\n/)) {
    const columns = [...line.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
    if (columns.length >= 9 && /rustclient\.exe/i.test(columns[0])) {
      processes.push({
        pid: Number(columns[1]),
        memory: columns[4],
        status: columns[5],
        cpuTime: columns[7],
        windowTitle: columns[8],
        hasWindow: !isNoWindowTitle(columns[8]),
      });
    }
  }
  return processes;
}

/** Reads the Unity company/product pair from `RustClient_Data/app.info`. */
function unityIds(installPath) {
  try {
    const [company, product] = fs
      .readFileSync(path.join(installPath, "RustClient_Data", "app.info"), "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trim());
    if (company && product) return { company, product };
  } catch {
    // Fall through to the Rust defaults.
  }
  return { company: "Facepunch Studios LTD", product: "Rust" };
}

/** Returns the last `lineCount` lines of a text file (at most 96 KiB is read). */
function tail(filePath, lineCount = 150) {
  try {
    const stats = fs.statSync(filePath);
    const fd = fs.openSync(filePath, "r");
    const bytesToRead = Math.min(stats.size, 96 * 1024);
    const buffer = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
    fs.closeSync(fd);
    return buffer.toString("utf-8").split(/\r?\n/).slice(-lineCount).join("\n");
  } catch {
    return null;
  }
}

/** Reads Unity's `Player.log` / `Player-prev.log`. */
function playerLog(installPath, startedAt) {
  const { company, product } = unityIds(installPath);
  const logDir = path.join(os.homedir(), "AppData", "LocalLow", company, product);
  const logFile = path.join(logDir, "Player.log");
  const previousFile = path.join(logDir, "Player-prev.log");

  try {
    const stats = fs.statSync(logFile);
    return {
      updatedThisLaunch: stats.mtimeMs >= startedAt - 2000,
      modifiedAt: new Date(stats.mtimeMs).toISOString(),
      tail: tail(logFile),
      prevTail: fs.existsSync(previousFile) ? tail(previousFile, 80) : null,
    };
  } catch {
    return {
      updatedThisLaunch: false,
      tail: null,
      prevTail: fs.existsSync(previousFile) ? tail(previousFile, 80) : null,
    };
  }
}

/** Returns the newest Unity crash folder created during this launch. */
function unityCrash(installPath, startedAt) {
  const { company, product } = unityIds(installPath);
  const crashDir = path.join(os.tmpdir(), company, product, "Crashes");
  try {
    const newest = fs
      .readdirSync(crashDir)
      .map((name) => ({
        name,
        mtime: fs.statSync(path.join(crashDir, name)).mtimeMs,
      }))
      .filter((entry) => entry.mtime >= startedAt - 2000)
      .sort((a, b) => b.mtime - a.mtime)[0];
    if (!newest) return null;
    return {
      folder: newest.name,
      errorLog: tail(path.join(crashDir, newest.name, "error.log"), 80),
    };
  } catch {
    return null;
  }
}

/** Checks whether the Microsoft Visual C++ 2015-2022 x64 runtime is installed. */
async function vcRuntimeInstalled() {
  for (const key of [
    "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64",
  ]) {
    const output = await run("reg", ["query", key, "/v", "Installed"]);
    if (/Installed\s+REG_DWORD\s+0x1/i.test(output)) return true;
  }
  return fs.existsSync(
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "vcruntime140_1.dll"),
  );
}

/**
 * Reads recent Application event-log entries mentioning RustClient, the
 * faulting module name, and the installed antivirus products.
 */
async function windowsEvents(since) {
  const seconds = Math.ceil((Date.now() - since) / 1000) + 60;
  const script = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$ev = Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddSeconds(-" +
      seconds +
      ")} -ErrorAction SilentlyContinue | Where-Object { $_.Message -match 'RustClient' } | Select-Object -First 5",
    "foreach ($e in $ev) { '=== ' + $e.TimeCreated.ToString('s') + ' ' + $e.ProviderName + ' id=' + $e.Id; $e.Message }",
    "'=== AV'",
    "try { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName } } catch {}",
  ].join("; ");

  const output = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    20_000,
  );
  const [eventsPart, antivirusPart] = output.split("=== AV");
  const faultingModule =
    (eventsPart || "").match(/(?:Faulting module name|Имя сбойного модуля):\s*([^\s,]+)/i)?.[1] ||
    null;

  return {
    events: (eventsPart || "").trim().slice(0, 6000) || null,
    faultingModule,
    antivirus: (antivirusPart || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
  };
}

let avCache = null;

/** Returns the names of installed antivirus products (cached for 10 minutes). */
async function antivirusNames() {
  if (process.platform !== "win32") return [];
  if (avCache && Date.now() - avCache.at < 600_000) return avCache.list;

  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8; try { Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction Stop | ForEach-Object { $_.displayName } } catch {}";
  const output = await run(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    15_000,
  );
  const list = [
    ...new Set(
      String(output || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];

  avCache = { at: Date.now(), list };
  return list;
}

/**
 * Reads Windows Smart App Control state.
 * 0 = off, 1 = on, 2 = evaluation mode. Returns null when unavailable.
 */
async function smartAppControlState() {
  if (process.platform !== "win32") return null;
  const output = await run("reg", [
    "query",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy",
    "/v",
    "VerifiedAndReputablePolicyState",
  ]);
  const match = output.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return match ? parseInt(match[1], 16) : null;
}

/**
 * Launches the game through PowerShell's ProcessStartInfo and returns the real
 * Win32 error code if Windows blocks the process (Smart App Control, policy,
 * antivirus). This is a diagnostic fallback when the normal spawn fails with
 * an unhelpful "UNKNOWN" error.
 *
 * @param {string} exePath
 * @param {string[]} args
 * @param {string} cwd
 */
async function probeLaunch(exePath, args, cwd) {
  if (process.platform !== "win32") {
    return { ok: false, code: null, message: "not windows" };
  }

  const quote = (value) =>
    /[\s"]/.test(value) ? '"' + String(value).replace(/"/g, '\\"') + '"' : String(value);

  const env = {
    ...process.env,
    WOOH_EXE: exePath,
    WOOH_CWD: cwd,
    WOOH_ARGS: args.map(quote).join(" "),
  };
  for (const key of Object.keys(env)) if (key.startsWith("ELECTRON_")) delete env[key];

  const script = [
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8",
    "$psi = New-Object System.Diagnostics.ProcessStartInfo",
    "$psi.FileName = $env:WOOH_EXE",
    "$psi.Arguments = $env:WOOH_ARGS",
    "$psi.WorkingDirectory = $env:WOOH_CWD",
    "$psi.UseShellExecute = $false",
    "$psi.EnvironmentVariables['__COMPAT_LAYER'] = 'RunAsInvoker'",
    "try { $p = [Diagnostics.Process]::Start($psi); 'WOOH-OK ' + $p.Id } catch { $e = $_.Exception; while ($e.InnerException) { $e = $e.InnerException }; 'WOOH-ERR ' + $e.NativeErrorCode + ' ' + $e.Message }",
  ].join("; ");

  const output = await new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 20_000, encoding: "utf-8", env },
      (_error, stdout) => resolve(String(stdout || "")),
    );
  });

  const success = output.match(/WOOH-OK (\d+)/);
  if (success) return { ok: true, pid: Number(success[1]) };

  const failure = output.match(/WOOH-ERR (-?\d+)?\s*(.*)/);
  return {
    ok: false,
    code: failure && failure[1] ? Number(failure[1]) : null,
    message: (failure ? failure[2] : output).trim().slice(0, 300),
  };
}

/** Returns whether the current user is an administrator (and whether the process is elevated). */
async function accountInfo() {
  if (process.platform !== "win32") return null;
  const whoami = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "whoami.exe");
  const output = await runConsole(whoami, ["/groups", "/fo", "csv", "/nh"]);
  if (!output) return { isAdmin: null };

  const adminGroupLine = output.split(/\r?\n/).find((line) => line.includes("S-1-5-32-544")) || "";
  return {
    isAdmin: Boolean(adminGroupLine),
    elevatedNow: Boolean(adminGroupLine) && !/deny only|только для запрета/i.test(adminGroupLine),
  };
}

/** Collects the tails of recently modified game logs (BepInEx, logs/). */
function recentGameLogs(installPath, since) {
  const result = [];
  const dirs = [installPath, path.join(installPath, "BepInEx"), path.join(installPath, "logs")];

  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!/\.(log|txt)$/i.test(name)) continue;
      const filePath = path.join(dir, name);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile() || stats.mtimeMs < since - 5000) continue;

        const fd = fs.openSync(filePath, "r");
        const bytesToRead = Math.min(stats.size, 4000);
        const buffer = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buffer, 0, bytesToRead, stats.size - bytesToRead);
        fs.closeSync(fd);
        result.push({ file: path.relative(installPath, filePath), tail: buffer.toString("utf8") });
      } catch {
        // Skip unreadable files.
      }
      if (result.length >= 4) return result;
    }
  }
  return result;
}

/**
 * Builds the full diagnostic bundle.
 *
 * @param {{ installPath: string, startedAt: number, kind: string, runtimeMs: number | null }} params
 */
async function collect({ installPath, startedAt, kind, runtimeMs }) {
  const keyFiles = ["RustClient.exe", "GameAssembly.dll", "UnityPlayer.dll", "winhttp.dll"].map(
    (name) => ({ name, ok: fs.existsSync(path.join(installPath, name)) }),
  );

  const [vcRuntime, windows, account] = await Promise.all([
    vcRuntimeInstalled(),
    windowsEvents(startedAt),
    accountInfo(),
  ]);

  return {
    kind,
    runtimeSec: runtimeMs != null ? Math.round(runtimeMs / 1000) : null,
    missingKeyFiles: keyFiles.filter((entry) => !entry.ok).map((entry) => entry.name),
    processes: await processInfo(),
    vcRuntime,
    account,
    playerLog: playerLog(installPath, startedAt),
    unityCrash: unityCrash(installPath, startedAt),
    gameLogs: recentGameLogs(installPath, startedAt),
    windows,
  };
}

/**
 * Watches a freshly launched game and reports a problem, or null when the
 * game looks healthy.
 *
 * @param {{ installPath: string, startedAt: number, prevPids: Set<number> }} params
 */
async function watch({ installPath, startedAt, prevPids }) {
  if (process.platform !== "win32") return null;

  let gamePid = null;
  let gameStartedAt = 0;

  // Wait for the process to appear.
  while (Date.now() - startedAt < START_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    const pids = await gamePids();
    gamePid = [...pids].find((pid) => !prevPids.has(pid)) || null;
    if (gamePid) {
      gameStartedAt = Date.now();
      break;
    }
  }

  if (!gamePid) {
    const log = playerLog(installPath, startedAt);
    const kind = log.updatedThisLaunch ? "early-exit" : "not-started";
    return {
      kind,
      runtimeMs: null,
      diag: await collect({ installPath, startedAt, kind, runtimeMs: null }),
    };
  }

  // The process exists: make sure it lives long enough to open a window.
  while (Date.now() - gameStartedAt < EARLY_EXIT_MS) {
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 2));
    const pids = await gamePids();
    if (!pids.has(gamePid)) {
      const runtimeMs = Date.now() - gameStartedAt;
      const log = playerLog(installPath, startedAt);
      if (log.updatedThisLaunch && /OnApplicationQuit|Steam Client Shutdown/.test(log.tail || "")) {
        console.log(
          `[launch] игра закрыта игроком через ${Math.round(runtimeMs / 1000)} с (штатный выход)`,
        );
        return null;
      }
      return {
        kind: "early-exit",
        runtimeMs,
        diag: await collect({ installPath, startedAt, kind: "early-exit", runtimeMs }),
      };
    }
  }

  // Still alive after 90 seconds: check whether it has a window.
  const info = (await processInfo()).find((process) => process.pid === gamePid);
  console.log(
    `[launch] игра работает > ${EARLY_EXIT_MS / 1000} с: окно="${info?.windowTitle ?? "?"}" ` +
      `состояние=${info?.status ?? "?"} память=${info?.memory ?? "?"}`,
  );

  if (info && !info.hasWindow) {
    const diagnostics = await collect({
      installPath,
      startedAt,
      kind: "hung",
      runtimeMs: Date.now() - gameStartedAt,
    });
    return {
      kind: "hung",
      runtimeMs: Date.now() - gameStartedAt,
      diag: { ...diagnostics, hungProcess: info },
    };
  }

  return null;
}

/** One-shot diagnostic snapshot (used by the "Game won't start" button). */
async function snapshot(installPath, startedAt) {
  const diagnostics = await collect({
    installPath,
    startedAt,
    kind: "manual",
    runtimeMs: null,
  });
  return { ...diagnostics, gameRunning: diagnostics.processes.length > 0 };
}

module.exports = {
  watch,
  gamePids,
  collect,
  snapshot,
  processInfo,
  antivirusNames,
  smartAppControlState,
  probeLaunch,
};
