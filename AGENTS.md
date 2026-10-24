# AGENTS.md

Инструкции для ИИ-агентов и разработчиков, которые продолжают работу над
проектом. Файл описывает конвенции, инварианты и подводные камни, чтобы
изменения не ломали сборку, обновления и совместимость с существующими
установками лаунчера.

## О проекте

`WoohProject Launcher` — Electron-приложение (Windows x64) для установки,
проверки и запуска игрового клиента WoohRust. Исходник получен из
`resources/app.asar` версии **1.2.5** (см. «Контекст исходника»).

- Electron **35.7.5**, Node.js 18+ (рекомендуется 20/22 LTS).
- Главный процесс — CommonJS, рендерер — классические скрипты (без сборщика).
- Нативная зависимость: `steamworks.js@0.4.0` (N-API, распаковывается из asar).
- Языки UI: русский и английский (`src/renderer/i18n.js`).

## Быстрые команды

```powershell
npm install          # зависимости
npm start            # запуск в dev-режиме
npm test             # 21 тест (мок Electron + jsdom)
npm run lint         # ESLint
npm run verify       # lint + tests
npm run pack         # ../artifacts/win-unpacked (вне проекта)
npm run dist         # ../artifacts (NSIS, вне проекта)
```

Перед запуском Electron убедитесь, что окружение не задаёт
`ELECTRON_RUN_AS_NODE=1`:

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```

## Структура

```
src/main/main.js          точка входа, окно, IPC, install/launch orchestration
src/main/preload.js       contextBridge → window.electronAPI
src/main/downloader.js    многопоточный загрузчик (Range, chunks, pause/cancel)
src/main/game-update.js   manifest → verify → download → verify
src/main/integrity.js     SHA-256, quick/full/smart-проверки, safeJoin
src/main/launcher-update.js  самообновление лаунчера
src/main/net-transport.js system/direct/node + DoH
src/main/net-doctor.js    подбор рабочего транспорта, классификация сбоев
src/main/steam-service.js Steam: registry, loginusers.vdf, профиль, ticket
src/main/game-watch.js    наблюдение за процессом, Player.log, Event Log, AV
src/main/helper.js        «Помощник»: классификация и авто-исправления
src/main/zapret-fix.js    домены в исключения zapret
src/main/bug-report.js    логи, отчёты, scrub путей/URL
src/renderer/app.js       состояние UI, гейты, прогресс, диалоги
src/renderer/i18n.js      словари ru/en
test/run-tests.js         тесты
docs/backend-api.md       спецификация API (server/ пока не реализован)
```

`server/` — отдельный пакет (Node.js + Fastify + PostgreSQL), не входит в
Electron-сборку. Его контракт и план реализации — `docs/backend-api.md`.

## Правила кода

- **CommonJS** (`require`/`module.exports`) в главном процессе; не добавляйте
  ESM в `src/main`, preload и рендерер без крайней необходимости.
- Форматирование — Prettier (`.prettierrc.json`), отступ 2 пробела,
  двойные кавычки, точка с запятой. Перед коммитом: `npm run format`.
- Имена — английские и описательные; пользовательские строки — русские (или
  через `i18n.js`), комментарии и JSDoc — английские.
- Не добавляйте зависимости без необходимости. Для HTTP в main уже есть
  `net-transport`, для файлов — `fs/promises`, для прогресса — EventEmitter.
- Любой новый модуль main-процесса должен быть покрыт хотя бы одним тестом
  или объяснением в PR, почему его нельзя протестировать без Windows/Steam.
- Не логируйте URL зеркал и пути пользователя: используйте `publicMessage()`
  (main) / `sanitizeMessage()` (renderer) или `bug-report.scrubPaths()`.

## Добавление IPC-фичи

Поток всегда одинаковый:

1. `src/main/main.js` — `ipcMain.handle("my-feature", async (event, ...args) => …)`.
2. `src/main/preload.js` — метод в `contextBridge.exposeInMainWorld("electronAPI", …)`.
3. `src/renderer/app.js` — вызов через `window.electronAPI?.myFeature?.(…)`.
4. `test/run-tests.js` — проверка API preload и, если можно, логики.
5. `README.md` — краткое описание, если фича видима пользователю.

Не расширяйте `window.electronAPI` «напрямую» в рендерере: `nodeIntegration`
выключен, доступен только preload.

## Инварианты безопасности

Нарушение этих пунктов — блокирующая ошибка:

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox` по умолчанию;
- CSP в `src/renderer/index.html`: `script-src 'self'`, без `unsafe-eval`;
- внешние ссылки — только `shell.openExternal`, навигация в окне запрещена;
- пути из манифеста — только через `resolveInstallPath()` (запрет `..` и
  абсолютных путей);
