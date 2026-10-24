"use strict";

/**
 * Smoke/behaviour tests for the rebuilt launcher.
 *
 * The main-process modules depend on Electron. We install a small mock in the
 * require cache before loading them, so the tests can run with plain Node.
 * The renderer is exercised in jsdom with a stubbed `window.electronAPI`.
 */

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const Module = require("module");
const { once } = require("events");

const ROOT = path.resolve(__dirname, "..");
const TMP_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "wooh-test-"));
const USER_DATA = path.join(TMP_ROOT, "user-data");

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

async function run() {
  let passed = 0;
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      passed++;
      console.log("  ok  " + name);
    } catch (error) {
      failed++;
      console.error("FAIL  " + name);
      console.error(error);
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed;
}

// ---------------------------------------------------------------------------
// Electron mock
// ---------------------------------------------------------------------------

const exposedBridges = [];
const ipcListeners = new Map();

const electronMock = {
  app: {
    getPath(name) {
      if (name === "userData") return USER_DATA;
      return path.join(TMP_ROOT, name);
    },
    getVersion: () => "1.2.5",
    getLocale: () => "ru",
    isPackaged: false,
    commandLine: { appendSwitch() {} },
    whenReady: () => Promise.resolve(),
    configureHostResolver() {},
    setAppUserModelId() {},
    on() {},
    quit() {},
  },
  net: {},
  session: {
    defaultSession: { fetch: (url, options) => fetch(url, options) },
    fromPartition: () => ({
      setProxy: async () => {},
      fetch: (url, options) => fetch(url, options),
    }),
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle() {}, on() {} },
  dialog: {},
  shell: {},
  clipboard: { writeText() {} },
  contextBridge: {
    exposeInMainWorld(name, api) {
      exposedBridges.push({ name, api });
    },
  },
  ipcRenderer: {
    send() {},
    invoke: async () => null,
    on(channel, listener) {
      ipcListeners.set(channel, listener);
    },
    removeListener() {},
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "electron") return electronMock;
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function makeTempDir(name) {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

/**
 * Starts a small static file server with HTTP Range support.
 * Routes are absolute paths -> { body, status?, dropAfter? }.
 */
async function startFileServer(routes) {
  const server = http.createServer((request, response) => {
    const route = routes[request.url.split("?")[0]];
    if (!route) {
      response.writeHead(404, { "Content-Length": 0 });
      response.end();
      return;
    }
    if (route.status) {
      response.writeHead(route.status, { "Content-Length": 0 });
      response.end();
      return;
    }

    const body = route.body;
    const range = request.headers.range;
    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (!match) {
        response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
        response.end();
        return;
      }
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
      if (start >= body.length) {
        response.writeHead(416, { "Content-Range": `bytes */${body.length}` });
        response.end();
        return;
      }
      response.writeHead(206, {
        "Content-Type": "application/octet-stream",
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${body.length}`,
        "Accept-Ranges": "bytes",
      });
      response.end(body.subarray(start, end + 1));
      return;
    }

    response.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": body.length,
      "Accept-Ranges": "bytes",
    });
    response.end(body);
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  return { server, port, baseUrl: `http://127.0.0.1:${port}` };
}

// ---------------------------------------------------------------------------
// Tests: integrity
// ---------------------------------------------------------------------------

const integrity = require(path.join(ROOT, "src/main/integrity.js"));

test("integrity: detects missing, size and hash mismatches", async () => {
  const dir = makeTempDir("integrity");
  const good = Buffer.from("good file contents");
  const wrongHash = Buffer.from("wrong hash file");
  const wrongSize = Buffer.from("short");

  fs.writeFileSync(path.join(dir, "good.bin"), good);
  fs.writeFileSync(path.join(dir, "wrong-hash.bin"), wrongHash);
  fs.writeFileSync(path.join(dir, "wrong-size.bin"), wrongSize);

  const manifest = {
    files: [
      { path: "good.bin", size: good.length, sha256: sha256(good) },
      { path: "wrong-hash.bin", size: wrongHash.length, sha256: "0".repeat(64) },
      { path: "wrong-size.bin", size: 999, sha256: sha256(wrongSize) },
      { path: "missing.bin", size: 1, sha256: "0".repeat(64) },
    ],
  };

  const result = await integrity.checkIntegrity(dir, manifest);
  assert.equal(result.total, 4);
  assert.equal(result.valid, 1);
  assert.equal(result.missing.length, 1);
  assert.equal(result.missing[0].path, "missing.bin");
  assert.equal(result.corrupted.length, 2);
  assert.deepEqual(result.corrupted.map((file) => file.path).sort(), [
    "wrong-hash.bin",
    "wrong-size.bin",
  ]);

  const quick = await integrity.quickCheckIntegrity(dir, manifest);
  assert.equal(quick.valid, 2);
  assert.equal(quick.corrupted.length, 1);
  assert.equal(quick.corrupted[0].path, "wrong-size.bin");

  assert.equal(integrity.isPlayerFile("player.cfg"), true);
  assert.equal(integrity.isPlayerFile("maps/foo.map"), true);
  assert.equal(integrity.isPlayerFile("temp/x"), true);
  assert.equal(integrity.isPlayerFile("RustClient.exe"), false);

  const filesToDownload = integrity.getFilesToDownload(result);
  assert.equal(filesToDownload.length, 3);
});

test("integrity: smart check uses the verified cache and hashes critical files", async () => {
  const dir = makeTempDir("integrity-smart");
  const data = Buffer.from("RustClient binary");
  const config = Buffer.from("player config");
  fs.writeFileSync(path.join(dir, "RustClient.exe"), data);
  fs.writeFileSync(path.join(dir, "client.cfg"), config);

  const manifest = {
    files: [
      { path: "RustClient.exe", size: data.length, sha256: sha256(data) },
      { path: "client.cfg", size: config.length, sha256: sha256(config) },
    ],
  };

  const first = await integrity.smartCheckIntegrity(dir, manifest);
  assert.equal(first.valid, 2);
  assert.equal(first.hashed, 1, "critical exe is hashed");
  assert.equal(first.missing.length, 0);
  assert.ok(first.verified["RustClient.exe"]);

  const second = await integrity.smartCheckIntegrity(dir, manifest, undefined, first.verified);
  assert.equal(second.valid, 2);
  assert.equal(second.hashed, 1, "critical exe is hashed again, cfg is not");

  fs.writeFileSync(path.join(dir, "RustClient.exe"), Buffer.from("tampered binary!!"));
  const tampered = await integrity.smartCheckIntegrity(dir, manifest, undefined, first.verified);
  assert.equal(tampered.corrupted.length, 1);
  assert.equal(tampered.corrupted[0].path, "RustClient.exe");
});

test("integrity: rejects manifest paths that escape the install directory", async () => {
  const dir = makeTempDir("integrity-traversal");
  const manifest = {
    files: [{ path: "../outside.bin", size: 1, sha256: "0".repeat(64) }],
  };
  await assert.rejects(
    () => integrity.checkIntegrity(dir, manifest),
    /Некорректный путь в manifest/,
  );
  assert.throws(() => integrity.resolveInstallPath(dir, "..\\outside.bin"), /Некорректный путь/);
  assert.equal(
    integrity.resolveInstallPath(dir, "Data/../RustClient.exe"),
    path.join(dir, "RustClient.exe"),
  );
});

test("integrity: hashes a streamed file", async () => {
  const dir = makeTempDir("integrity-hash");
  const file = path.join(dir, "a.bin");
  const data = crypto.randomBytes(200_000);
  fs.writeFileSync(file, data);
  assert.equal(await integrity.hashFile(file), sha256(data));
});

// ---------------------------------------------------------------------------
// Tests: downloader
// ---------------------------------------------------------------------------

const { DownloadManager } = require(path.join(ROOT, "src/main/downloader.js"));

function makeDownloadFixture() {
  const files = {
    "a.bin": crypto.randomBytes(300_000),
    "b.bin": crypto.randomBytes(120_000),
    "c.bin": crypto.randomBytes(5_000),
  };
  const routes = {};
  for (const [name, body] of Object.entries(files)) {
    routes["/files/" + name] = { body };
  }
  return { files, routes };
}

test("downloader: downloads multiple files with progress", async () => {
  const { files, routes } = makeDownloadFixture();
  const { server, baseUrl } = await startFileServer(routes);
  try {
    const target = makeTempDir("download-all");
    const manager = new DownloadManager(2);
    const progress = [];
    manager.on("progress", (event) => progress.push(event));

    await manager.downloadAll(
      Object.entries(files).map(([name, body]) => ({ path: name, size: body.length })),
      target,
      [{ name: "local", url: baseUrl + "/files" }],
    );

    for (const [name, body] of Object.entries(files)) {
      assert.ok(fs.readFileSync(path.join(target, name)).equals(body), name + " matches");
    }
    assert.ok(progress.length > 0, "progress events emitted");
    const last = progress[progress.length - 1];
    assert.equal(last.totalBytes, 425_000);
    assert.equal(last.completedFiles, 3);
  } finally {
    await closeServer(server);
  }
});

test("downloader: resumes a partial file with a Range request", async () => {
  const body = crypto.randomBytes(80_000);
  const { server, baseUrl } = await startFileServer({ "/files/part.bin": { body } });
  try {
    const target = makeTempDir("download-resume");
    const filePath = path.join(target, "part.bin");
    fs.writeFileSync(filePath, body.subarray(0, 12_345));

    const manager = new DownloadManager(1);
    await manager.downloadFile(
      { file: { path: "part.bin", size: body.length }, targetRoot: target },
      [{ name: "local", url: baseUrl + "/files" }],
    );
    assert.ok(fs.readFileSync(filePath).equals(body));
  } finally {
    await closeServer(server);
  }
});

test("downloader: resumes in chunks after a partial download", async () => {
  const body = crypto.randomBytes(50_000);
  const { server, baseUrl } = await startFileServer({ "/files/chunk.bin": { body } });
  try {
    const target = makeTempDir("download-chunk");
    const filePath = path.join(target, "chunk.bin");
    fs.writeFileSync(filePath, body.subarray(0, 1_000));

    const manager = new DownloadManager(1);
    manager.chunkSize = 4_000;
    await manager.downloadChunked(baseUrl + "/files/chunk.bin", filePath, body.length);
    assert.ok(fs.readFileSync(filePath).equals(body));
  } finally {
    await closeServer(server);
  }
});

test("downloader: reports failure when every source returns 404", async () => {
  const { server, baseUrl } = await startFileServer({});
  try {
    const target = makeTempDir("download-404");
    const manager = new DownloadManager(1);
    let error = null;
    try {
      await manager.downloadFile({ file: { path: "nope.bin", size: 10 }, targetRoot: target }, [
        { name: "broken", url: baseUrl + "/files" },
      ]);
    } catch (caught) {
      error = caught;
    }
    assert.ok(error);
    assert.match(error.message, /ни с одного сервера/);
    assert.equal(error.filePath, "nope.bin");
  } finally {
    await closeServer(server);
  }
});

test("downloader: refuses to write outside the install directory", async () => {
  const target = makeTempDir("download-traversal");
  const manager = new DownloadManager(1);
  await assert.rejects(
    () =>
      manager.downloadFile({ file: { path: "../escape.bin", size: 10 }, targetRoot: target }, [
        { name: "local", url: "http://127.0.0.1:1/files" },
      ]),
    /Некорректный путь в manifest/,
  );
  assert.equal(fs.existsSync(path.join(target, "..", "escape.bin")), false);
});

test("downloader: pause and resume flags", () => {
  const manager = new DownloadManager(1);
  manager.pause();
  assert.equal(manager.paused, true);
  manager.resume();
  assert.equal(manager.paused, false);
  manager.cancel();
  assert.equal(manager.cancelled, true);
});

// ---------------------------------------------------------------------------
// Tests: game-update
// ---------------------------------------------------------------------------

const transport = require(path.join(ROOT, "src/main/net-transport.js"));
const gameUpdate = require(path.join(ROOT, "src/main/game-update.js"));

test("game-update: verify + download + verify again", async () => {
  const files = {
    "a.bin": crypto.randomBytes(60_000),
    "b.bin": crypto.randomBytes(2_000),
  };
  const routes = {
    "/cdn/manifest.json": {
      body: Buffer.from(
        JSON.stringify({
          files: Object.entries(files).map(([name, body]) => ({
            path: name,
            size: body.length,
            sha256: sha256(body),
          })),
        }),
      ),
    },
  };
  for (const [name, body] of Object.entries(files)) routes["/cdn/" + name] = { body };

  const { server, baseUrl } = await startFileServer(routes);
  const originalFetchVia = transport.fetchVia;
  transport.fetchVia = async (url, options) => {
    // Serve the manifest through the local server; everything else uses fetch too.
    return fetch(url, options);
  };

  try {
    const config = {
      gameCdn: {
        manifestPath: "/manifest.json",
        downloadConcurrency: 2,
        mirrors: [{ name: "local", url: baseUrl + "/cdn" }],
      },
    };
    const installPath = makeTempDir("game-update");

    const before = await gameUpdate.verifyGame(config, installPath);
    assert.equal(before.installed, false);
    assert.equal(before.filesToDownload.length, 2);
    assert.equal(before.total, 2);

    await gameUpdate.downloadGame(
      config,
      installPath,
      before.manifest,
      before.filesToDownload,
      () => {},
    );

    const after = await gameUpdate.verifyGame(config, installPath);
    assert.equal(after.installed, true);
    assert.equal(after.filesToDownload.length, 0);

    for (const [name, body] of Object.entries(files)) {
      assert.ok(fs.readFileSync(path.join(installPath, name)).equals(body));
    }

    // Corrupt a file and check that it is detected and repaired.
    fs.writeFileSync(path.join(installPath, "a.bin"), Buffer.from("broken"));
    const broken = await gameUpdate.verifyGame(config, installPath, undefined, { fast: false });
    assert.equal(broken.installed, false);
    assert.equal(broken.corrupted.length, 1);
  } finally {
    transport.fetchVia = originalFetchVia;
    await closeServer(server);
  }
});

test("game-update: falls back to a cached manifest when the CDN is unreachable", async () => {
  const installPath = makeTempDir("game-update-offline");
  const body = Buffer.from("offline file");
  fs.writeFileSync(path.join(installPath, "offline.bin"), body);
  const fallbackManifest = {
    files: [{ path: "offline.bin", size: body.length, sha256: sha256(body) }],
  };

  const config = {
    gameCdn: {
      manifestPath: "/manifest.json",
      mirrors: [{ name: "dead", url: "http://127.0.0.1:1" }],
    },
  };

  const result = await gameUpdate.verifyGame(config, installPath, undefined, {
    fallbackManifest,
    fast: true,
  });
  assert.equal(result.offline, true);
  assert.equal(result.installed, true);
});

// ---------------------------------------------------------------------------
// Tests: launcher-update / net-doctor / helper / zapret
// ---------------------------------------------------------------------------

const launcherUpdate = require(path.join(ROOT, "src/main/launcher-update.js"));
const netDoctor = require(path.join(ROOT, "src/main/net-doctor.js"));
const helper = require(path.join(ROOT, "src/main/helper.js"));
const zapret = require(path.join(ROOT, "src/main/zapret-fix.js"));

test("launcher-update: compares dotted versions", () => {
  assert.equal(launcherUpdate.compareVersions("1.2.5", "1.2.5"), 0);
  assert.equal(launcherUpdate.compareVersions("1.2.6", "1.2.5"), 1);
  assert.equal(launcherUpdate.compareVersions("1.2", "1.2.0"), 0);
  assert.equal(launcherUpdate.compareVersions("1.10.0", "1.9.9"), 1);
  assert.equal(launcherUpdate.compareVersions("2.0", "10.0"), -1);
  assert.equal(launcherUpdate.compareVersions("1.2.5-beta", "1.2.5"), 0);
  assert.equal(launcherUpdate.getInstallRoot(), null, "development mode skips updates");
});

test("net-doctor: classifies network failures", () => {
  assert.equal(netDoctor.classify("ERR_INTERNET_DISCONNECTED"), "offline");
  assert.equal(netDoctor.classify("getaddrinfo ENOTFOUND example.com"), "dns");
  assert.equal(netDoctor.classify("net::ERR_CERT_AUTHORITY_INVALID"), "tls");
  assert.equal(netDoctor.classify("ERR_PROXY_CONNECTION_FAILED"), "proxy");
  assert.equal(netDoctor.classify("socket hang up ECONNRESET"), "blocked");
  assert.equal(netDoctor.classify("HTTP 503"), "http");
  assert.equal(netDoctor.classify("weird"), "unknown");
});

test("net-doctor: probes a URL and a sustained download", async () => {
  const body = crypto.randomBytes(1_500_000);
  const { server, baseUrl } = await startFileServer({ "/probe.bin": { body } });
  try {
    const small = await netDoctor.probe(baseUrl + "/probe.bin", "node");
    assert.equal(small.ok, true);

    const sustained = await netDoctor.probe(
      { url: baseUrl + "/probe.bin", sustained: true },
      "node",
    );
    assert.equal(sustained.ok, true);
    assert.ok(sustained.bytes >= 1_000_000);
  } finally {
    await closeServer(server);
  }
});

test("helper: classifies errors and launch block codes", async () => {
  assert.equal(helper.classify({ code: "ENOSPC" }), "disk_full");
  assert.equal(helper.classify({ code: "EACCES" }), "no_access");
  assert.equal(helper.classify({ httpStatus: 499 }), "busy");
  assert.equal(helper.classify({ code: "UNKNOWN" }), "av_blocked");
  assert.equal(helper.classify(new Error("net::ERR_CONNECTION_RESET")), "network");
  assert.equal(helper.classify(new Error("Проверка скачанных файлов не пройдена.")), "integrity");
  assert.equal(helper.classify(new Error("something else")), "unknown");

  assert.deepEqual(await helper.launchBlockAdvice(740, "", null, ""), { error: "ELEVATION" });
  assert.equal((await helper.launchBlockAdvice(2, "", null, "")).error, "GAME_EXE_MISSING");
  assert.equal((await helper.launchBlockAdvice(193, "", null, "")).error, "GAME_EXE_INVALID");
  assert.equal((await helper.launchBlockAdvice(1260, "", null, "")).error, "POLICY_BLOCKED");

  const diskFull = await helper.tryFix({ code: "ENOSPC" }, { installPath: TMP_ROOT });
  assert.equal(diskFull.kind, "disk_full");
  assert.match(diskFull.message, /Не хватает места/);
});

test("zapret: appends domains to an exclusion list once", () => {
  const dir = makeTempDir("zapret");
  const listPath = path.join(dir, "list-exclude.txt");
  fs.writeFileSync(listPath, "example.com");

  const added = zapret._internal.addDomains(listPath);
  assert.deepEqual(added, ["huggingface.co", "hf.co", "gamemonitoring.ru"]);
  assert.match(fs.readFileSync(listPath, "utf-8"), /huggingface\.co/);

  assert.deepEqual(zapret._internal.addDomains(listPath), []);
  const lines = fs.readFileSync(listPath, "utf-8").split(/\r?\n/);
  assert.equal(lines.filter((line) => line === "hf.co").length, 1);
});

test("zapret: recognises a zapret installation", () => {
  const dir = makeTempDir("zapret-root");
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "lists"));
  fs.writeFileSync(path.join(dir, "bin", "winws.exe"), "");
  assert.equal(zapret._internal.looksLikeZapretRoot(dir), true);
  assert.equal(zapret._internal.looksLikeZapretRoot(path.join(dir, "missing")), false);
});

// ---------------------------------------------------------------------------
// Tests: bug-report / preload
// ---------------------------------------------------------------------------

const bugReport = require(path.join(ROOT, "src/main/bug-report.js"));

test("bug-report: scrubs URLs and writes a report", () => {
  bugReport.init({});
  console.log("hello from test");

  const id = bugReport.report(new Error("failed to fetch https://huggingface.co/datasets/a/b"), {
    area: "test",
    noDedupe: true,
  });
  assert.ok(id);

  const reports = fs.readdirSync(path.join(USER_DATA, "reports"));
  assert.equal(reports.length, 1);
  const reportJson = JSON.parse(
    fs.readFileSync(path.join(USER_DATA, "reports", reports[0]), "utf-8"),
  );
  assert.equal(reportJson.id, id);
  assert.match(reportJson.error.message, /\[сервер\]/);
  assert.doesNotMatch(reportJson.error.message, /huggingface/);
  assert.equal(reportJson.app.version, "1.2.5");
  assert.ok(reportJson.log.length > 0);

  const bundle = bugReport.supportBundle(id);
  assert.ok(bundle.file);
  assert.match(bundle.text, /Код отчёта/);
  assert.doesNotMatch(bundle.text, /huggingface/);

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.ok(fs.existsSync(path.join(USER_DATA, "logs", "launcher.log")));
      resolve();
    }, 150);
  });
});

