"use strict";

/**
 * Network diagnostics ("Помощник").
 *
 * When a download keeps failing, this module probes the configured mirrors
 * through every transport mode (system / direct / node, with and without DoH)
 * and picks the first combination that can actually download data. It also
 * classifies the failure (offline, DNS, TLS, proxy, blocked, clock skew) so
 * the UI can show an actionable message.
 */

const http = require("http");
const transport = require("./net-transport");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const PROBE_TIMEOUT_MS = 10_000;

/** Small requests used to decide whether the machine has any internet at all. */
const INTERNET_PROBES = ["https://cp.cloudflare.com/generate_204", "https://ya.ru/"];

/** Transport combinations, tried in this order (current one first). */
const CANDIDATES = [
  { mode: "system", doh: false, label: "обычное подключение" },
  { mode: "direct", doh: false, label: "подключение в обход прокси" },
  { mode: "node", doh: false, label: "альтернативный сетевой стек" },
  { mode: "system", doh: true, label: "защищённый DNS" },
  { mode: "direct", doh: true, label: "защищённый DNS в обход прокси" },
];

function describeError(error) {
  const parts = [error?.message, error?.cause?.code, error?.cause?.message, error?.code].filter(
    Boolean,
  );
  return [...new Set(parts)].join(" / ") || String(error);
}

/** Maps an error string to a human-friendly cause. */
function classify(error) {
  const text = String(error || "");
  if (
    /ERR_INTERNET_DISCONNECTED|ENETUNREACH|ERR_NETWORK_CHANGED|ERR_ADDRESS_UNREACHABLE/i.test(text)
  ) {
    return "offline";
  }
  if (/CERT_DATE_INVALID|CERT_HAS_EXPIRED|not yet valid/i.test(text)) return "clock";
  if (/ERR_CERT|ERR_SSL|SSL|CERT_|self.signed|UNABLE_TO_VERIFY|certificate/i.test(text))
    return "tls";
  if (/ERR_PROXY|ERR_TUNNEL|PROXY/i.test(text)) return "proxy";
  if (/NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|DNS/i.test(text)) return "dns";
  if (
    /RESET|REFUSED|TIMED_OUT|ETIMEDOUT|timeout|aborted|ECONNRESET|ECONNREFUSED|CONNECTION_CLOSED|EMPTY_RESPONSE/i.test(
      text,
    )
  ) {
    return "blocked";
  }
  if (/HTTP 4\d\d|HTTP 5\d\d/.test(text)) return "http";
  return "unknown";
}

const SUSTAINED_BYTES = 6 * 1024 * 1024;
const SUSTAINED_TIMEOUT_MS = 25_000;

/**
 * Probes a URL. With `sustained: true` it downloads up to 6 MB and requires
 * at least 1 MB, which catches mirrors that answer headers but drop the body.
 *
 * @param {string | { url: string, sustained?: boolean }} target
 * @param {"system" | "direct" | "node"} mode
 */
async function probe(target, mode) {
  const url = typeof target === "string" ? target : target.url;
  const sustained = typeof target === "object" && target.sustained;
  const startedAt = Date.now();

  try {
    const response = await transport.fetchVia(
      url,
      {
        headers: {
          "User-Agent": UA,
          Range: sustained ? "bytes=0-" + (SUSTAINED_BYTES - 1) : "bytes=0-1023",
        },
        signal: AbortSignal.timeout(sustained ? SUSTAINED_TIMEOUT_MS : PROBE_TIMEOUT_MS),
        redirect: "follow",
      },
      mode,
    );

    const statusOk = response.status === 200 || response.status === 206 || response.status === 204;
    if (!statusOk) {
      try {
        await response.arrayBuffer();
      } catch {
        // Ignore body errors: the status already tells us everything.
      }
      return { ok: false, ms: Date.now() - startedAt, error: "HTTP " + response.status };
    }

    if (!sustained) {
      try {
        await response.arrayBuffer();
      } catch {
        // Ignore.
      }
      return { ok: true, ms: Date.now() - startedAt, error: null };
    }

    let received = 0;
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      if (received >= SUSTAINED_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Ignore.
        }
        break;
      }
    }

    const ok = received >= Math.min(SUSTAINED_BYTES, 1024 * 1024);
    return {
      ok,
      ms: Date.now() - startedAt,
      bytes: received,
      sustained: true,
      error: ok ? null : "поток оборвался на " + (received / 1_048_576).toFixed(1) + " МБ",
    };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      sustained,
      error: describeError(error),
    };
  }
}

