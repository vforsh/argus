# Argus и Codex `@Browser`: исследование интеграции

Дата исследования: 2026-09-19  
Проверенные версии: Browser plugin `26.911.61220`, Codex CLI `0.153.4`

## Краткий вывод

Внутри ChatGPT desktop app уже существует полноценный транспорт между Codex и встроенным браузером. Он поддерживает вкладки, навигацию, Playwright-подобные действия, снимки, DOM и контролируемый доступ к Chrome DevTools Protocol (CDP).

Однако этот транспорт доступен только доверенному runtime Codex через привилегированный `nodeRepl.rpc('browser', ...)`. Публичного и стабильного интерфейса, к которому может подключиться отдельный процесс Argus CLI, сейчас нет.

Интеграция технически возможна, потому что модель Browser CDP хорошо ложится на `CdpSessionHandle` Argus. Но она должна быть гибридной: разрешённые диагностические операции идут через Browser CDP, а навигация, клавиатура, файлы и некоторые другие действия — через верхнеуровневый Browser API. Прозрачно заменить существующий CDP WebSocket нельзя.

Основной вывод:

- внутренний bridge уже существует;
- Browser CDP действительно работает;
- доступ к нему ограничен origin-политиками и allowlist методов;
- Codex App Server не экспортирует Browser/CDP RPC;
- обычный MCP-сервер не получает Browser handle;
- private IPC можно исследовать, но нельзя использовать как стабильный production-контракт;
- для поддерживаемой интеграции OpenAI должен опубликовать capability delegation, App Server RPC или внешний локальный transport.

## Официально документированная поверхность

OpenAI описывает `@Browser` как встроенный браузер ChatGPT desktop app. Он работает в отдельном browser profile и управляется через desktop runtime. Browser недоступен в Codex CLI и IDE extension.

Developer mode предоставляет контролируемый CDP-доступ. Пользователь включает его в `Settings > Browser > Enable full CDP access`; перед использованием на сайте требуется явное разрешение. Термин «full CDP» здесь не означает неограниченный Chrome debugging endpoint: фактический transport применяет allowlist, origin checks и специальные policy guards.

Официальные источники:

