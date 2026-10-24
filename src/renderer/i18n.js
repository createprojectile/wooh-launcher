"use strict";

/**
 * Tiny i18n module (Russian / English).
 *
 * Loaded as a classic script before app.js. Exposes `window.i18n`:
 *   - t(key)              translate a dotted key;
 *   - getLang()/setLang() current language;
 *   - loadLang()          restore the language from localStorage;
 *   - getSteamBtnHtml()   Steam sign-in button markup;
 *   - getTranslations()   raw dictionary.
 *
 * Static markup is translated through `data-i18n`,
 * `data-i18n-title` and `data-i18n-placeholder` attributes.
 */

const LANG_STORAGE_KEY = "wooh-launcher-lang";

const translations = {
  ru: {
    pageTitle: "WoohProject — Лаунчер",
    titleBar: {
      minimize: "Свернуть",
      close: "Закрыть",
    },
    auth: {
      notAuthorized: "Не авторизован",
      loginSteamUpper: "ВОЙДИТЕ ЧЕРЕЗ STEAM",
      authorizing: "Авторизация...",
      logout: "Выйти из аккаунта",
      loggingOut: "Выход...",
    },
    steamGate: {
      checking: "Проверка Steam...",
      notRunning:
        "Steam не запущен.\n\nИгра не запустится без открытого Steam. Запустите клиент Steam, войдите в аккаунт и нажмите «Повторить».",
      selectAccount:
        "Выберите аккаунт в Steam.\n\nВ окне Steam выберите профиль, затем нажмите «Повторить».",
      retry: "Повторить",
    },
    launcherUpdate: {
      checking: "Проверка обновлений лаунчера...",
      verifying: "Проверка файлов лаунчера...",
      verifyingDownload: "Проверка загруженных файлов...",
      downloading: "Загрузка обновления лаунчера...",
      restarting: "Применение обновления. Лаунчер перезапустится...",
    },
    info: {
      title: "ИНФОРМАЦИЯ:",
      body: "Для входа в лаунчер требуется запущенный Steam с активным аккаунтом. Авторизация выполняется автоматически через ваш Steam-профиль.",
    },
    faq: {
      title: "ВОПРОСЫ И ОТВЕТЫ:",
      items: [
        {
          q: "Зачем нужен лаунчер?",
          a: "Лаунчер автоматически скачивает и обновляет игровой клиент, а также проверяет целостность файлов при каждом запуске. Это гарантирует стабильную работу игры.",
        },
        {
          q: "Это безопасно?",
          a: "Да. Лаунчер не собирает персональные данные и не имеет доступа к вашим паролям. Для входа используется только локальный Steam-клиент.",
        },
        {
          q: "Какие данные вы используете?",
          a: "Используется только ваш SteamID для идентификации. Никакие пароли, переписки или другая личная информация не хранятся.",
        },
        {
          q: "Потянет ли у меня?",
          a: "<strong>Мин. системные требования WoohRust:</strong><br><br>• ОС: Windows 10 (64-bit)<br>• Процессор: Intel Core i5-2300 / AMD FX-6300<br>• Оперативная память: 10–12 GB RAM<br>• Видеокарта: NVIDIA GeForce 8800 / ATI 3800 Series<br>• Место на диске: 19–20 GB свободного пространства (SSD)",
        },
        {
          q: "У меня проблема, где найти поддержку?",
          a: 'Напишите в наш бот технической поддержки в Telegram:<br><br><a href="https://t.me/woohreportbot" class="faq-link">t.me/woohreportbot</a>',
        },
      ],
    },
    play: {
      checking: "Проверка...",
      checkingFiles: "Проверка файлов...",
      signInSteam: "ВОЙДИТЕ ЧЕРЕЗ STEAM",
      install: "Установить",
      update: "Обновить",
      play: "Играть",
      launching: "Запуск...",
      downloading: "Загрузка...",
      paused: "Пауза",
      done: "Готово!",
      speedMbps: (value) => value + " МБ/с",
    },
    download: {
      pause: "Пауза",
      resume: "Продолжить",
      cancel: "Отмена",
      paused: "Пауза",
    },
    online: {
      total: "ОБЩИЙ ОНЛАЙН:",
    },
    bonus: {
      title: "Бонус за регистрацию",
      privilege: "Привилегия:",
      value: "LITE",
      duration: "3 дня",
    },
    news: {
      title: "Новости",
      items: [
        {
          title: "Вайп серверов!",
          date: "01.07.2026",
          desc: "Глобальный вайп на всех серверах. Новая карта, новые возможности! Заходите и начинайте своё приключение.",
        },
        {
          title: "Обновление античита",
          date: "20.06.2026",
          desc: "Мы обновили систему защиты. Теперь играть стало ещё честнее и безопаснее для каждого.",
        },
        {
          title: "Новый магазин",
          date: "01.02.2026",
          desc: "Открыт обновлённый магазин с эксклюзивными предметами. Загляните и оцените новинки!",
        },
      ],
    },
    settings: {
      title: "Настройки",
      installPath: "Путь установки:",
      browse: "Обзор",
      launchArgs: "Параметры запуска:",
      launchArgsPlaceholder: "-high -maxMem=16000",
      language: "Язык:",
      fab: "Настройки",
      help: "Помощь:",
      gameDiagnose: "Игра не запускается",
      netDiagnose: "Диагностика сети",
      openReports: "Папка отчётов",
    },
    social: {
      discord: "Discord",
      telegram: "Telegram",
      shop: "Магазин",
    },
    errors: {
      electronApi: "Electron API недоступен",
    },
  },

  en: {
    pageTitle: "WoohProject — Launcher",
    titleBar: {
      minimize: "Minimize",
      close: "Close",
    },
    auth: {
      notAuthorized: "Not signed in",
      loginSteamUpper: "SIGN IN WITH STEAM",
      authorizing: "Signing in...",
      logout: "Sign out",
      loggingOut: "Signing out...",
    },
    steamGate: {
      checking: "Checking Steam...",
      notRunning:
        'Steam is not running.\n\nThe game will not start without Steam open. Launch Steam, sign in to your account, and click "Retry".',
      selectAccount:
        'Select a Steam account.\n\nIn the Steam window, select your profile, then click "Retry".',
      retry: "Retry",
    },
    launcherUpdate: {
      checking: "Checking for launcher updates...",
      verifying: "Verifying launcher files...",
      verifyingDownload: "Verifying downloaded files...",
      downloading: "Downloading launcher update...",
      restarting: "Applying update. The launcher will restart...",
    },
    info: {
      title: "INFORMATION:",
      body: "The launcher requires Steam to be running with an active account. Sign-in happens automatically via your Steam profile.",
    },
    faq: {
      title: "FAQ:",
      items: [
        {
          q: "Why do I need the launcher?",
          a: "The launcher automatically downloads and updates the game client and verifies file integrity on every launch. This keeps the game stable.",
        },
        {
          q: "Is it safe?",
          a: "Yes. The launcher does not collect personal data or access your passwords. Only your local Steam client is used for sign-in.",
        },
        {
          q: "What data do you use?",
          a: "Only your SteamID for identification. Passwords, messages, and other personal data are not stored.",
        },
        {
          q: "Will it run on my PC?",
          a: "<strong>Minimum WoohRust system requirements:</strong><br><br>• OS: Windows 10 (64-bit)<br>• CPU: Intel Core i5-2300 / AMD FX-6300<br>• RAM: 10–12 GB<br>• GPU: NVIDIA GeForce 8800 / ATI 3800 Series<br>• Storage: 19–20 GB free space (SSD)",
        },
        {
          q: "I have a problem — where is support?",
          a: 'Contact our technical support bot on Telegram:<br><br><a href="https://t.me/woohreportbot" class="faq-link">t.me/woohreportbot</a>',
        },
      ],
    },
    play: {
      checking: "Verifying...",
      checkingFiles: "Checking files...",
      signInSteam: "SIGN IN WITH STEAM",
      install: "Install",
      update: "Update",
      play: "Play",
      launching: "Launching...",
      downloading: "Downloading...",
      paused: "Paused",
      done: "Done!",
      speedMbps: (value) => value + " MB/s",
    },
    download: {
      pause: "Pause",
      resume: "Resume",
      cancel: "Cancel",
      paused: "Paused",
    },
    online: {
      total: "TOTAL ONLINE:",
    },
    bonus: {
      title: "Registration bonus",
      privilege: "Privilege:",
      value: "LITE",
      duration: "3 days",
    },
    news: {
      title: "News",
      items: [
        {
          title: "Server wipe!",
          date: "07/01/2026",
          desc: "Global wipe on all servers. New map, new opportunities! Jump in and start your adventure.",
        },
        {
          title: "Anti-cheat update",
          date: "06/20/2026",
          desc: "We updated our protection system. The game is now fairer and safer for everyone.",
        },
        {
          title: "New store",
          date: "02/01/2026",
          desc: "The updated store is open with exclusive items. Check out what is new!",
        },
      ],
    },
    settings: {
      title: "Settings",
      installPath: "Install path:",
      browse: "Browse",
      launchArgs: "Launch arguments:",
      launchArgsPlaceholder: "-high -maxMem=16000",
      language: "Language:",
      fab: "Settings",
      help: "Help:",
      gameDiagnose: "Game won't start",
      netDiagnose: "Network check",
      openReports: "Reports folder",
    },
    social: {
      discord: "Discord",
      telegram: "Telegram",
      shop: "Store",
    },
    errors: {
      electronApi: "Electron API is unavailable",
    },
  },
};

