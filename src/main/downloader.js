"use strict";

/**
 * Resumable, multi-source file downloader.
 *
 * Features:
 *  - downloads several files in parallel (configurable concurrency);
 *  - tries every configured mirror before giving up on a file;
 *  - resumes partial downloads using HTTP Range requests;
 *  - falls back to fixed-size chunks when a mirror drops long connections;
 *  - survives locked files (the game is running) by moving the old file away;
 *  - reports progress (bytes, speed, ETA) through an EventEmitter.
 *
 * The downloader is transport-agnostic: HTTP requests go through Electron's
 * network stack (so the "system"/"direct" transport modes and the proxy
 * settings apply), or through Node's http/https modules when `net-transport`
 * selects the "node" mode.
 */

const { EventEmitter } = require("events");
const {
  createWriteStream,
  existsSync,
  statSync,
  unlinkSync,
  chmodSync,
  renameSync,
} = require("fs");
const { mkdir, unlink } = require("fs/promises");
const http = require("http");
const https = require("https");
const path = require("path");
const { resolveInstallPath } = require("./integrity");

/** Headers that make the mirrors treat us like a normal browser download. */
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
};

/** Returns the current size of a file, or 0 when it does not exist. */
function diskSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

/**
 * @typedef {Object} DownloadItem
 * @property {{ path: string, size: number, sha256?: string }} file
 * @property {string} targetRoot
 * @property {boolean} [chunked]      Switched to chunked mode after a failure.
 * @property {number} [unlockTries]   How many times we tried to unlock the file.
 */

/**
 * @typedef {Object} DownloadSource
 * @property {string} name
 * @property {string} url
 * @property {boolean} [sustained]
 */

class DownloadManager extends EventEmitter {
  /** @param {number} [concurrency] Number of files downloaded simultaneously. */
  constructor(concurrency = 8) {
    super();
    this.concurrency = concurrency;
    this.cancelled = false;
    this.queue = [];
    this.completedBytes = 0;
    /** @type {Map<string, number>} absolute path -> expected size */
    this.activeFiles = new Map();
    this.totalBytes = 0;
    this.completedFiles = 0;
    this.totalFiles = 0;
    this.speedSamples = [];
    this.lastSpeedUpdate = Date.now();
    this.bytesSinceLastUpdate = 0;
    this.paused = false;
    /** @type {Set<any>} */
    this.activeRequests = new Set();
    this.chunkSize = 16 * 1024 * 1024;
    this.chunkMaxFailsInRow = 8;
    this.attemptsPerSource = 2;
    this.stallTimeoutMs = 20_000;
    this.preferredSource = null;
    this.currentSource = null;
  }

  /** Bytes downloaded so far, including the partial progress of active files. */
  get downloadedBytes() {
    let total = this.completedBytes;
    for (const [filePath, expectedSize] of this.activeFiles) {
      total += Math.min(diskSize(filePath), expectedSize);
    }
    return Math.min(total, this.totalBytes);
  }

  /** Stops the download and aborts all active requests. */
  cancel() {
    this.cancelled = true;
    this.queue = [];
    for (const request of this.activeRequests) {
      this.abortRequest(request, "CANCELLED");
    }
    this.activeRequests.clear();
  }

  /** Pauses the download. Active requests are aborted and the files are retried on resume. */
  pause() {
    this.paused = true;
    for (const request of this.activeRequests) {
      this.abortRequest(request, "PAUSED");
    }
  }

  /** Resumes a paused download. */
  resume() {
    this.paused = false;
  }

