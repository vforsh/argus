# WebSocket/SSE Visibility Plan

## Goal

Add first-class visibility for WebSocket and SSE/EventSource traffic under the existing `argus net` suite. The result should support manual debugging, JSON automation, and playground-based verification.

---

## Current Capture Map

- Read the existing network path before editing: `packages/argus-watcher/src/cdp/networkCapture.ts`, `packages/argus-watcher/src/buffer/NetBuffer.ts`, `packages/argus-core/src/protocol/http/net.ts`, route filters, and CLI registration.
- Confirm which CDP events are already covered by `Network.enable`.
- Keep the user-facing surface under `net`, but model WS/SSE with separate protocol types so normal HTTP request summaries stay clean.

---

## Protocol Types

- Add WebSocket connection summary/detail types in `@vforsh/argus-core`.
- Include connection id, raw CDP request id, URL, frame id, document URL, created/opened/closed timestamps, status, handshake headers, frame counts, byte counts, close code/reason, and recent frame previews.
- Add SSE summary/detail types for EventSource/text-event-stream requests: URL, status, MIME, frame/document metadata, duration/open state, transfer bytes, and any reliable event metadata CDP exposes.
- Add response shapes for the new watcher routes.

---

## WebSocket Capture

- Subscribe to CDP WebSocket events:
    - `Network.webSocketCreated`
    - `Network.webSocketWillSendHandshakeRequest`
    - `Network.webSocketHandshakeResponseReceived`
    - `Network.webSocketFrameSent`
    - `Network.webSocketFrameReceived`
    - `Network.webSocketClosed`
    - `Network.webSocketFrameError`
- Store compact connection summaries plus bounded recent frames.
- Redact URLs and headers with the same helpers used by normal network capture.
- Bound payload previews and frame history to protect memory and avoid dumping huge/binary payloads.

---

## SSE Capture

- First pass: detect SSE/EventSource through existing request/response metadata.
- Treat requests as SSE candidates when resource type is `EventSource` or MIME starts with `text/event-stream`.
- Capture request-level visibility: URL, status, MIME, open/closed state where possible, duration, transfer bytes, frame/document scope, and headers.
- Investigate whether CDP exposes reliable streaming event payloads. If not, document the limitation and do not fake event-level SSE visibility.

---

## Watcher Buffers And Routes

- Add a bounded realtime/network-stream buffer beside `NetBuffer`, or extend `NetBuffer` only if the API stays clean.
- Add routes:
    - `GET /net/ws`
    - `GET /net/ws/connection`
    - `GET /net/sse`
- Reuse existing filter semantics where possible: `grep`, `host`, `scope`, `frame`, `first-party`, `third-party`, `since`, `after`, and `limit`.
- Keep route responses stable, small, and CLI-friendly.

---

## CLI Commands

- Register new commands:

```bash
argus net ws app
argus net ws show <connection> app
argus net sse app
```

- Human `net ws` output should show connection id, state, sent/received frame counts, byte totals, close info, and URL.
- `net ws show` should include handshake status/headers, close info, errors, and recent frames with direction plus payload preview.
- `net sse` should show EventSource URL, status, MIME, open/closed state, duration, transfer size, and frame/document scope.
- Add `--json` for all new commands.

---

## Playground Fixtures

- Extend `playground/` server with:
    - WebSocket endpoint, e.g. `/ws/echo`
    - SSE endpoint, e.g. `/events`
- Extend `playground/index.html` with controls:
    - connect/disconnect WebSocket
    - send WebSocket message
    - display received WebSocket messages
    - start/stop SSE listener
    - display received SSE events
- Keep the page self-contained and visible enough for manual debugging.
- Ensure `npm run playground` starts every dependency needed for WS/SSE verification.

---

## Manual Verification

Run the playground:

```bash
npm run playground
```

Exercise WebSocket commands:

```bash
argus net ws playground
argus net ws show <id> playground
argus net ws playground --json
```

Exercise SSE commands:

```bash
argus net sse playground
argus net sse playground --json
```

Verify WebSocket captures open state, sent/received frames, payload previews, errors, and close state. Verify SSE appears as EventSource/text-event-stream traffic with status, MIME, URL filters, and useful open/closed state.

---

## Docs

- Update `skill/argus/SKILL.md` with minimal examples.
- Add a short note if SSE payload/event visibility is request-level only.
- Mention the playground commands used to verify WS/SSE behavior.

---

## Final Checklist

After implementation, run `npm run typecheck` and `npm run lint`; fix any errors found, using `npm run lint:fix` where appropriate. Then smoke-test manually with `npm run playground`.
