"use strict";

/**
 * Steam integration.
 *
 * The launcher does not ask for a password. It detects the locally running
 * Steam client through the Windows registry, reads the active account from
 * `loginusers.vdf`, fetches the public profile and (optionally) obtains a
 * Steam Web API session ticket via the steamworks.js native module.
 *
 * All of this is local: the SteamID and persona name are only displayed in
 * the launcher UI. The session ticket is cached in memory and is never sent
 * anywhere by this code.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const { net } = require("electron");

const STEAM_ID64_BASE = 0x110000100000000n;
const STATE_CACHE_MS = 1500;
const WEB_TICKET_TTL_MS = 45 * 1000;

let cachedWebTicket = null;
let cachedWebTicketAt = 0;
let cachedWebTicketPromise = null;

/** Runs a command; resolves to stdout (empty on failure). */
function execAsync(command, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(command, args, { windowsHide: true, timeout, encoding: "utf-8" }, (error, stdout) =>
      resolve(error && !stdout ? "" : String(stdout || "")),
    );
  });
}

/** Checks whether a PID is alive (EPERM still means "alive but not ours"). */
function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** Converts a 32-bit Steam account id to a 64-bit SteamID string. */
function accountIdToSteam64(accountId) {
  return (STEAM_ID64_BASE + BigInt(accountId >>> 0)).toString();
}

/**
 * Reads the currently logged-in account from
 * `HKCU\Software\Valve\Steam\ActiveProcess`.
 */
async function readActiveProcess() {
  if (process.platform !== "win32") return null;
  const output = await execAsync("reg", ["query", "HKCU\\Software\\Valve\\Steam\\ActiveProcess"]);
  if (!output) return null;

  const readDword = (name) => {
    const match = output.match(new RegExp("\\b" + name + "\\s+REG_DWORD\\s+0x([0-9a-f]+)", "i"));
    return match ? parseInt(match[1], 16) : null;
  };

  return {
    pid: readDword("pid"),
    activeUser: readDword("ActiveUser"),
  };
}

/** Cached Steam installation directory. */
let steamPathCache;

