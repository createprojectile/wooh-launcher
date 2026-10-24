"use strict";

/**
 * "Помощник" – automatic recovery advice for failed installs and launches.
 *
 * Given an error, this module classifies it and returns a user-facing message
 * plus an optional automatic action (retry, fix zapret, close the game, choose
 * another folder). The main process attaches this information to install
 * errors; the renderer shows a dialog and, when the action is safe, retries
 * automatically.
 */

const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const doctor = require("./net-doctor");
const zapret = require("./zapret-fix");

const GAME_PROCESSES = ["RustClient.exe", "UnityCrashHandler64.exe"];

function run(command, args) {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 8000, encoding: "utf-8" },
      (error, stdout) => resolve(error ? "" : String(stdout || "")),
    );
  });
}

async function isGameRunning() {
  if (process.platform !== "win32") return false;
  const output = await run("tasklist", ["/FI", "IMAGENAME eq RustClient.exe", "/NH"]);
  return /RustClient\.exe/i.test(output);
}

/** Force-closes the game and waits until the process is gone. */
async function closeGame() {
  for (const processName of GAME_PROCESSES) {
    await run("taskkill", ["/IM", processName, "/F", "/T"]);
  }
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!(await isGameRunning())) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return !(await isGameRunning());
}

/** Returns the free space (bytes) on the volume that contains `targetPath`. */
async function freeBytes(targetPath) {
  try {
    let existing = targetPath;
    while (existing && !fs.existsSync(existing)) existing = path.dirname(existing);
    const stats = await fs.promises.statfs(existing);
    return stats.bavail * stats.bsize;
  } catch {
    return null;
  }
}

const gb = (bytes) => (bytes / 1_073_741_824).toFixed(1);

/** True when the error looks like an antivirus blocking process creation. */
function isAvBlock(error) {
  const code = error?.code;
  const text = String(error?.message || error || "");
  return code === "UNKNOWN" || /\bUNKNOWN\b|spawn UNKNOWN|unknown error, open/i.test(text);
}

/** Builds an antivirus-specific explanation with the install path. */
async function antivirusMessage(installPath) {
  let names = [];
  try {
    names = await require("./game-watch").antivirusNames();
  } catch {
    // No antivirus information available.
  }
  const thirdParty = names.filter((name) => !/defender|защитник/i.test(name));
  const product = thirdParty.length
    ? "антивирус «" + thirdParty.join("», «") + "»"
    : "антивирус (Защитник Windows)";
  const folder = installPath ? "\n\nПапка с игрой: " + installPath : "";

  return (
    "Игру не пускает " +
    product +
    ".\n\nЧто сделать:\n1. Открой антивирус.\n2. Найди «Исключения» или «Доверенные».\n3. Добавь туда папку с игрой.\n4. Если игра попала в «Карантин» — нажми «Восстановить».\n5. Нажми «Играть».\n\nИли просто выключи антивирус, пока играешь." +
    folder
  );
}

/**
 * Converts a Windows launch error code into an actionable message.
 *
 * @param {number | null} code
 * @param {string} message
 * @param {number | null} smartAppControl Smart App Control registry state.
 * @param {string} installPath
 */
async function launchBlockAdvice(code, message, smartAppControl, installPath) {
  const text = String(message || "");

  if (code === 740) return { error: "ELEVATION" };

  if (code === 2 || code === 3) {
    return {
      error: "GAME_EXE_MISSING",
      message: "Игра не найдена. Нажми «Играть» — лаунчер скачает её.",
    };
  }

  if (code === 193 || code === 216) {
    return {
      error: "GAME_EXE_INVALID",
      message: "Файл игры испорчен. Нажми «Играть» — лаунчер скачает его заново.",
    };
  }

  const smartAppControlBlocked =
    (code >= 4550 && code <= 4590) ||
    /Application Control|Smart App|интеллектуальн|управлени[а-я]* приложени/i.test(text);

  if (smartAppControlBlocked || (smartAppControl === 1 && code !== 225 && code !== 226)) {
    return {
      error: "SMART_APP_CONTROL",
      message:
        "Игру не пускает сама Windows — функция «Интеллектуальное управление приложениями».\n" +
        "Антивирус тут ни при чём, поэтому исключения не помогли.\n\n" +
        "Что сделать:\n" +
        "1. Нажми «Пуск» и напиши: Безопасность Windows.\n" +
        "2. Открой «Управление приложениями и браузером».\n" +
        "3. Нажми «Параметры интеллектуального управления приложениями».\n" +
        "4. Выбери «Выкл.».\n" +
        "5. Нажми «Играть».\n\n" +
        "Важно: включить эту функцию обратно потом нельзя (только переустановкой Windows). Если компьютер не твой — спроси взрослого.",
    };
  }

  if (code === 1260 || code === 1250) {
    return {
      error: "POLICY_BLOCKED",
      message:
        "Запуск игр на этом компьютере запрещён настройками Windows.\n\nТак бывает на школьных и рабочих компьютерах. Попроси того, кто настраивал компьютер, разрешить запуск игры.",
    };
  }

  const antivirus = await antivirusMessage(installPath);
  return {
    error: "AV_BLOCKED",
    message: code ? antivirus + "\n\n(код Windows: " + code + ")" : antivirus,
  };
}