let currentLang = "ru";

function getLang() {
  return currentLang;
}

function getTranslations(lang = currentLang) {
  return translations[lang] || translations.ru;
}

/** Translates a dotted key. Returns the key itself when the value is missing. */
function t(key) {
  const path = key.split(".");
  let value = getTranslations();
  for (const part of path) value = value?.[part];
  return value ?? key;
}

function applyStaticTranslations() {
  const dictionary = getTranslations();

  document.querySelectorAll("[data-i18n]:not([data-i18n-dynamic])").forEach((element) => {
    const key = element.getAttribute("data-i18n");
    const value = key.split(".").reduce((node, part) => node?.[part], dictionary);
    if (typeof value === "string") element.textContent = value;
  });

  document.querySelectorAll("[data-i18n-title]").forEach((element) => {
    const key = element.getAttribute("data-i18n-title");
    const value = key.split(".").reduce((node, part) => node?.[part], dictionary);
    if (typeof value === "string") element.title = value;
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-i18n-placeholder");
    const value = key.split(".").reduce((node, part) => node?.[part], dictionary);
    if (typeof value === "string") element.placeholder = value;
  });

  dictionary.faq.items.forEach((item, index) => {
    const question = document.querySelector('[data-faq="' + (index + 1) + '"]');
    const answer = document.getElementById("faq-a-" + (index + 1));
    if (question) question.textContent = item.q;
    if (answer) answer.innerHTML = item.a;
  });

  dictionary.news.items.forEach((item, index) => {
    const card = document.querySelector('[data-news="' + (index + 1) + '"]');
    if (!card) return;
    const title = card.querySelector("[data-news-title]");
    const date = card.querySelector("[data-news-date]");
    const description = card.querySelector("[data-news-desc]");
    if (title) title.textContent = item.title;
    if (date) date.textContent = item.date;
    if (description) description.textContent = item.desc;
  });
}