  /** Emits a progress event, averaging the speed over the last few samples. */
  emitProgress(extra = {}) {
    const now = Date.now();
    const elapsed = now - this.lastSpeedUpdate;
    if (elapsed >= 500) {
      const speed = (this.bytesSinceLastUpdate / elapsed) * 1000;
      this.speedSamples.push(speed);
      if (this.speedSamples.length > 10) this.speedSamples.shift();
      this.bytesSinceLastUpdate = 0;
      this.lastSpeedUpdate = now;
    }

    const speedBps =
      this.speedSamples.length > 0
        ? this.speedSamples.reduce((sum, sample) => sum + sample, 0) / this.speedSamples.length
        : 0;
    const downloadedBytes = this.downloadedBytes;
    const remainingBytes = Math.max(0, this.totalBytes - downloadedBytes);
    const etaReliable =
      speedBps > 65_536 && downloadedBytes >= 4 * 1024 * 1024 && this.speedSamples.length >= 4;
    const etaSeconds = etaReliable ? remainingBytes / speedBps : null;

    this.emit("progress", {
      phase: "downloading",
      downloadedBytes,
      totalBytes: this.totalBytes,
      speedBps,
      etaSeconds,
      completedFiles: this.completedFiles,
      totalFiles: this.totalFiles,
      source: this.currentSource,
      ...extra,
    });
  }

  /**
   * Downloads every file in `files` into `targetRoot`.
   *
   * Files are ordered largest-first, then interleaved with the smallest ones
   * so that large files start early and small files finish quickly.
   *
   * @param {Array<{ path: string, size: number }>} files
   * @param {string} targetRoot
   * @param {DownloadSource[]} sources
   */
  async downloadAll(files, targetRoot, sources) {
    this.cancelled = false;
    this.completedBytes = 0;
    this.activeFiles.clear();
    this.totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    this.completedFiles = 0;
    this.totalFiles = files.length;
    this.speedSamples = [];
    this.lastSpeedUpdate = Date.now();
    this.bytesSinceLastUpdate = 0;

    const sorted = files.slice().sort((a, b) => (b.size || 0) - (a.size || 0));
    const ordered = [];
    let head = 0;
    let tail = sorted.length - 1;
    while (head <= tail) {
      ordered.push(sorted[head++]);
      if (head <= tail) ordered.push(sorted[tail--]);
      if (head <= tail) ordered.push(sorted[tail--]);
    }

    /** @type {DownloadItem[]} */
    this.queue = ordered.map((file) => ({ file, targetRoot }));

    this.emitProgress({ phase: "downloading" });

    const progressTimer = setInterval(() => {
      if (!this.cancelled) this.emitProgress();
    }, 250);

    const workers = Array.from({ length: this.concurrency }, () => this.worker(sources));
    try {
      await Promise.all(workers);
    } finally {
      clearInterval(progressTimer);
    }
    if (this.cancelled) throw new Error("Загрузка отменена");
  }

  /** One download worker: pulls items from the queue until it is empty. */
  async worker(sources) {
    while (!this.cancelled) {
      while (this.paused && !this.cancelled) {
        await new Promise((resolve) => setTimeout(resolve, 150));
      }

      const item = this.queue.shift();
      if (!item) break;

      const targetPath = resolveInstallPath(item.targetRoot, item.file.path);
      this.activeFiles.set(targetPath, item.file.size || 0);
      try {
        await this.downloadFile(item, sources);
        this.activeFiles.delete(targetPath);
        this.completedBytes += item.file.size || 0;
        this.completedFiles++;
        this.emitProgress({ currentFile: item.file.path });
      } catch (error) {
        if (error && error.code === "PAUSED") {
          // Keep the item at the front of the queue; the partial file is resumed later.
          this.queue.unshift(item);
          continue;
        }
        this.activeFiles.delete(targetPath);
        if (error && error.code === "CANCELLED") continue;
        if (!this.cancelled) throw error;
      }
    }
  }

  /** Returns sources ordered so that the last successful mirror is tried first. */
  orderedSources(sources) {
    const normalized = sources
      .map((source) => (typeof source === "string" ? { name: source, url: source } : source))
      .filter((source) => source && source.url);
    if (!this.preferredSource) return normalized;
    return [...normalized].sort(
      (a, b) => (b.url === this.preferredSource) - (a.url === this.preferredSource),
    );
  }

