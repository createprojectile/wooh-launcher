"use strict";

/**
 * Network transport layer.
 *
 * The launcher can fetch files through three different network stacks:
 *
 *  - "system" – Chromium's default network stack (honours the Windows proxy,
 *    VPN and so on). This is what a normal user expects.
 *  - "direct" – a separate Chromium session that ignores the system proxy.
 *  - "node"   – Node's built-in `fetch` (undici), which has its own DNS/TLS
 *    behaviour and sometimes works where Chromium does not.
 *
 * Additionally the user can turn on DNS-over-HTTPS (DoH) for Chromium, which
 * helps when a local ISP poisons DNS answers for the download mirrors.
 *
 * The selected mode is persisted in `%APPDATA%/wooh-launcher/network.json`.
 */

const { app, net, session } = require("electron");
const fs = require("fs");
const path = require("path");

/** DoH resolvers used when "secure DNS" is enabled. */
const DOH_SERVERS = ["https://cloudflare-dns.com/dns-query", "https://dns.google/dns-query"];

/** Modes understood by {@link set} and the diagnostics module. */
const MODES = ["system", "direct", "node"];

/** @typedef {"system" | "direct" | "node"} TransportMode */

/** @type {{ mode: TransportMode, doh: boolean }} */
let state = {
  mode: "system",
  doh: false,
};

/** Lazily created Chromium session that bypasses the system proxy. */
let directSession = null;

function settingsPath() {
  return path.join(app.getPath("userData"), "network.json");
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    if (MODES.includes(saved.mode)) state.mode = saved.mode;
    state.doh = Boolean(saved.doh);
  } catch {
    // No settings file yet (or it is corrupted) – keep the defaults.
  }
}

function save() {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // A read-only userData directory must not crash the launcher.
  }
}

/**
 * Returns (and creates on first use) a Chromium session with a direct proxy.
 * The call is cached because `setProxy` only has to run once per process.
 */
async function getDirectSession() {
  if (!directSession) {
    directSession = session.fromPartition("wooh-direct");
    await directSession.setProxy({ mode: "direct" });
  }
  return directSession;
}

/** Applies the DoH setting to Chromium's host resolver. */
function applyDoh(enabled) {
  try {
    app.configureHostResolver(
      enabled
        ? {
            secureDnsMode: "secure",
            secureDnsServers: DOH_SERVERS,
          }
        : {
            secureDnsMode: "off",
          },
    );
  } catch (error) {
    console.warn("configureHostResolver failed:", error?.message);
  }
}

/** Loads persisted settings and applies them. Called once after app startup. */
async function init() {
  load();
  if (state.doh) applyDoh(true);
  if (state.mode === "direct") await getDirectSession();
  console.log(`[net] транспорт: mode=${state.mode} doh=${state.doh}`);
}

/** Returns a copy of the current transport settings. */
function current() {
  return { ...state };
}

/**
 * Updates the transport settings.
 *
 * @param {{ mode?: TransportMode, doh?: boolean }} next
 * @param {{ persist?: boolean }} [options]
 */
async function set(next, { persist = true } = {}) {
  if (next.mode && MODES.includes(next.mode)) {
    state.mode = next.mode;
    if (state.mode === "direct") await getDirectSession();
  }
  if (typeof next.doh === "boolean" && next.doh !== state.doh) {
    state.doh = next.doh;
    applyDoh(state.doh);
  }
  if (persist) save();
}

/**
 * Returns the Chromium session that should be used for a given transport mode.
 * Returns `null` for the "node" mode because it does not use Chromium at all.
 */
function chromiumSession(mode = state.mode) {
  if (mode === "node") return null;
  if (mode === "direct") return directSession || session.defaultSession;
  return session.defaultSession;
}

/**
 * Performs a `fetch`-style request through the requested transport.
 *
 * @param {string} url
 * @param {RequestInit} [options]
 * @param {TransportMode} [mode]
 * @returns {Promise<Response>}
 */
async function fetchVia(url, options = {}, mode = state.mode) {
  if (mode === "node") return fetch(url, options);
  if (mode === "direct") {
    const direct = await getDirectSession();
    return direct.fetch(url, options);
  }
  if (net && typeof net.fetch === "function") return net.fetch(url, options);
  return fetch(url, options);
}

module.exports = {
  init,
  current,
  set,
  chromiumSession,
  fetchVia,
  MODES,
};
