# C2 — `frame_snapshot` вместо подделанных CDP-событий

Аудит: `CODE_QUALITY_AUDIT.md` → C2 (MAJOR). Всё — один PR, но с жёстким внутренним порядком: сначала этап 0 (e2e на живом Chrome с настоящим расширением), прогнанный и зелёный на **немодифицированном** коде как baseline-коммит в этой же ветке, и только потом редизайн. Без работающего харнесса протокол не трогать.

## Цель

Убрать тройную бухгалтерию дерева фреймов и ложные side effects:

- расширение перестаёт эмитить синтетические `Page.frameNavigated`/`Page.frameDetached` ([debugger-manager.ts:386](../packages/argus-extension/src/background/debugger-manager.ts), `:417`, `:556`) — вместо них одно сообщение `frame_snapshot` с полной таблицей фреймов таба;
- watcher применяет снапшот через единственную функцию-diff, а `events.onPageNavigation` (ротация логов, sourcemap-кэш, индикатор) срабатывает **только** от настоящего top-frame `Page.frameNavigated` — по построению, без матрицы «источник → эффекты»;
- собственный `Page.getFrameTree` watcher'а (bootstrap + target recovery) заменяется pull-запросом снапшота у расширения — источник истины один.

## Этап 0 — e2e-страховка (первые коммиты ветки, зелёная на текущем коде)

### 0.1 Харнесс `e2e/helpers/extensionHarness.ts`

1. Предусловия: `npm run build:packages` и `bun run --cwd packages/argus-extension build` (харнесс проверяет наличие артефактов и падает с понятной ошибкой, сборку не запускает сам).
2. Изоляция: temp-каталоги + env `ARGUS_HOME`, `ARGUS_REGISTRY_PATH` (уже поддерживаются, см. `packages/argus/src/config/argusHome.ts`, `doctor.ts:21`).
3. Native hosts: Chrome на macOS/Linux ищет user-level манифесты в `<user-data-dir>/NativeMessagingHosts/` — пишем манифесты в temp-профиль, реальный Chrome не трогаем. Рефакторинг `packages/argus/src/commands/extension/nativeHost.ts`: извлечь `installNativeHostsTo(manifestDir, extensionId, executablePath)` (сейчас каталог захардкожен в `getManifestDir`). Extension ID уже стабильный — `ARGUS_EXTENSION_ID` (manifest.json пинит `key`), unpacked-загрузка даёт тот же ID.
4. Wrapper-скрипты указывают на репо-сборку и **вшивают env** (Chrome спавнит хост без нашего окружения):
    ```bash
    #!/bin/bash
    export ARGUS_HOME=<tmp> ARGUS_REGISTRY_PATH=<tmp>/registry.json
    exec "<node>" "<repo>/packages/argus/dist/bin.js" watcher native-host --role tab
    ```
5. Chrome: спавн с `--user-data-dir=<tmp>`, `--load-extension=<корень расширения с manifest.json>`, `--disable-extensions-except=...`, `--no-first-run`, `--no-default-browser-check`, стартовый URL — playground. Переиспользовать спавн-логику `chromeStart.ts` (извлечь helper) либо сырой spawn в харнесе. **Риск:** `--headless=new` + MV3 + native messaging — проверить первым коммитом-спайком; если flaky, гонять headed и гейтить сьюту env-флагом.
6. Playground-серверы: переиспользовать `playground/serve.ts` (порты 3333/3334 → выделять свободные, в `serve.ts` порт параметризовать).
7. Ожидания: появление `extension-control` в registry → `argus ext attach --tab <id> --wait --json` → появление tab-watcher'а. Таймауты щедрые (запуск Chrome + spawn native host).

### 0.2 Наблюдаемость: счётчик навигаций

Добавить в watcher-статус аддитивное поле `counters: { pageNavigations: number }` (инкремент в месте вызова `events.onPageNavigation`; протокол — аддитивно, без бампа `ARGUS_PROTOCOL_VERSION`, см. `packages/argus-core/src/protocol/http/status.ts`). Это инструмент, которым e2e ловит шторм подделанных событий.

### 0.3 Сценарии `e2e/extension-live.test.ts`