- загрузки — только по HTTPS и с проверкой SHA-256 из манифеста;
- установщик лаунчера — проверка размера + SHA-256 перед запуском;
- отчёты не должны содержать URL, домашний каталог, пароли и токены;
- Steam-тикет не отправлять по сети без явного решения и HTTPS;
- не писать в реестр, кроме `shell.writeShortcutLink` для ярлыка;
- не добавлять автозагрузку и скрытые процессы.

Подробнее — `docs/security.md`.

## Тесты

- `npm test` должен проходить полностью; тесты не должны зависеть от сети,
  Steam и установленной игры (локальный HTTP-сервер и моки).
- Для рендерера используется jsdom; не добавляйте реальные сетевые вызовы.
- Тесты, меняющие файлы, работают только в `os.tmpdir()`.
- При изменении `downloader.js` проверьте: параллельность, Range-возобновление,
  chunks, 404, pause/resume, path traversal.
- При изменении `integrity.js` — quick/full/smart и кэш `verified`.

## Сборка и упаковка

- `electron-builder` конфигурация — в `package.json` → `build`.
- `steamworks.js` должен оставаться в `asarUnpack` (иначе `.node` не
  загрузится).
- `build.files` включает `src/**/*`, `package.json`, `LICENSE`; docs и тесты
  в установщик не попадают.
- Не меняйте `name` в `package.json`: от него зависит
  `app.getPath("userData")` → `%APPDATA%\wooh-launcher`. Смена имени потеряет
  настройки и кэш существующих установок.
- `productName` для установщика задаётся в `build.productName`, а не в корне
  `package.json` (по той же причине).
- Dev-режим (`app.isPackaged === false`) пропускает самообновление и создание
  ярлыка — это ожидаемо.

## Бекенд (API)

Бекенд пока не реализован; его контракт и план — `docs/backend-api.md`.
Если берётесь за реализацию:

- код живёт в `server/` (отдельный `package.json`, Node.js + Fastify +
  PostgreSQL + Redis), **не** в `src/` и не попадает в Electron-сборку;
- сначала `server/openapi.yaml`, потом роуты; контракт и схема БД — в
  `docs/backend-api.md`;
- клиент подключается только через `api.enabled=false` по умолчанию, с
  fallback на текущее поведение;
- токены хранятся только в main-процессе (`safeStorage`), в renderer/preload
  передаются лишь профиль и флаги;
- обновляйте `docs/backend-api.md` при изменении контракта;
- тесты сервера — `node:test` + `app.inject()`, без реального Steam API.

## Подводные камни

- **Node.js**: используйте LTS (20/22). На самых новых версиях postinstall
  Electron иногда не распаковывает бинарник — тогда распакуйте кэш через
  `Expand-Archive` (см. README).
- **`ELECTRON_RUN_AS_NODE=1`**: `electron.exe` запускается как Node и молча
  выходит. Снимайте переменную перед `npm start`.
- **Кодировка консоли**: `game-watch.runConsole()` декодирует вывод
  `tasklist`/`whoami` как IBM866; не заменяйте на UTF-8.
- **A2S-парсер** (`querySourceServer`) чувствителен к смещениям: challenge —
  `message[4] === 65`, EDF-флаги — `0x80/0x10/0x40/0x20`. Меняйте только с
  тестом на реальном ответе.
- **Smart App Control**: коды 4550–4590 и состояние `VerifiedAndReputablePolicyState`
  обрабатываются в `helper.launchBlockAdvice()`; не «упрощайте» их.
- **Обновление лаунчера**: манифест и установщик лежат на зеркалах
  Hugging Face; в dev-режиме проверка пропускается.
- **Шрифты**: Inter/JetBrains Mono грузятся с Google Fonts; офлайн — fallback.

## Контекст исходника

- Это исходник `WoohProject Launcher 1.2.5` (Electron 35.7.5), полученный из
  `resources/app.asar`: 15 JS-файлов, 229 КБ, 6 866 строк после форматирования.
- Код прошёл деобфускацию (bracket notation, `!![]`, hex, `\x`-escape,
  короткие имена); string-array, control-flow flattening, `eval` и упакованного
  payload не было.
- Поведение и пользовательские строки сохранены; осознанные отличия
  перечислены в `docs/deobfuscation.md`.

## Что нельзя делать

- Переписывать `config.json` «по вкусу» — это рабочие CDN и Steam App ID.
- Удалять проверку SHA-256, `resolveInstallPath`, CSP или очистку отчётов.
- Возвращать `nodeIntegration` или `enableRemoteModule`.
- Логировать полные URL зеркал и пути пользователя.
- Добавлять сетевые вызовы в тесты.
- Менять `name` пакета и путь `userData`.
- Включать `api.enabled` по умолчанию или класть серверные секреты в клиент.
- Добавлять код бекенда в `src/` или в `build.files`.
