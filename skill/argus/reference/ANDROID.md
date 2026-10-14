# Android WebView

Attach to a WebView inside an Android app on a USB device. Needs `adb` on `PATH` (or `ARGUS_ADB_BIN`) and an app whose WebView debugging is on (`WebView.setWebContentsDebuggingEnabled(true)`, typical for debug builds). Chrome for Android works too (`--package com.android.chrome`).

## Attach

```bash
argus android attach --package com.example.game --id pixel          # long-running: run in background
argus android attach --package com.example.game --launch            # start the app first, wait for its WebView
argus android attach --package com.example.game --serial 47081JEKB12024 --url index.html --json
argus eval pixel 'location.href'
argus watcher stop pixel                                              # removes only this attach's forward
```

What it does:

- Resolves the app pid and its `webview_devtools_remote_<pid>` socket, lets adb pick a free host port, and forwards it.
- Starts a CDP watcher on that port. Default target filter: `--type page`. `--url`/`--type`/`--origin` narrow it.
- Polls the device every 2s. When the app restarts, the pid and socket name change; attach re-points the **same** host port at the new socket, and the watcher reconnects by itself (within ~10s). A device reconnect, which drops all forwards, is repaired the same way.
- On `watcher stop`, Ctrl-C, or SIGTERM it removes its own forward with `adb forward --remove tcp:<port>`. It never runs `--remove-all`. Don't run `--remove-all` yourself either: it also removes other sessions' forwards.
- `--port <n>` fixes the host port. If another forward already holds that port, attach fails and names the owner (watcher id and cwd). It never rebinds the port.
- Without `--id`, the id is the last package segment (`game`), suffixed (`game-2`) if that id is taken. An explicit `--id` that is taken fails with `watcher_id_taken`, naming the holder's pid, CDP port, and cwd.
- After attaching, a broken device network path is reported as a `WARN`/`FAIL` line (see below).

## Doctor

```bash
argus android doctor                                         # every connected device
argus android doctor --serial 47081JEKB12024 --package com.example.game --json
```

Per device it reports the following. Any `FAIL` sets exit code 1.

- **proxy**: the global HTTP proxy (`http_proxy`, `global_http_proxy_host/port`). If the proxy is `127.0.0.1:<p>` on the device, an `adb reverse tcp:<p>` and a host listener must exist; otherwise every WebView request fails with `net::ERR_PROXY_CONNECTION_FAILED`. The doctor prints the fix, either reversing the port or clearing the proxy.
- **reverse**: each `adb reverse` entry and whether something listens on its host port.
- **sockets**: every debuggable WebView/Chrome socket and the package that owns it. Use this to find a `--package`.
- **forward**: each forward on the device, the registered watcher that uses it (with its cwd), and whether its socket is gone (stale after an app restart).
- **package** (with `--package`): running? serving a DevTools socket?

## Capture

`argus record` and `argus screenshot` work on a WebView target through ordinary CDP screencast/capture; no adb screen recording is needed. Inside a scenario, `ctx.record.start/stop` therefore records in sync with the steps.