- **A. Attach:** attach таба → `argus eval` попадает в top page.
- **B. Выбор iframe:** select same-origin iframe → `eval location.href` возвращает URL iframe.
- **C. Навигация с выбранным iframe (ядро):** навигировать top page → iframe переизбран (новый frameId, hint-механика из `removeExtensionFrame`), `eval` по-прежнему в iframe, `pageNavigations` проверен. В финальном состоянии PR ассерт — строгое `=== 1`. На baseline-коммите (до редизайна) счётчик даёт **2+** за навигацию (реальное событие + синтетический реплей через 150 мс) — в baseline-прогоне временно ассертить `>= 1` и залогировать фактическое значение, это чекпойнт процесса, в мерж уходит уже `=== 1`.
- **D. Cross-origin iframe (OOPIF, child session):** те же проверки для `#cross-origin-iframe` (порт 3334).
- **E. Child-session detach:** удалить cross-origin iframe из DOM через eval родителя → target-лист его теряет, watcher не падает, selection уходит в pending.
- **F. Reload с выбранным iframe** (территория `f4c449f`): reload → recovery переизбирает фрейм, `eval` не утекает в родителя.

Скрипт `npm run test:e2e:extension`; в дефолтный `test:e2e` включается на этапе 4 этого же PR, после проверки стабильности rerun'ами.

**Чекпойнт baseline:** харнесс + сценарии A–F зелёные на немодифицированном коде (C с ослабленным ассертом). Коммит(ы) этапа 0 фиксируются до любых правок протокола — если редизайн придётся откатывать, страховка остаётся.

## Этап 1 — протокол

`packages/argus-core/src/protocol/native-messaging.ts`:

```ts
export type FrameSnapshotMessage = {
	type: 'frame_snapshot'
	tabId: number
	topFrameId: string | null
	frames: FrameSnapshot[] // всегда полная таблица таба, не дельта
	reason: 'navigation_resync' | 'child_attached' | 'child_detached' | 'recovery' | 'requested'
	requestId?: number // ответ на frame_snapshot_request
}

export type FrameSnapshotRequestMessage = {
	type: 'frame_snapshot_request'
	requestId: number
	tabId: number
	refresh?: boolean // true → расширение сначала перечитывает Page.getFrameTree
}
```

- `FrameSnapshotMessage` → в `ExtensionToHost`, `FrameSnapshotRequestMessage` → в `HostToExtension`.
- Бамп `NATIVE_MESSAGING_PROTOCOL_VERSION` → 2: изменение ломающее (новый watcher без снапшотов от старого расширения слепнет; handshake уже отклоняет несовпадение). Release note: обновлять расширение и CLI парой.
- Полная таблица вместо дельт — сознательно: идемпотентное применение убивает класс diff-багов; таблица фреймов мала (единицы–десятки записей).
- Настоящие `Page.frameNavigated`/`frameAttached`/`frameDetached` продолжают идти как `cdp_event` — они от Chrome и остаются каналом мгновенной реакции.

## Этап 2 — расширение

`debugger-manager.ts` (573 LOC — при работе извлечь frame-таблицу в `background/frame-table.ts`, лимит 500 LOC):

1. `mergeFrameTree`: удалить `emitEvent('Page.frameNavigated', ...)` — остаётся только обновление `target.frames`.
2. `pruneMissingSessionFrames`, `dropChildSession`: удалить `emitEvent('Page.frameDetached', ...)`.
3. Новый колбэк `onFramesChanged(tabId, reason)` после `replaceFrameTreeSnapshot`/`dropChildSession`; `tab-bridge-session.ts` сериализует его в `frame_snapshot` (полный `getFrames(tabId)` + `topFrameId`).
4. **Дедупликация у источника:** снапшот шлётся только если сериализованная таблица изменилась с прошлой отправки (кэш последнего снапшота на таб) — 150мс-ресинки без изменений перестают генерировать трафик вообще.
5. Обработчик `frame_snapshot_request`: ответить текущей таблицей; при `refresh: true` — сначала `refreshFrameTree`.
6. `tab_attached.frames` (посев) не трогаем — форма та же (`FrameSnapshot`).

Тесты: переписать `packages/argus-extension/test/debugger-manager.test.ts` под новый контракт — ресинк не эмитит синтетических CDP-событий; эмитит ровно один `frames_changed` с верным reason; ресинк без изменений не эмитит ничего; detach child-сессии даёт snapshot с `child_detached`.

## Этап 3 — watcher

1. `session-manager.ts`: case `frame_snapshot` → новый колбэк `SessionManagerEvents.onFrameSnapshot(message)` (не через CDP event bus — смысл редизайна в разделении настоящих событий и бухгалтерии); `frame_snapshot_request` через существующий `sendBridgeRequest`.
2. Новый `sources/extension-frame-snapshot.ts`: `applyFrameSnapshot(session, state, snapshot, deps)` — единственная функция, мутирующая `state.frames` из снапшота:
    - diff старой и новой таблицы → removed / added / url-changed;
    - removed → существующий `removeExtensionFrame` (сохраняет `requestedFrameHint`);
    - `refreshFrameTitle` только для added/url-changed фреймов с execution context — вместо O(фреймов) на каждый реплей;
    - обновить `topFrameId`, `session.url`;
    - **не** вызывать `events.onPageNavigation` — этот эффект живёт только в обработчике настоящего top-frame `Page.frameNavigated` в `extension-session-events.ts:71`;
    - один `reconcileTargetSelection` на снапшот; `emitTargetChanged` только при фактическом изменении.