  /**
   * Downloads a single file, trying every source and every attempt.
   *
   * @param {DownloadItem} item
   * @param {DownloadSource[]} sources
   */
  async downloadFile(item, sources) {
    const targetPath = resolveInstallPath(item.targetRoot, item.file.path);
    await mkdir(path.dirname(targetPath), { recursive: true });

    const encodedPath = item.file.path
      .replace(/\\/g, "/")
      .split("/")
      .map(encodeURIComponent)
      .join("/");

    let lastError = null;

    for (const source of this.orderedSources(sources)) {
      const fileUrl = source.url.replace(/\/$/, "") + "/" + encodedPath;

      for (let attempt = 0; attempt < this.attemptsPerSource; attempt++) {
        if (attempt > 0) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)));
        }
        if (this.cancelled) {
          const error = new Error("Отменено");
          error.code = "CANCELLED";
          throw error;
        }
        if (this.paused) {
          const error = new Error("Пауза");
          error.code = "PAUSED";
          throw error;
        }

        const expectedSize = item.file.size || 0;
        const sizeBeforeAttempt = diskSize(targetPath);

        try {
          this.currentSource = source.name;
          if (item.chunked) {
            await this.downloadChunked(fileUrl, targetPath, expectedSize);
          } else {
            await this.downloadFromUrl(fileUrl, targetPath, { expectedSize });
          }
          this.preferredSource = source.url;
          return;
        } catch (error) {
          if (error && (error.code === "PAUSED" || error.code === "CANCELLED")) throw error;
          lastError = error instanceof Error ? error : new Error(String(error));

          // The file is locked (usually by the running game): try to move it away.
          if (error?.httpStatus === 499) {
            item.unlockTries = (item.unlockTries || 0) + 1;
            if (
              item.unlockTries <= 3 &&
              (await this.unlockForWrite(targetPath, item.unlockTries))
            ) {
              attempt--;
              continue;
            }
            error.unlockFailed = true;
            throw error;
          }

          const received = Math.max(0, diskSize(targetPath) - sizeBeforeAttempt);
          console.warn(
            `[download] ${item.file.path}: ${lastError.message} ` +
              `(получено за попытку ${(received / 1_048_576).toFixed(1)} МБ, ` +
              `режим ${item.chunked ? "кусками" : "поток"})`,
          );

          // A long file on a flaky mirror: switch to resumable chunks.
          if (!item.chunked && !error?.httpStatus && expectedSize >= this.chunkSize * 4) {
            item.chunked = true;
            console.warn(
              `[download] ${item.file.path}: переключаюсь на загрузку кусками по ` +
                `${this.chunkSize / 1_048_576} МБ`,
            );
            attempt--;
            continue;
          }

          const status = error?.httpStatus;
          // A "real" 4xx (except timeouts / rate limits) means the file is not there:
          // no point in retrying this source.
          if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) break;
        }
      }

      if (this.preferredSource === source.url) this.preferredSource = null;
      this.emit("source-failed", {
        source: source.name,
        file: item.file.path,
        error: lastError?.message,
      });
    }

    const suffix = lastError?.message ? " (" + lastError.message + ")" : "";
    const error = new Error(`Не удалось скачать «${item.file.path}» ни с одного сервера${suffix}`);
    error.code = lastError?.code;
    error.filePath = item.file.path;
    error.chunked = Boolean(item.chunked);
    throw error;
  }

  /**
   * Tries to make a locked file writable: waits, removes the read-only flag,
   * then renames the old file so that a fresh one can be written.
   *
   * @returns {Promise<boolean>} true when the caller should retry.
   */
  async unlockForWrite(filePath, attempt) {
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
    if (this.cancelled || this.paused) return true;
    if (!existsSync(filePath)) return true;

    try {
      chmodSync(filePath, 0o666);
    } catch {
      // Ignore: the rename below is the real test.
    }

    try {
      renameSync(filePath, filePath + ".wooh-old-" + Date.now());
      console.warn(
        `[download] ${path.basename(filePath)}: старый файл был заблокирован — отодвинул его в сторону`,
      );
      return true;
    } catch (error) {
      console.warn(
        `[download] ${path.basename(filePath)}: не удалось освободить файл ` +
          `(${error.code || error.message}), попытка ${attempt}`,
      );
      return attempt < 3;
    }
  }

  /**
   * Downloads a file in fixed-size chunks, resuming after every connection
   * drop. This is what makes 100+ MB files survive unstable mirrors.
   *
   * @param {string} url
   * @param {string} targetPath
   * @param {number} totalSize
   */
  async downloadChunked(url, targetPath, totalSize) {
    let failsInRow = 0;
    let chunkSize = this.chunkSize;

    for (;;) {
      if (this.cancelled) {
        const error = new Error("Отменено");
        error.code = "CANCELLED";
        throw error;
      }
      if (this.paused) {
        const error = new Error("Пауза");
        error.code = "PAUSED";
        throw error;
      }

      let downloaded = diskSize(targetPath);
      if (downloaded > totalSize) {
        try {
          unlinkSync(targetPath);
        } catch {
          // The next write will truncate it anyway.
        }
        downloaded = 0;
      }
      if (downloaded === totalSize) return;

      const rangeEnd = Math.min(downloaded + chunkSize, totalSize) - 1;

      try {
        await this.downloadFromUrl(url, targetPath, {
          expectedSize: totalSize,
          rangeEnd,
        });
        failsInRow = 0;
      } catch (error) {
        if (error && (error.code === "PAUSED" || error.code === "CANCELLED")) throw error;

        const status = error?.httpStatus;
        if (status && status >= 400 && status < 500 && status !== 408 && status !== 429)
          throw error;

        const nowDownloaded = diskSize(targetPath);
        if (nowDownloaded > downloaded) {
          // We are making progress, so the connection dropped mid-chunk.
          // Smaller chunks are more likely to survive.
          if (chunkSize > 2 * 1024 * 1024) {
            chunkSize = Math.max(2 * 1024 * 1024, Math.floor(chunkSize / 2));
            console.warn(
              `[download] ${path.basename(targetPath)}: соединение рвётся — ` +
                `кусок уменьшен до ${(chunkSize / 1_048_576).toFixed(0)} МБ`,
            );
          }
          failsInRow = 0;
        } else if (++failsInRow >= this.chunkMaxFailsInRow) {
          throw error;
        }

        await new Promise((resolve) =>
          setTimeout(resolve, failsInRow ? Math.min(8000, 400 * 2 ** failsInRow) : 300),
        );
      }
    }
  }

  /** Memoized Electron `net` module, or null when it is unavailable. */
  electronNet() {
    if (this._electronNet !== undefined) return this._electronNet;
    try {
      const { net } = require("electron");
      this._electronNet = net && typeof net.request === "function" ? net : null;
    } catch {
      this._electronNet = null;
    }
    return this._electronNet;
  }

  /** Aborts an HTTP request regardless of whether it is an Electron or Node request. */
  abortRequest(request, reason) {
    if (!request || request.__woohAborted) return;
    request.__woohAborted = true;
    if (!request.__woohAbortReason) request.__woohAbortReason = reason;
    try {
      if (request.__woohElectron) {
        request.abort();
      } else if (typeof request.destroy === "function") {
        request.destroy();
      } else if (typeof request.abort === "function") {
        request.abort();
      }
    } catch {
      // The request is already gone.
    }
  }

  /** Returns the transport mode from net-transport (defaults to "system"). */
  transportMode() {
    try {
      return require("./net-transport").current().mode;
    } catch {
      return "system";
    }
  }

  /**
   * Starts a GET request using the configured transport.
   *
   * @param {string} url
   * @param {Record<string, string>} headers
   * @param {(response: any, request: any) => void} onResponse
   * @param {(error: Error, request: any) => void} onError
   */
  openGet(url, headers, onResponse, onError) {
    const mode = this.transportMode();
    const electronNet = mode === "node" ? null : this.electronNet();

    if (electronNet) {
      let chromiumSession = null;
      try {
        chromiumSession = require("./net-transport").chromiumSession(mode);
      } catch {
        // Fall back to the default session.
      }

      const request = electronNet.request(
        chromiumSession ? { method: "GET", url, session: chromiumSession } : { method: "GET", url },
      );
      request.__woohElectron = true;
      for (const [name, value] of Object.entries(headers)) request.setHeader(name, value);

      let stallTimer = setTimeout(() => this.abortRequest(request, "TIMEOUT"), this.stallTimeoutMs);
      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };

      request.on("response", (response) => {
        clearStallTimer();
        onResponse(response, request);
      });
      request.on("error", (error) => {
        clearStallTimer();
        onError(error, request);
      });
      request.on("abort", () => {
        clearStallTimer();
        onError(new Error("Прервано"), request);
      });
      request.end();
      return request;
    }

    const client = url.startsWith("https") ? https : http;
    const request = client.get(url, { timeout: this.stallTimeoutMs, headers }, (response) =>
      onResponse(response, request),
    );
    request.on("error", (error) => onError(error, request));
    request.on("timeout", () => {
      try {
        request.destroy();
      } catch {
        // Already destroyed.
      }
      onError(new Error("Таймаут соединения с сервером"), request);
    });
    return request;
  }

  /**
   * Downloads `url` into `targetPath`, resuming an existing partial file.
   *
   * @param {string} url
   * @param {string} targetPath
   * @param {{
   *   redirects?: number,
   *   noResume?: boolean,
   *   expectedSize?: number,
   *   rangeEnd?: number,
   *   expectedStatus?: number,
   * }} [options]
   * @returns {Promise<void>}
   */
  downloadFromUrl(url, targetPath, options = {}) {
    return new Promise((resolve, reject) => {
      const filePath = targetPath;
      const headers = { ...BROWSER_HEADERS };
      const redirects = options.redirects || 0;

      let settled = false;
      let writeStream = null;
      let response = null;
      let failed = false;
      let stallTimer = null;

      const clearStallTimer = () => {
        if (stallTimer) {
          clearTimeout(stallTimer);
          stallTimer = null;
        }
      };
      const armStallTimer = (request) => {
        clearStallTimer();
        stallTimer = setTimeout(() => this.abortRequest(request, "STALL"), this.stallTimeoutMs);
      };
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearStallTimer();
        if (error) reject(error);
        else resolve();
      };

      let startOffset = 0;
      const expectedSize = typeof options.expectedSize === "number" ? options.expectedSize : null;

      if (options.noResume) {
        try {
          if (existsSync(filePath)) unlinkSync(filePath);
        } catch {
          // Ignore: createWriteStream will truncate.
        }
      } else if (existsSync(filePath)) {
        try {
          startOffset = statSync(filePath).size;
        } catch {
          startOffset = 0;
        }
        if (expectedSize != null && startOffset >= expectedSize) {
          // A stale, already complete file: start from scratch.
          try {
            unlinkSync(filePath);
          } catch {
            // Ignore.
          }
          startOffset = 0;
        }
        if (startOffset > 0) headers.Range = "bytes=" + startOffset + "-";
      }

      const rangeEnd = typeof options.rangeEnd === "number" ? options.rangeEnd : null;
      if (rangeEnd != null) headers.Range = "bytes=" + startOffset + "-" + rangeEnd;

      /**
       * Handles a failed request: aborts it and waits for the write stream to
       * close before rejecting, so a partially written file stays consistent.
       */
      const fail = (request, error) => {
        if (settled || failed) return;
        failed = true;
        clearStallTimer();

        const abortReason = request && request.__woohAbortReason;
        const wasPaused = abortReason === "PAUSED" || this.paused;
        const wasCancelled = abortReason === "CANCELLED" || this.cancelled;

        this.abortRequest(request, abortReason || "ERROR");
        this.cleanupRequest(request);

        const afterClose = () => {
          if (wasCancelled) {
            unlink(filePath)
              .catch(() => {})
              .finally(() => {
                const cancelled = new Error("Отменено");
                cancelled.code = "CANCELLED";
                finish(cancelled);
              });
            return;
          }
          if (wasPaused) {
            const paused = new Error("Пауза");
            paused.code = "PAUSED";
            finish(paused);
            return;
          }
          finish(error || new Error("Соединение оборвано (" + path.basename(targetPath) + ")"));
        };

        if (writeStream && !writeStream.closed) {
          if (response) {
            try {
              response.unpipe(writeStream);
            } catch {
              // Already unplugged.
            }
          }
          writeStream.once("close", afterClose);
          writeStream.destroy();
        } else {
          afterClose();
        }
      };

      const request = this.openGet(
        url,
        headers,
        (res, req) => {
          response = res;
          this.activeRequests.add(req);

          // --- Redirects -------------------------------------------------
          if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
            const location = res.headers.location;
            res.resume();
            this.cleanupRequest(req);
            if (!location || redirects >= 10) {
              finish(new Error("Слишком много перенаправлений сервера"));
              return;
            }
            this.downloadFromUrl(new URL(location, url).toString(), targetPath, {
              ...options,
              redirects: redirects + 1,
            })
              .then(() => finish())
              .catch(finish);
            return;
          }

          // --- Stale resume point ----------------------------------------
          if (res.statusCode === 416 && startOffset > 0 && !options.noResume) {
            res.resume();
            this.cleanupRequest(req);
            this.downloadFromUrl(url, targetPath, { ...options, noResume: true })
              .then(() => finish())
              .catch(finish);
            return;
          }

          // --- Status validation ----------------------------------------
          let resuming = startOffset > 0;
          if (resuming && res.statusCode === 200) {
            // The server ignored our Range header: start the file over.
            resuming = false;
            startOffset = 0;
            try {
              if (existsSync(filePath)) unlinkSync(filePath);
            } catch {
              // Ignore.
            }
          }

          const rangeRequested = resuming || rangeEnd != null;
          let statusOk = rangeRequested ? res.statusCode === 206 : res.statusCode === 200;
          if (rangeRequested && !resuming && res.statusCode === 200) statusOk = true;
          if (options.expectedStatus) statusOk = res.statusCode === options.expectedStatus;

          if (!statusOk) {
            res.resume();
            this.cleanupRequest(req);
            const error = new Error(
              "Сервер ответил " + res.statusCode + " на " + path.basename(targetPath),
            );
            error.httpStatus = res.statusCode;
            finish(error);
            return;
          }

          // --- Write the response body ----------------------------------
          writeStream = createWriteStream(filePath, resuming ? { flags: "a" } : {});
          armStallTimer(req);

          res.on("data", (chunk) => {
            if (this.cancelled || this.paused) {
              clearStallTimer();
              this.abortRequest(req, this.paused ? "PAUSED" : "CANCELLED");
              return;
            }
            armStallTimer(req);
            this.bytesSinceLastUpdate += chunk.length;
          });
          res.on("error", (error) => fail(req, error));
          res.on("aborted", () => fail(req, null));

          writeStream.on("error", (error) => {
            if (
              error &&
              (error.code === "EBUSY" || error.code === "EPERM" || error.code === "EACCES")
            ) {
              const locked = new Error(
                "Файл занят: " +
                  path.basename(targetPath) +
                  ". Закройте игру (RustClient.exe) и нажмите «Обновить» ещё раз.",
              );
              locked.code = error.code;
              locked.httpStatus = 499;
              fail(req, locked);
              return;
            }
            fail(req, error);
          });

          res.pipe(writeStream);

          writeStream.on("finish", async () => {
            clearStallTimer();
            if (settled || failed) return;
            try {
              if (this.cancelled) {
                try {
                  if (existsSync(filePath)) await unlink(filePath);
                } catch {
                  // Ignore.
                }
                this.cleanupRequest(req);
                const cancelled = new Error("Отменено");
                cancelled.code = "CANCELLED";
                finish(cancelled);
                return;
              }
              if (!existsSync(targetPath)) {
                this.cleanupRequest(req);
                const missing = new Error("Файл не найден после загрузки");
                missing.code = "TMP_MISSING";
                finish(missing);
                return;
              }
              this.cleanupRequest(req);
              finish();
            } catch (error) {
              this.cleanupRequest(req);
              finish(error);
            }
          });
        },
        (error, req) => fail(req, error),
      );

      this.activeRequests.add(request);
      if (this.cancelled || this.paused) {
        this.abortRequest(request, this.cancelled ? "CANCELLED" : "PAUSED");
      }
    });
  }

  /** Removes a request from the active set. */
  cleanupRequest(request) {
    this.activeRequests.delete(request);
  }
}

module.exports = { DownloadManager };