test("preload: exposes the full renderer API", () => {
  require(path.join(ROOT, "src/main/preload.js"));
  assert.equal(exposedBridges.length, 1);
  const { name, api } = exposedBridges[0];
  assert.equal(name, "electronAPI");

  const expected = [
    "minimize",
    "close",
    "steamAuth",
    "isSteamRunning",
    "fetchServerData",
    "selectInstallPath",
    "verifyFiles",
    "quickCheckLocal",
    "launchGame",
    "installGame",
    "onGameLaunchIssue",
    "pauseGameInstall",
    "resumeGameInstall",
    "cancelGameInstall",
    "helperAction",
    "reportError",
    "diagnoseNetwork",
    "openReportsFolder",
    "supportSend",
    "supportLinks",
    "diagnoseGame",
    "zapretDetect",
    "zapretFix",
    "onNetDiagnoseProgress",
    "launcherUpdate",
    "onLauncherUpdateProgress",
    "onGameInstallProgress",
  ];
  for (const key of expected) assert.equal(typeof api[key], "function", key + " is exposed");

  const unsubscribe = api.onGameInstallProgress(() => {});
  assert.equal(typeof unsubscribe, "function");
});

// ---------------------------------------------------------------------------
// Tests: renderer in jsdom
// ---------------------------------------------------------------------------