function setLang(lang) {
  currentLang = lang === "en" ? "en" : "ru";
  try {
    localStorage.setItem(LANG_STORAGE_KEY, currentLang);
  } catch {
    // Ignore.
  }
  document.documentElement.lang = currentLang;
  document.title = t("pageTitle");
  applyStaticTranslations();
  window.dispatchEvent(new CustomEvent("languagechange", { detail: { lang: currentLang } }));
}

function loadLang() {
  let saved = null;
  try {
    saved = localStorage.getItem(LANG_STORAGE_KEY);
  } catch {
    // Ignore.
  }
  setLang(saved === "en" ? "en" : "ru");
}

const STEAM_ICON_SVG =
  '<svg class="btn-icon" width="18" height="18" viewBox="0 -2 28 28" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="m24.72 7.094c0 2.105-1.707 3.812-3.812 3.812-1.053 0-2.006-.427-2.696-1.117-.74-.697-1.201-1.684-1.201-2.778 0-2.105 1.707-3.812 3.812-3.812 1.094 0 2.08.461 2.776 1.199l.002.002c.691.669 1.12 1.605 1.12 2.641v.055-.003zm-12.033 11.593c0-.004 0-.008 0-.012 0-2.151-1.744-3.894-3.894-3.894-.004 0-.008 0-.013 0h.001c-.299 0-.59.034-.87.099l.026-.005 1.625.656c.778.303 1.387.897 1.704 1.644l.007.02c.164.356.26.772.26 1.21 0 .418-.087.816-.244 1.176l.007-.019c-.304.778-.901 1.386-1.652 1.696l-.02.007c-.355.161-.77.254-1.206.254-.422 0-.824-.088-1.188-.246l.019.007q-.328-.125-.969-.383l-.953-.383c.337.627.82 1.138 1.405 1.498l.017.01c.568.358 1.258.571 1.999.571h.034-.002.012c2.151 0 3.894-1.744 3.894-3.894 0-.004 0-.008 0-.013v.001zm12.969-11.577c-.005-2.63-2.136-4.761-4.765-4.766-2.631.002-4.763 2.135-4.763 4.766s2.134 4.766 4.766 4.766c1.313 0 2.503-.531 3.364-1.391.863-.834 1.399-2.003 1.399-3.296 0-.028 0-.056-.001-.083zm2.344 0v.001c0 3.926-3.183 7.109-7.109 7.109h-.001l-6.828 4.981c-.116 1.361-.749 2.556-1.698 3.402l-.005.004c-.914.863-2.151 1.394-3.512 1.394-.023 0-.046 0-.069 0h.004c-2.534-.002-4.652-1.777-5.181-4.152l-.007-.035-3.594-1.438v-6.703l6.08 2.453c.758-.471 1.679-.75 2.664-.75h.041-.002q.203 0 .547.031l4.438-6.359c.05-3.898 3.218-7.04 7.122-7.047h.001c3.924.006 7.104 3.185 7.11 7.109v.001z"/></svg>';

function getSteamBtnHtml() {
  return STEAM_ICON_SVG + t("auth.loginSteamUpper");
}

window.i18n = {
  getLang,
  setLang,
  loadLang,
  t,
  getTranslations,
  getSteamBtnHtml,
};