/** Classifies an install/download error into a recovery category. */
function classify(error) {
  const code = error?.code;
  const text = String(error?.message || error || "");

  if (isAvBlock(error)) return "av_blocked";
  if (code === "ENOSPC" || /ENOSPC|no space left|недостаточно места/i.test(text))
    return "disk_full";
  if (
    (code === "ENOENT" || code === "EINVAL") &&
    /mkdir|scandir|open/i.test((error?.syscall || "") + " " + text) &&
    !/manifest/i.test(text)
  ) {
    return "bad_path";
  }
  if (error?.httpStatus === 499 || code === "EBUSY" || /EBUSY|занят/i.test(text)) return "busy";
  if (
    code === "EACCES" ||
    code === "EPERM" ||
    /EACCES|EPERM|operation not permitted|access is denied/i.test(text)
  ) {
    return "no_access";
  }
  if (/Проверка скачанных файлов не пройдена/i.test(text)) return "integrity";
  if (
    /net::|ERR_|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|Таймаут|Соединение оборвано|ни с одного сервера|manifest|Сервер ответил 5\d\d|socket|TLS|SSL/i.test(
      text,
    )
  ) {
    return "network";
  }
  return "unknown";
}

/**
 * Produces a diagnosis and a possible fix for an install error.
 *
 * @param {any} error
 * @param {{
 *   installPath?: string,
 *   targets?: Array<{ name: string, urls: any[] }>,
 *   failedFile?: string,
 *   bytesNeeded?: number,
 *   onProgress?: (message: string) => void,
 *   shouldStop?: () => boolean,
 * }} [options]
 */
async function tryFix(error, options = {}) {
  const kind = classify(error);
  const reportProgress = (message) => {
    try {
      options.onProgress?.(message);
    } catch {
      // Progress reporting must never break recovery.
    }
  };

  switch (kind) {
    case "network": {
      try {
        const zapretState = await zapret.detect();
        if (zapretState.canFix) {
          return {
            kind,
            autoRetry: false,
            diagnosis: { zapret: zapretState },
            message: "Скачать игру мешает zapret (программа для Discord и YouTube).",
            confirm: {
              action: "zapret-fix",
              question: "Исправить? Игра скачается, а Discord и YouTube продолжат работать.",
            },
          };
        }

        const otherTools = zapretState.tools.filter(
          (tool) => !(tool === "zapret" && zapretState.alreadyFixed),
        );
        if (otherTools.length) {
          return {
            kind,
            autoRetry: false,
            diagnosis: { zapret: zapretState },
            message:
              "Скачать игру мешает программа " +
              otherTools.join(", ") +
              ".\n\nВыключите её, пока качается игра, и нажмите «Обновить». Потом её можно включить снова.",
          };
        }
      } catch {
        // The zapret check is best-effort.
      }

      reportProgress("Помощник: проверяю соединение с серверами…");
      const diagnosis = await doctor.diagnose(
        options.targets || [],
        reportProgress,
        options.shouldStop,
      );
      if (diagnosis.ok) {
        const message = diagnosis.changed
          ? "Помощник: нашёл, как подключиться. Продолжаю загрузку."
          : "Помощник: связь вернулась — продолжаю загрузку.";
        return { kind, autoRetry: true, message, diagnosis };
      }
      return {
        kind,
        autoRetry: false,
        message: diagnosis.message + "\n\nУже скачанное не пропадёт.",
        diagnosis,
      };
    }

    case "busy": {
      if (await isGameRunning()) {
        return {
          kind,
          autoRetry: false,
          message: "Игра сейчас открыта, поэтому её нельзя обновить.",
          confirm: {
            action: "close-game",
            question: "Закрыть игру и продолжить?",
          },
        };
      }
      if (error?.unlockFailed) {
        return {
          kind: "av_blocked",
          autoRetry: false,
          message: await antivirusMessage(options.installPath),
        };
      }
      reportProgress("Помощник: файл занят, пробую ещё раз…");
      await new Promise((resolve) => setTimeout(resolve, 2500));
      return {
        kind,
        autoRetry: true,
        message: "Помощник: файл был занят — пробую ещё раз.",
      };
    }

    case "disk_full": {
      const free = await freeBytes(options.installPath);
      const needed = options.bytesNeeded || 0;
      const freeText =
        free != null
          ? " Свободно " +
            gb(free) +
            " ГБ" +
            (needed ? ", нужно ещё ~" + gb(needed) + " ГБ" : "") +
            "."
          : "";
      return {
        kind,
        autoRetry: false,
        message:
          "Не хватает места на диске." +
          freeText +
          " Удалите что-нибудь ненужное или выберите другую папку.",
        confirm: {
          action: "choose-folder",
          question: "Выбрать другую папку для игры?",
        },
      };
    }

    case "no_access":
      return {
        kind,
        autoRetry: false,
        message: "В эту папку нельзя сохранять игру.",
        confirm: {
          action: "choose-folder",
          question: "Выбрать другую папку для игры?",
        },
      };

    case "bad_path":
      return {
        kind,
        autoRetry: false,
        message: "Папка для игры не найдена (может, отключена флешка или диск).",
        confirm: {
          action: "choose-folder",
          question: "Выбрать другую папку для игры?",
        },
      };

    case "av_blocked":
      return {
        kind,
        autoRetry: false,
        message: await antivirusMessage(options.installPath),
      };

    case "integrity":
      return {
        kind,
        autoRetry: true,
        message: "Помощник: часть файлов скачалась с ошибкой — качаю их заново.",
      };

    default:
      return { kind, autoRetry: false, message: null };
  }
}

/** Applies a user-confirmed automatic action. */
async function applyAction(action) {
  if (action === "close-game") return { ok: await closeGame() };
  return { ok: false };
}

module.exports = {
  tryFix,
  applyAction,
  classify,
  isGameRunning,
  isAvBlock,
  antivirusMessage,
  launchBlockAdvice,
};