test("renderer: boots, authenticates and renders server data", async () => {
  const { JSDOM } = require("jsdom");

  const html = fs
    .readFileSync(path.join(ROOT, "src/renderer/index.html"), "utf-8")
    .replace(/<link[^>]+fonts\.googleapis[^>]*>/g, "")
    .replace(/<link[^>]+fonts\.gstatic[^>]*>/g, "")
    .replace(/<script src="i18n\.js"><\/script>/, "")
    .replace(/<script src="app\.js"><\/script>/, "");

  const dom = new JSDOM(html, {
    url: "http://localhost/",
    runScripts: "outside-only",
    pretendToBeVisual: true,
  });
  const { window } = dom;

  window.alert = () => {};
  window.confirm = () => true;

  const progressSubscribers = [];
  let installToken = null;
  window.electronAPI = {
    minimize() {},
    close() {},
    steamAuth: async () => ({ steamId: "76561198000000000", name: "Tester", avatar: "" }),
    isSteamRunning: async () => ({ running: true, loggedIn: true, ready: true }),
    fetchServerData: async (serverId) => ({
      response: {
        hostname: serverId === 11_252_685 ? "MAIN | Test" : "COMBAT | Test",
        map: "Procedural Map",
        numplayers: serverId === 11_252_685 ? 10 : 5,
        queueplayers: 1,
        maxplayers: serverId === 11_252_685 ? 100 : 50,
        status: true,
      },
    }),
    selectInstallPath: async () => "C:\\WoohRustClient",
    verifyFiles: async () => ({ installed: true, filesToDownload: 0 }),
    quickCheckLocal: async () => ({ ok: true }),
    launchGame: async () => ({ launched: true }),
    installGame: async (_installPath, token) => {
      installToken = token;
      await new Promise((resolve) => setTimeout(resolve, 800));
      return { ok: true, status: "up_to_date", installed: true };
    },
    onGameLaunchIssue: () => () => {},
    pauseGameInstall: async () => ({ ok: true }),
    resumeGameInstall: async () => ({ ok: true }),
    cancelGameInstall: async () => ({ ok: true }),
    helperAction: async () => ({ ok: true }),
    reportError: async () => "REPORT1",
    diagnoseNetwork: async () => ({ ok: true, message: "ok" }),
    openReportsFolder: async () => true,
    supportSend: async () => ({ ok: true, hasFile: false }),
    supportLinks: async () => ({ telegram: true, discord: false }),
    diagnoseGame: async () => ({ running: false, missingKeyFiles: [] }),
    zapretDetect: async () => ({ tools: [], canFix: false }),
    zapretFix: async () => ({ ok: true }),
    onNetDiagnoseProgress: () => () => {},
    launcherUpdate: async () => ({ ok: true, status: "up_to_date" }),
    onLauncherUpdateProgress: () => () => {},
    onGameInstallProgress: (callback) => {
      progressSubscribers.push(callback);
      return () => {};
    },
  };

  window.eval(fs.readFileSync(path.join(ROOT, "src/renderer/i18n.js"), "utf-8"));
  window.eval(fs.readFileSync(path.join(ROOT, "src/renderer/app.js"), "utf-8"));

  await new Promise((resolve) => setTimeout(resolve, 1600));

  assert.equal(window.document.getElementById("user-name").textContent, "Tester");
  assert.equal(window.document.getElementById("btn-play-text").textContent, "Играть");
  assert.equal(window.document.getElementById("btn-play").disabled, false);
  assert.equal(window.document.getElementById("total-online").textContent, "17");
  assert.equal(window.document.getElementById("server-main-players").textContent, "11");
  assert.equal(window.document.getElementById("server-main-max").textContent, "100");
  assert.equal(window.document.getElementById("server-combat-name").textContent, "Test");
  assert.equal(progressSubscribers.length, 1);

  // Clicking "Play" runs the smart pre-launch check; while it is in progress
  // the install progress channel must drive the progress UI.
  window.document.getElementById("btn-play").click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  progressSubscribers[0]({
    phase: "downloading",
    token: installToken,
    totalBytes: 100,
    downloadedBytes: 50,
    speedBps: 1024 * 1024,
    completedFiles: 1,
    totalFiles: 2,
    source: "HF #1",
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(window.document.getElementById("progress-fill").style.width, "50%");

  window.close();
});

// ---------------------------------------------------------------------------
// Cleanup and run
// ---------------------------------------------------------------------------

run()
  .then((failed) => {
    Module._load = originalLoad;
    try {
      fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
      // Ignore.
    }
    // The app's log stream and jsdom keep handles open by design; the test
    // process is short-lived, so terminate explicitly once results are printed.
    setTimeout(() => process.exit(failed ? 1 : 0), 100);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