async function getSteamInstallPath() {
  if (steamPathCache !== undefined) return steamPathCache;

  let steamPath = null;
  if (process.platform === "win32") {
    const output = await execAsync("reg", [
      "query",
      "HKCU\\Software\\Valve\\Steam",
      "/v",
      "SteamPath",
    ]);
    const match = output.match(/SteamPath\s+REG_SZ\s+(.+)/i);
    if (match) steamPath = path.normalize(match[1].trim().replace(/\//g, path.sep));
  }

  if (!steamPath || !fs.existsSync(steamPath)) {
    const candidates = [
      path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Steam"),
      path.join(process.env.ProgramFiles || "C:\\Program Files", "Steam"),
    ];
    steamPath = candidates.find((dir) => fs.existsSync(path.join(dir, "steam.exe"))) || null;
  }

  steamPathCache = steamPath;
  return steamPath;
}

async function steamExeRunning() {
  if (process.platform !== "win32") return true;
  const output = await execAsync("tasklist", ["/FI", "IMAGENAME eq steam.exe", "/NH"], 6000);
  return /steam\.exe/i.test(output);
}

/**
 * Parses Steam's `config/loginusers.vdf`.
 *
 * VDF is a simple nested format:
 *   "76561198000000000"
 *   {
 *       "AccountName"  "name"
 *       ...
 *   }
 *
 * @param {string} text
 */
function parseLoginUsers(text) {
  const users = [];
  const headers = [...text.matchAll(/"(\d{17})"\s*\{/g)];

  for (const header of headers) {
    const steamId = header[1];
    const bodyStart = header.index + header[0].length;

    let depth = 1;
    let cursor = bodyStart;
    while (cursor < text.length && depth > 0) {
      if (text[cursor] === "{") depth += 1;
      else if (text[cursor] === "}") depth -= 1;
      cursor += 1;
    }

    const body = text.slice(bodyStart, cursor - 1);
    const fields = {};
    for (const match of body.matchAll(/"([^"]+)"\s+"([^"]*)"/g)) {
      fields[match[1]] = match[2];
    }

    users.push({
      steamId,
      personaName: fields.PersonaName || fields.AccountName || "",
      accountName: fields.AccountName || "",
      mostRecent: fields.MostRecent === "1" || fields.AutoLogin === "1",
      timestamp: Number(fields.Timestamp) || 0,
      rememberPassword: fields.RememberPassword === "1",
    });
  }

  return users;
}

/** Picks the most recently used Steam account. */
function pickRecentUser(users) {
  return (
    users.find((user) => user.mostRecent) ||
    users.slice().sort((a, b) => b.timestamp - a.timestamp)[0] ||
    null
  );
}

async function getSteamUsersSnapshot() {
  const steamPath = await getSteamInstallPath();
  if (!steamPath) return [];
  try {
    const text = await fs.promises.readFile(
      path.join(steamPath, "config", "loginusers.vdf"),
      "utf-8",
    );
    return parseLoginUsers(text);
  } catch {
    return [];
  }
}

let stateCache = { at: 0, value: null };
let stateInflight = null;
let lastLogged = "";

/**
 * Determines whether Steam is running and logged in.
 * Sources are tried in order: registry -> tasklist -> loginusers.vdf.
 */
async function computeSteamState() {
  if (process.platform !== "win32") {
    return { running: true, loggedIn: true, ready: true, steamId: null, source: "non-win" };
  }

  const active = await readActiveProcess();
  let running = false;
  let activeUser = null;
  const sources = [];

  if (active) {
    sources.push("registry");
    running = Boolean(active.pid && pidAlive(active.pid));
    activeUser = active.activeUser && active.activeUser > 0 ? active.activeUser : null;
  }

  if (!running) {
    running = await steamExeRunning();
    if (running) sources.push("tasklist");
  }

  let loggedIn = running && activeUser !== null;
  let steamId = activeUser ? accountIdToSteam64(activeUser) : null;

  if (running && !loggedIn && !active) {
    const users = await getSteamUsersSnapshot();
    const recent = pickRecentUser(users);
    if (recent) {
      loggedIn = true;
      steamId = recent.steamId;
      sources.push("loginusers");
    }
  }

  const state = {
    running,
    loggedIn,
    ready: running && loggedIn,
    steamId,
    source: sources.join("+") || "none",
  };

  const signature = state.running + "|" + state.loggedIn + "|" + state.source;
  if (signature !== lastLogged) {
    lastLogged = signature;
    console.log(
      `[steam] running=${state.running} loggedIn=${state.loggedIn} (через ${state.source})`,
    );
  }
  return state;
}

/** Cached (1.5 s) Steam state. Concurrent callers share one in-flight computation. */
async function getSteamState() {
  if (stateCache.value && Date.now() - stateCache.at < STATE_CACHE_MS) return stateCache.value;
  if (stateInflight) return stateInflight;

  stateInflight = computeSteamState()
    .then((state) => {
      stateCache = { at: Date.now(), value: state };
      return state;
    })
    .finally(() => {
      stateInflight = null;
    });
  return stateInflight;
}

async function isSteamLoggedIn() {
  return (await getSteamState()).ready;
}

async function isSteamProcessRunning() {
  return (await getSteamState()).running;
}

async function getLikelySteamId64() {
  const state = await getSteamState();
  if (state.steamId) return state.steamId;
  const users = await getSteamUsersSnapshot();
  return pickRecentUser(users)?.steamId || null;
}

/** Fetches the public Steam profile (name + medium avatar). */
function fetchSteamProfile(steamId) {
  return new Promise((resolve, reject) => {
    const request = net.request("https://steamcommunity.com/profiles/" + steamId + "/?xml=1");
    let body = "";

    request.on("response", (response) => {
      response.on("data", (chunk) => {
        body += chunk.toString();
      });
      response.on("end", () => {
        const name =
          body.match(/<steamID><!\[CDATA\[(.+?)\]\]><\/steamID>/)?.[1] ||
          body.match(/<steamID>([^<]+)<\/steamID>/)?.[1] ||
          "Player";
        const avatar =
          body.match(/<avatarMedium><!\[CDATA\[(.+?)\]\]><\/avatarMedium>/)?.[1] ||
          body.match(/<avatarMedium>([^<]+)<\/avatarMedium>/)?.[1] ||
          "";
        resolve({ steamId, name, avatar });
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

/**
 * Resolves the active Steam profile. Returns null when Steam is not ready.
 * Falls back to the local persona name when the profile request fails.
 */
async function resolveActiveSteamProfile() {
  if (!(await isSteamLoggedIn())) return null;
  const steamId = await getLikelySteamId64();
  if (!steamId) return null;

  const users = await getSteamUsersSnapshot();
  const localUser = users.find((user) => user.steamId === steamId) || {};

  try {
    const profile = await Promise.race([
      fetchSteamProfile(steamId),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error("profile timeout")), 8000),
      ),
    ]);
    if (!profile.name || profile.name === "Player") {
      profile.name = localUser.personaName || localUser.accountName || profile.name;
    }
    return profile;
  } catch (error) {
    console.error("Steam profile fetch error:", error);
    return {
      steamId,
      name: localUser.personaName || localUser.accountName || "Player " + steamId.slice(-4),
      avatar: "",
    };
  }
}

/**
 * Returns a Steam Web API session ticket (hex) for the configured app id.
 * The result is cached for 45 seconds.
 *
 * @param {number | string} appId
 */
async function getSteamSessionTicket(appId) {
  const numericAppId = Number(appId);
  const now = Date.now();

  if (cachedWebTicket && cachedWebTicketAt > 0 && now - cachedWebTicketAt < WEB_TICKET_TTL_MS) {
    return cachedWebTicket;
  }
  if (cachedWebTicketPromise) return cachedWebTicketPromise;

  cachedWebTicketPromise = (async () => {
    if (!numericAppId) {
      const error = new Error("Steam App ID не настроен в config.json");
      error.code = "STEAM_APP_ID";
      throw error;
    }
    if (!(await isSteamLoggedIn())) {
      const error = new Error("Сначала войдите через Steam.");
      error.code = "STEAM";
      throw error;
    }

    let steamworks;
    try {
      steamworks = require("steamworks.js");
    } catch {
      const error = new Error("Модуль steamworks.js не установлен.");
      error.code = "STEAMWORKS_MISSING";
      throw error;
    }

    const client = steamworks.init(numericAppId);
    if (!client) {
      const error = new Error(
        "Не удалось получить Steam Session Ticket. Проверьте Steam и App ID.",
      );
      error.code = "STEAM_TICKET";
      throw error;
    }

    let ticket;
    try {
      ticket = await client.auth.getAuthTicketForWebApi("wooh-auth");
    } catch (cause) {
      const error = new Error(
        "Не удалось получить Steam Session Ticket: " + (cause?.message || cause),
      );
      error.code = "STEAM_TICKET";
      throw error;
    }

    if (!ticket || typeof ticket.getBytes !== "function") {
      const error = new Error("Steam вернул пустой тикет. Проверьте Steam и App ID.");
      error.code = "STEAM_TICKET";
      throw error;
    }

    const hex = ticket.getBytes().toString("hex");
    cachedWebTicket = hex;
    cachedWebTicketAt = Date.now();
    return hex;
  })();

  try {
    return await cachedWebTicketPromise;
  } finally {
    cachedWebTicketPromise = null;
  }
}

/** Fetches a ticket in the background (used right after login). */
function prewarmSteamSessionTicket(appId) {
  void getSteamSessionTicket(appId).catch(() => {});
}

function clearSteamSessionTicketCache() {
  cachedWebTicket = null;
  cachedWebTicketAt = 0;
  cachedWebTicketPromise = null;
}

function isSteamRunning() {
  return isSteamLoggedIn();
}

module.exports = {
  isSteamRunning,
  isSteamProcessRunning,
  isSteamLoggedIn,
  getSteamState,
  resolveActiveSteamProfile,
  getSteamSessionTicket,
  prewarmSteamSessionTicket,
  clearSteamSessionTicketCache,
};