3. `extension-session-events.ts`: обработчики настоящих событий остаются (инкрементальные обновления, onPageNavigation, лог-пайплайн) — но теперь 1:1 с реальностью.
4. `extension-frame-runtime.ts`: `refreshExtensionFrameTree` (собственный `Page.getFrameTree` watcher'а, `:106`) заменить на `frame_snapshot_request { refresh: true }` → применение через `applyFrameSnapshot`. Вызовы: bootstrap (`extension-source.ts:296`) и recovery (`extension-target-recovery.ts:104`). Recovery-цикл сохраняется как есть, меняется только способ получения дерева.
5. Тесты:
    - новый `extension-frame-snapshot.test.ts`: add/remove/url-change/no-op; переизбрание selection при смене frameId через hint; отсутствие onPageNavigation; title-refresh только для изменившихся;
    - `extension-session-events.test.ts`: onPageNavigation ровно от настоящего top-frame события;
    - `extension-source.test.ts`, `extension-frame-runtime.test.ts` — под новый bootstrap/recovery.

**Ремарка про юниты:** обе сьюты обновляются под новый контракт и снова проверяют половинки друг против друга. Защита от «зелёного сломанного» — только этап 0; юниты здесь — документация контракта, не страховка.

## Этап 4 — затянуть e2e и включить в гейт (финальные коммиты PR)

1. Сценарий C: затянуть до `pageNavigations === 1` на одну навигацию (ловит и регресс к репле-шторму, и потерю настоящего события).
2. Прогнать сьюту многократно (`bun test --rerun-each 3` или цикл) — ловим тайминговые перемежающиеся отказы до мержа.
3. Включить `test:e2e:extension` в `npm run test:e2e`.
4. Обновить `CODE_QUALITY_AUDIT.md` (C2 → done) и, если менялись CLI-поверхности (счётчик в status), `skill/argus/SKILL.md`.

## Порядок и оценка

Один PR, последовательность коммитов = этапы:

| Коммиты | Состав                                            | Объём                                                 |
| ------- | ------------------------------------------------- | ----------------------------------------------------- |
| 1..N    | Этап 0: харнесс + сценарии + счётчик (baseline)   | ~600–800 LOC нового кода, 2–4 дня с отладкой headless |
| N+1..M  | Этапы 1–3 (протокол, расширение, watcher) + юниты | диф ~ +400/−350, debugger-manager худеет на ~40%      |
| M+1..   | Этап 4: строгие ассерты, rerun-стабильность, гейт | мелкие правки                                         |

Правила ветки: этап 0 не смешивать в коммитах с редизайном (bisect и откат должны отделять страховку от рискованной части); после каждого этапа полный локальный гейт. Один PR = один ревью на весь свип, поэтому в описание PR вынести baseline-результаты e2e (значение `pageNavigations` до/после) как доказательство, что харнесс ловит именно то, ради чего построен.

Риски: headless+native messaging (спайк в начале этапа 0); тайминги recovery на живом Chrome (митигируется F-сценарием и rerun'ами); бамп wire-протокола (release note, handshake уже защищает); один PR — при провале редизайна ветка режется по границе этапа 0, страховочная часть мержится отдельно.

## Подобрать по пути: покрытие lease/traversal в google-sheets

Вместе с этим планом удалены `packages/argus-plugin-google-sheets/src/{boundedTraversal,leaseModel}.ts`
и `test/lease-deadline.test.ts`: модули существовали только ради теста и зеркалили инварианты, а не
код, который реально едет. Настоящая логика живёт в `leasePageScripts.ts` (лизинг внутри страницы) и
в собственном дедлайн-цикле `gidTraversal.ts` — ни то, ни другое зеркала не покрывали, так что зелёный
тест ничего не гарантировал.

Честный тест этих инвариантов требует браузера, то есть того же харнесса, что строит этап 0. Когда он
появится, добавить сценарий: захват лиза чужим токеном → busy-ошибка; истечение TTL → повторный захват;
обрыв обхода по дедлайну → `complete: false` и восстановление исходного gid.

## Final checklist

После каждого этапа: `npm run build:packages`, `bun run --cwd packages/argus-extension build`, затем `npm run typecheck` и `npm run lint` (`npm run lint:fix` для авточинимого) — все ошибки чинить сразу; гейт этапа 0/4 — `npm run test:e2e:extension`, остальное — `npm run test:playground`.
