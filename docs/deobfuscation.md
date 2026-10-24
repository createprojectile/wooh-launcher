# Разбор и деобфускация

## Исходный артефакт

- `resources/app.asar` — 4 142 674 байта;
- внутри: 15 JS-файлов (~229 КБ после форматирования, 6 866 строк), HTML, CSS,
  `config.json`, иконка, фон;
- `resources/app.asar.unpacked/node_modules/steamworks.js` — нативная
  N-API-библиотека Steam (не обфусцирована, оставлена как зависимость).

Код был собран `javascript-obfuscator` в «лёгком» режиме (bracket notation,
boolean/hex/escape-трюки, короткие имена), без string-array, control-flow
flattening, `eval` или упакованного payload. Поэтому полноценный
деобфускатор не требовался — хватило AST-нормализации и ручного переименования.

## Признаки обфускации (до)

| Приём | Пример | Количество |
| --- | --- | ---: |
| Computed member access | `JSON["parse"]`, `fs["readFileSync"]` | 3 071 |
| Boolean-трюки | `!![]` → `true`, `![]` → `false` | 449 |
| Hex-числа | `0x0`, `0x10`, `1073741824` | 520 |
| Escape-строки | `"manifest\x20cache\x20write\x20failed:"` | 577 |
| Sequence expressions | `(a(), b())` в выражении-инструкции | 166 |
| Минификация | весь файл в одну строку | 15 файлов |

## Что сделано

1. **Распаковка asar** собственным парсером (`extract-asar.js`): заголовок
   Chromium Pickle → JSON-дерево → файлы по offset'ам.
2. **Форматирование** Prettier (print width 80) — код стал построчным.
3. **AST-деобфускация** (`deobfuscate.js`, Babel):
   - `obj["prop"]` → `obj.prop` для валидных идентификаторов;
   - `!![]`/`![]`/`!0`/`!1` → `true`/`false`;
   - hex-литералы → десятичные (сброс `extra.raw`);
   - `\xNN`-escape → реальные символы (минимальное экранирование);
   - `void 0` → `undefined`;
   - sequence expression в statement → отдельные инструкции.
4. **Ручное переименование**: все `a`, `b`, `c`, … получили смысловые имена
   (`installPath`, `manifestPath`, `isPlayerFile`, `sendProgress`, …), файлы
   разложены по модулям, добавлены JSDoc и комментарии.
5. **Структурирование**: `src/main` (12 модулей + preload) и `src/renderer`
   (UI, i18n), `test/`, electron-builder, README.

Пример «до/после»:

```js
// до (одна строка, фрагмент)
function manifestCachePath(a){const b=path['join'](app['getPath']('userData'),'manifests');try{fs['mkdirSync'](b,{'recursive':!![]});}catch{}const c=crypto['createHash']('sha1')['update'](path['resolve'](a))['digest']('hex')['slice'](0x0,0x10);return path['join'](b,'manifest-'+c+'.json');}
```

```js
// после
function manifestCachePath(installPath) {
  const cacheDir = path.join(app.getPath("userData"), "manifests");
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
  } catch {
    // Ignore: the write below will fail with a useful error.
  }
  const key = crypto
    .createHash("sha1")
    .update(path.resolve(installPath))
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheDir, "manifest-" + key + ".json");
}
```

## Проверка эквивалентности

Чтобы не потерять поведение при переписывании:

- **Строковые литералы** сверены мультимножеством через Babel AST: отличия
  только там, где строки были именами computed-свойств (`["cancel"]`),
  каналами preload (одна строка вместо двух) и удалёнными неиспользуемыми
  импортами;
- **Словари i18n** сравнены рекурсивно — `ru` и `en` идентичны оригиналу;
- **config.json** идентичен;
- **21 тест** (`npm test`) покрывает целостность, загрузчик, манифесты,
  сетевую диагностику, помощника, zapret, отчёты, preload и рендерер;
- **запуск в Electron 35.7.5**: интерфейс визуально совпадает с оригиналом;
- **сборка**: `npm run pack` и `npm run dist` (NSIS) проходят, содержимое
  `app.asar` соответствует оригинальному (включая `steamworks.js` в
  `app.asar.unpacked`).

## Отличия от оригинала (осознанные)

| Изменение | Причина |
| --- | --- |
| Путь к renderer: `../renderer/index.html` | файлы разложены по `src/main` и `src/renderer` |
| `background.png` вместо `../image.png` | фон перенесён в `src/renderer` |
| Убран `productName` из корня `package.json` | иначе Electron менял `userData` на `%APPDATA%\WoohProject Launcher` и терял настройки существующих установок |
| `console-message` через объект события | новый API Electron 35 (старый сигнал устарел) |
| CSP в `index.html` | убрано предупреждение Electron и ограничены источники |
| Проверка путей манифеста (`resolveInstallPath`) | запрет `..`/абсолютных путей из сторонних зеркал |
| `eslint`, тесты, README, electron-builder | проект должен собираться и проверяться |

Пользовательские строки, иконки, стили, порядок экранов и логика сохранены.