- [Browser](https://developers.openai.com/es-419/docs/browser?surface=app)
- [Plugins](https://developers.openai.com/es-419/docs/plugins)

Документация плагинов перечисляет skills, MCP servers, browser extensions и hooks. Она не описывает способ передать стороннему MCP-процессу handle встроенного `@Browser` или вызвать Browser capability из произвольного локального процесса.

## Установленный Browser plugin

Исследованный пакет:

```text
/Users/vlad/.codex/plugins/cache/openai-bundled/browser/26.911.61220
```

Важные файлы:

```text
.codex-plugin/plugin.json
scripts/browser-client.mjs
scripts/browser-service.mjs
docs/api.json
docs/capabilities/tab/cdp.md
```

Manifest:

- `name`: `browser`;
- `version`: `26.911.61220`;
- `license`: `Proprietary`;
- содержит skills и lifecycle hooks;
- не публикует MCP server;
- не предоставляет npm package или документированный внешний transport.

### Клиентский transport

`browser-client.mjs` экспортирует `setupBrowserRuntime()`. Он не открывает socket и не создаёт CDP connection самостоятельно. Вместо этого он требует привилегированный объект `globalThis.nodeRepl` и строит transport поверх двух RPC:

```js
nodeRepl.rpc('browser', { method: 'setup', params })
nodeRepl.rpc('browser', { method: 'execute', params })
```

При импорте клиента из обычного Node-процесса модуль загружается, но `setupBrowserRuntime()` завершается ошибкой:

```text
Browser use requires a trusted Node REPL browser service
```

Это ключевое ограничение: Browser JavaScript API физически присутствует на диске, но его transport выдаётся только доверенному runtime Codex.

### Service RPC

`browser-service.mjs` принимает только два публичных для Browser client действия:

- `setup` — возвращает API manifest и список отключённых членов API;
- `execute` — исполняет типизированную Browser command.

Сервис также выполняет:

- выбор browser backend;
- session/turn binding;
- проверку origin access;
- запрос user approval;
- фильтрацию CDP методов и параметров;
- маршрутизацию событий;
- cleanup после окончания turn.

В доверенном runtime доступны browsers/tabs, навигация, AX/DOM snapshots, Playwright-style locators, computer-use input, screenshots, clipboard, console logs, page assets, WebMCP и optional capabilities. У проверенного `iab` browser metadata содержала `codexSessionId`, а вкладка рекламировала `pageAssets`, `webmcp` и `cdp`.

## Контракт CDP capability

CDP capability вкладки предоставляет два метода:

```ts
send(method, params?, { target?, timeoutMs? })
readEvents({ afterSequence?, limit?, methods?, target?, timeoutMs? })
```

Особенности:

- доступ scoped к текущей вкладке и её web origin;
- события хранятся в ограниченном buffer;
- чтение событий cursor-based;
- `hasMore` показывает необходимость дочитать страницу buffer;
- `truncated` показывает, что старые события уже вытеснены;
- дочерний target выбирается по `sessionId` или `targetId`;
- iframe sessions обнаруживаются через `Target.attachedToTarget` events;
- команды проходят policy validation до отправки в browser backend.

По форме это почти соответствует `CdpSessionHandle` Argus:

- `send()` соответствует `sendAndWait()`;
- `readEvents()` можно преобразовать в `onEvent()` через cursor pump;
- `target.sessionId` соответствует `CdpSendOptions.sessionId`;
- `Target.attachedToTarget` и `Target.detachedFromTarget` дают lifecycle дочерних sessions.

См. [CdpSessionHandle](packages/argus-watcher/src/cdp/connection.ts#L28) и [CdpSourceHandle](packages/argus-watcher/src/sources/types.ts#L90).

## Фактическая проверка в `@Browser`

Для теста был запущен временный HTTP server на `127.0.0.1`. Страница содержала:

- console messages;
- кнопку, выполнявшую `fetch('/api?probe=1')`;
- cookie тестового origin;
- iframe с отличающимся host (`localhost` вместо `127.0.0.1`) для проверки child target.

После теста вкладка и server были закрыты. Browser profile и репозиторий не изменялись.

### Успешные команды

Подтверждены:

- `Runtime.evaluate`;
- `Runtime.enable`;
- `DOM.getDocument`;
- `Page.enable`;
- `Page.getFrameTree`;
- `Page.captureScreenshot`;
- `Network.enable`;
- `Network.getCookies` с явным списком URL;
- `Network.getResponseBody`;
- `Log.enable`;
- `Performance.enable`;
- `Performance.getMetrics`;
- `Page.startScreencast`;
- `Page.screencastFrameAck`;
- `Page.stopScreencast`.

Наблюдавшиеся результаты:

- screenshot получен, приблизительный PNG payload — 28 KiB;
- `Performance.getMetrics` вернул 36 метрик;
- button click породил два `Runtime.consoleAPICalled` события;
- запрос `/api?probe=1` породил `Network.requestWillBeSent` и `Network.responseReceived`;
- `Network.getResponseBody` вернул тело `{"ok":true,"url":"/api?probe=1"}`;
- screencast породил `Page.screencastFrame`;
- reload через high-level Browser API породил последовательность `Target.detachedFromTarget`, `Page.frameNavigated`, `Target.attachedToTarget` для iframe.

Это подтверждает, что Browser capability подходит для:

- console/log collection;
- runtime evaluation;
- DOM, AX и CSS inspection;
- network capture и response bodies;
- screenshots;
- recording через screencast;
- performance profiling;
- iframe-aware event routing.

### Фактически заблокированные команды

Следующие вызовы вернули policy error до выполнения:

| CDP method                              | Результат/предписанная замена                   |
| --------------------------------------- | ----------------------------------------------- |
| `Browser.getVersion`                    | Raw CDP не поддерживает browser-level method    |
| `Target.getTargets`                     | Raw CDP не поддерживает target enumeration      |
| `Page.navigate`                         | Использовать `tab.goto(url)`                    |
| `Page.addScriptToEvaluateOnNewDocument` | Не поддерживается                               |
| `Input.dispatchKeyEvent`                | Использовать Browser computer-use keyboard      |
| `Network.getAllCookies`                 | Использовать `Network.getCookies` с явными URLs |
| `Network.setExtraHTTPHeaders`           | Не поддерживается                               |
| `DOM.setFileInputFiles`                 | Использовать Playwright file chooser            |

Дополнительно проверены и заблокированы browser/window/system методы, включая `Browser.getWindowForTarget` и `SystemInfo.getInfo`.

## CDP policy из Browser service

### Разрешённые домены-кандидаты

Service распознаёт следующие CDP domains:

```text
Accessibility, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM,
DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, Input, Inspector, Log,
Network, Overlay, Page, Performance, Profiler, Runtime, Storage, Target,
Tracing, WebAudio, WebAuthn
```

Присутствие domain в этом наборе не означает, что доступны все его методы.

### Полностью заблокированные domains

```text
CacheStorage, Database, Storage, Target, WebAuthn
```

`Browser` и `SystemInfo` отсутствуют в разрешённом наборе.

### Явно заблокированные методы

```text
DOM: getFileInfo, setFileInputFiles
Input: dispatchKeyEvent, setInterceptDrags
Network: clearBrowserCookies, deleteDeviceBoundSession, enableDeviceBoundSessions,
  getAllCookies, getResponseBodyForInterception, setCookieControls,
  setExtraHTTPHeaders, setRequestInterception, takeResponseBodyForInterceptionAsStream
Page: addScriptToEvaluateOnLoad, addScriptToEvaluateOnNewDocument, crash, disable,
  getNavigationHistory, resetNavigationHistory, setAdBlockingEnabled, setBypassCSP,
  setDownloadBehavior, setInterceptFileChooserDialog, setRPHRegistrationMode,
  setSPCTransactionMode
Tracing: requestMemoryDump
```

### Параметрические ограничения

Некоторые методы разрешены только при безопасных параметрах:

- `Network.getCookies` требует непустой явный `urls`;
- cookie mutations требуют URL и отклоняют произвольный `domain`;
- `Fetch.enable` допускает только явные non-Document resource patterns;
- перехват `Document` зарезервирован Browser Use runtime;
- `Fetch.disable` запрещён; для отключения используется `Fetch.enable` с пустыми patterns;
- `Page.reload` запрещён с `scriptToEvaluateOnLoad`, но обычный reload допустим;
- `Page.createIsolatedWorld` не допускает universal access;
- `Network.enable` не допускает durable messages configuration;
- `Tracing.start` фильтрует system tracing, systrace, memory dump и часть Perfetto config;
- URL-bearing network/fetch commands проходят отдельную origin validation;
- `Page.navigate` и history navigation направляются на high-level Browser API.

## Внутренний native bridge

Browser service обнаруживает backend sockets в:

```text
/tmp/codex-browser-use/*.sock
```

На момент исследования desktop app держал несколько активных sockets; отдельный socket принадлежал Chrome extension host.

Service подключается не через стандартный `node:net`, а через привилегированный:

```js
globalThis.nodeRepl.nativePipe.createConnection(...)
```

Wire format похож на JSON-RPC 2.0 с четырёхбайтовым length prefix. Внутренний backend содержит операции наподобие:

- `ping`;
- `getInfo`;
- `getTabs`;
- `getUserTabs`;
- `createTab`;
- `attach` / `detach`;
- `attachTarget` / `detachTarget`;
- `executeCdp`.

Service дополнительно фильтрует in-app backend по текущему `codexSessionId` и build flavor.

Была выполнена попытка обратиться к активным sockets из обычного Node-процесса корректно framed JSON-RPC запросом `getInfo`. Все подключения принимались на уровне socket, но не возвращали response до timeout.

Возможные причины:

- обязательный privileged broker;
- скрытый handshake;
- single-client ownership;
- обязательная session/turn attestation;
- маршрутизация только для разрешённого `nativePipe` caller.

Даже если handshake будет восстановлен reverse engineering, этот путь остаётся непригодным для production:

- протокол proprietary и недокументирован;
- socket discovery нестабилен;
- присутствуют stale socket files;
- backend связан с session и turn lifecycle;
- отсутствует compatibility/version guarantee;
- обновление desktop app может изменить framing, методы или approval policy.

## Codex App Server

Проверялся установленный `codex-cli 0.153.4`:

```bash
codex app-server generate-json-schema --experimental --out <tmp>
codex app-server generate-ts --experimental --out <tmp>
```

Сгенерированный experimental protocol содержит Browser-related configuration types:

- `BrowserUseConfig`;
- `BrowserUseOriginPolicy`;
- `BrowserUseRequirements`;
- `InAppBrowserRequirements`;
- `fullCdpAccess` policy.

Но он не содержит request/notification методов для:

- списка browsers или tabs;
- получения tab handle;
- навигации;
- Browser command execution;
- отправки CDP command;
- чтения CDP events.

Следовательно, App Server в текущем виде умеет описывать Browser configuration и requirements, но не является внешним Browser transport.

## MCP и plugin boundary

Обычный MCP server — отдельный процесс или remote service. Он может предоставить Codex свои tools, но обратного канала «получить capability другого plugin/runtime» публичный MCP-контракт не содержит.

Текущий Browser plugin:

- не экспортирует MCP server;
- не объявляет callable tool для сторонних процессов;
- получает Browser transport непосредственно от trusted Node REPL;
- завершает работу и чистит resources через runtime hooks.

Поэтому упаковка Argus как обычного MCP server сама по себе проблему не решит. MCP должен получить от host явный delegated Browser capability или стабильный socket/token, которого сейчас нет.

## Совместимость с текущим Argus

### Что хорошо совпадает

Существующие абстракции Argus уже отделяют CDP consumer от source transport:

- `CdpSourceHandle` содержит session и transport-specific capabilities;
- `CdpSessionHandle.sendAndWait()` отправляет command;
- `CdpSessionHandle.onEvent()` подписывает consumer на события;
- `CdpSendOptions.sessionId` адресует child target;
- source может отдельно реализовать tabs, targets, health checks и browser cookies.

Это позволяет добавить ещё один source без переписывания большинства DOM, network, logs, screenshot, recording и profiling consumers.

### Что сможет работать через Browser CDP

| Argus область              | Ожидаемая совместимость                     |
| -------------------------- | ------------------------------------------- |
| `eval`, runtime properties | Высокая                                     |
| console и logs             | Высокая                                     |
| DOM tree, query, inspect   | Высокая                                     |
| Accessibility              | Высокая                                     |
| CSS inspect/live edits     | Высокая, в рамках origin policy             |
| network capture            | Высокая                                     |
| response/request bodies    | Высокая                                     |
| screenshots                | Высокая                                     |
| recording через screencast | Высокая                                     |
| performance/profiler       | Высокая                                     |
| iframe targets             | Поддерживается через buffered Target events |
| emulation                  | Большая часть должна работать               |
| tracing                    | Частично, с ограничениями config            |

### Что сломается без специального adapter

| Argus операция           | Причина                                              | Необходимая замена                                                |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------------------------------- |
| `goto`                   | `Page.navigate` заблокирован                         | `tab.goto()` плюс navigation waiter                               |
| `page back/forward`      | history CDP заблокирован                             | `tab.back()` / `tab.forward()`                                    |
| startup injection        | `Page.addScriptToEvaluateOnNewDocument` заблокирован | Нет полного эквивалента; только текущий document или host feature |
| `keydown`                | `Input.dispatchKeyEvent` заблокирован                | Browser CUA/Playwright keyboard                                   |
| file input               | `DOM.setFileInputFiles` заблокирован                 | Playwright file chooser                                           |
| browser-wide cookies     | `Storage`/browser context заблокированы              | Page-scoped cookies или специальный Browser auth API              |
| auth-state import/export | Нужны navigation и browser cookies                   | Отдельная реализация и явные ограничения                          |
| target enumeration       | `Target.getTargets` заблокирован                     | `browser.tabs.list()` и buffered attach events                    |
| browser health/version   | `Browser.getVersion` заблокирован                    | Higher-level backend status                                       |
| Document request mocks   | Fetch Document interception зарезервирован           | Ограничить mocks resource types или использовать host API         |
| extra HTTP headers       | `Network.setExtraHTTPHeaders` заблокирован           | Сейчас полноценной замены нет                                     |

Конкретные текущие места Argus, требующие адаптации:

- `packages/argus-watcher/src/cdp/navigation.ts`;
- `packages/argus-watcher/src/cdp/keyboard.ts`;
- `packages/argus-watcher/src/cdp/authCookies.ts`;
- `packages/argus-watcher/src/cdp/browserCookies.ts`;
- `packages/argus-watcher/src/cdp/dom/mutate.ts`;
- `packages/argus-watcher/src/runtime/watcherInject.ts`.

## Возможная архитектура интеграции

### Гибридный source

Потенциальный `CodexBrowserSource` должен объединять два API:

```text
Argus watcher/runtime
    |
    +-- Browser CDP capability
    |     send(method, params, target)
    |     readEvents(cursor, filters, target)
    |
    +-- High-level Browser API
          tabs.list/get/new
          goto/back/forward/reload
          CUA keyboard/input
          Playwright file chooser
          screenshots and approvals
```

Основные компоненты:

1. Выбор `iab` browser, связанного с текущим `codexSessionId`.
2. Выбор или создание вкладки.
3. `CdpSessionHandle` adapter: `sendAndWait` -> `cdp.send`.
4. Event pump: последовательные `readEvents` с сохранением cursor.
5. Child-session registry из `Target.attachedToTarget`/`detachedFromTarget`.
6. High-level navigation/input/file fallback.
7. Capability flags, чтобы HTTP routes не вызывали запрещённые команды.
8. Origin approval и full-CDP approval lifecycle.
9. Recovery после navigation, tab replacement и turn cleanup.

### Главная проблема размещения

Обычный Argus watcher работает отдельным процессом. Browser handle и функции `nodeRepl.rpc` существуют только внутри trusted runtime Codex и не сериализуются в этот процесс.

Поэтому одного нового `CdpSourceHandle` недостаточно. Требуется один из вариантов:

- host-side bridge, запускаемый внутри trusted Node REPL;
- публичный App Server Browser RPC;
- capability token и внешний socket;
- официальный MCP reverse-call/delegation contract.

Без этого adapter может существовать только внутри текущего Codex turn, а не как обычный долгоживущий Argus watcher.

## Реалистичные варианты сейчас

| Вариант                            | Что даёт                                                                                                 | Ограничения                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Argus-like skill поверх `@Browser` | Поддерживаемый Browser API; eval, logs, DOM, network, screenshots, recording и traces; штатные approvals | Не подключает существующий CLI, дублирует логику, живёт только внутри turn/runtime, не даёт стабильную daemon/session модель   |
| Experimental private-IPC prototype | Проверка feasibility и handshake, материал для предложения OpenAI                                        | Только локальное исследование; непригоден для npm, CI, пользовательских установок, долгой поддержки и authenticated automation |
| Поддерживаемый внешний API         | Полноценный новый Argus source                                                                           | Требует изменения со стороны OpenAI                                                                                            |

Предпочтителен третий вариант. Минимально достаточный контракт:

```ts
interface ExternalBrowserBridge {
	listBrowsers(): Promise<BrowserInfo[]>
	listTabs(browserId: string): Promise<TabInfo[]>
	executeCommand(tabId: string, command: BrowserCommand): Promise<unknown>
	sendCdp(tabId: string, method: string, params?: object, target?: CdpTarget): Promise<unknown>
	readCdpEvents(tabId: string, cursor: number, filters?: EventFilters): Promise<CdpEventPage>
}
```

Контракт также должен определять:

- authentication/capability token;
- session и turn ownership;
- origin approval callbacks;
- protocol version;
- disconnect/reconnect semantics;
- event buffer limits;
- browser/tab lifecycle;
- method policy introspection;
- user-visible audit trail.

## Рекомендация

Не строить release-интеграцию на `/tmp/codex-browser-use/*.sock`.

Практичный порядок действий:

1. Зафиксировать желаемый внешний transport contract на основе `CdpSessionHandle`.
2. Отделить в Argus команды, которые требуют raw CDP, от операций, допускающих high-level fallback.
3. Добавить capability matrix и transport-level feature detection.
4. При необходимости создать небольшой in-runtime proof of concept через Browser API, не используя private sockets.
5. Перед production-реализацией запросить у OpenAI поддерживаемый Browser/App Server capability.

Если OpenAI предоставит такой endpoint, основная часть Argus — DOM, logs, network, screenshots, recording, eval и iframe routing — сможет использовать его без фундаментальной переработки. Самые большие изменения потребуются в navigation, keyboard, injection, file upload и auth/cookie flows.