/** Reads the `Date` header of a plain HTTP response to detect a wrong system clock. */
function clockSkewSeconds() {
  return new Promise((resolve) => {
    const request = http.get(
      "http://huggingface.co/",
      { timeout: 6000, headers: { "User-Agent": UA } },
      (response) => {
        response.resume();
        const serverDate = Date.parse(response.headers.date || "");
        resolve(Number.isFinite(serverDate) ? Math.round((Date.now() - serverDate) / 1000) : null);
      },
    );
    request.on("timeout", () => {
      request.destroy();
      resolve(null);
    });
    request.on("error", () => resolve(null));
  });
}

/**
 * Finds a working transport configuration for the given mirror targets.
 *
 * @param {Array<{ name: string, urls: Array<string | { url: string, sustained?: boolean }> }>} targets
 * @param {(message: string) => void} [onProgress]
 * @param {() => boolean} [shouldStop]
 */
async function diagnose(targets, onProgress = () => {}, shouldStop = () => false) {
  const initial = transport.current();
  /** @type {Array<object>} */
  const attempts = [];

  const cancelled = async () => {
    await transport.set(initial, { persist: false });
    return {
      ok: false,
      cause: "cancelled",
      message: "Проверка соединения отменена.",
      attempts,
    };
  };

  onProgress("Проверяю подключение к интернету…");

  const internetResults = await Promise.all(
    transport.MODES.flatMap((mode) => INTERNET_PROBES.map((url) => probe(url, mode))),
  );
  const hasInternet = internetResults.some((result) => result.ok);

  if (!hasInternet) {
    return {
      ok: false,
      cause: "offline",
      message: "Нет интернета. Проверьте Wi-Fi или провод и нажмите «Обновить».",
      attempts: internetResults.map((result, index) => ({
        step: "internet",
        target: "probe" + (index + 1),
        ...result,
      })),
    };
  }

  // Try the currently selected configuration first, then the alternatives.
  const candidates = [
    ...CANDIDATES.filter(
      (candidate) => candidate.mode === initial.mode && candidate.doh === initial.doh,
    ),
    ...CANDIDATES.filter(
      (candidate) => !(candidate.mode === initial.mode && candidate.doh === initial.doh),
    ),
  ];

  for (const candidate of candidates) {
    if (shouldStop()) return cancelled();

    onProgress("Помощник: пробую " + candidate.label + "…");
    await transport.set({ mode: candidate.mode, doh: candidate.doh }, { persist: false });

    const targetResults = await Promise.all(
      targets.map(async (target) => {
        const probes = await Promise.all(target.urls.map((url) => probe(url, candidate.mode)));
        for (const result of probes) {
          attempts.push({
            step: "" + candidate.mode + (candidate.doh ? "+doh" : ""),
            target: target.name,
            ...result,
          });
        }
        return probes.every((result) => result.ok);
      }),
    );

    if (targetResults.some(Boolean)) {
      await transport.set({ mode: candidate.mode, doh: candidate.doh }, { persist: true });
      const changed = candidate.mode !== initial.mode || candidate.doh !== initial.doh;
      return {
        ok: true,
        changed,
        mode: candidate.mode,
        doh: candidate.doh,
        label: candidate.label,
        message: changed ? "Нашёл, как подключиться." : "Связь в порядке.",
        attempts,
      };
    }
  }

  await transport.set(initial, { persist: false });

  const causes = attempts
    .filter((attempt) => !attempt.ok)
    .map((attempt) => classify(attempt.error));
  const hasCause = (cause) => causes.includes(cause);

  if (hasCause("tls") || hasCause("clock")) {
    const skew = await clockSkewSeconds();
    if (skew !== null && Math.abs(skew) > 300) {
      const minutes = Math.round(Math.abs(skew) / 60);
      return {
        ok: false,
        cause: "clock",
        clockSkewSec: skew,
        attempts,
        message:
          "На компьютере неправильное время (сбилось на " +
          minutes +
          " мин). Включите в Windows «Устанавливать время автоматически» и нажмите «Обновить».",
      };
    }
    return {
      ok: false,
      cause: "tls",
      clockSkewSec: skew,
      attempts,
      message: "Интернет обрывает загрузку игры. Включите VPN и нажмите «Обновить».",
    };
  }

  if (hasCause("proxy")) {
    return {
      ok: false,
      cause: "proxy",
      attempts,
      message:
        "Мешают настройки прокси в Windows. Выключите прокси или включите VPN и нажмите «Обновить».",
    };
  }

  return {
    ok: false,
    cause: hasCause("dns") ? "dns" : "blocked",
    attempts,
    message: "Сервер с игрой у вас не открывается. Включите VPN и нажмите «Обновить».",
  };
}

module.exports = { diagnose, classify, clockSkewSeconds, probe };
