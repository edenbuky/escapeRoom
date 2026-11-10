# Contract: Owner-Authorized Session Stream

## Endpoint

`GET /sessions/:sid/stream` on game-engine (local default port 3001).

This is a read-only endpoint. It never submits commands, changes a deadline, records player activity, calls gameplay reconnect, or provisions/resets a sandbox. Frontend screen implementation is outside this task.

### Request

| Input | Requirement |
|---|---|
| `sid` | Valid session UUID |
| `Authorization` | `Bearer <access-token>`; no query-string token or new cookie mechanism |
| `Accept` | Clients should send `text/event-stream` |
| `Last-Event-ID` | Optional positive safe-integer decimal domain version; not a replay/suppression cursor |
| `Origin` | If present, must match a configured exact allowed origin |

Malformed supplied Last-Event-ID returns 400. An absent, older, equal, or ahead-of-current valid ID always causes the latest full snapshot to be returned first. It never blocks delivery or changes stored state.

### Authentication and ownership

- Verify HS256 using the same decoded base64 secret, issuer, audience and configured lifetime as the gateway.
- Require the gateway claim shape: UUID `sub` and `fid`, nonnegative safe-integer `ver`, integer `iat`/`exp`, positive lifetime no greater than configured TTL, and no excessively future-issued token. Retain the gateway's five-second issued-at/verification skew allowance, but explicitly reject `now >= exp`.
- Match `sub` to the immutable projected owner before sending headers or registering a lasting stream.
- Close at token expiry, checking expiry again before each state write. Refresh remains a gateway/client responsibility. A reconnection is newly authorized.
- Logout, family revocation and account suspension before token expiry are not queried here. This approved boundary differs from the gateway's database-backed guard; gateway behavior is unchanged.

### Pre-stream error responses

Use normal Nest JSON errors with a stable safe code/message; do not emit fake snapshots.

| Status | Condition |
|---|---|
| 400 | Malformed session UUID or Last-Event-ID |
| 401 | Missing, invalid or expired bearer token |
| 403 | Valid token but wrong owner, or disallowed browser origin |
| 503 | `projection_not_ready`: no snapshot exists yet; `Retry-After: 1` |
| 503 | `projection_unavailable`: database/listener unavailable, or stream auth unconfigured |

An absent projected row cannot distinguish a newly accepted session from a nonexistent one; both return the same non-disclosing `projection_not_ready` response. Do not fabricate an empty view or query private engine state to decide. Clients may retry with backoff and eventually present an unavailable-session state.

Authenticate before checking session existence. Known non-owner requests receive no snapshot, private IDs, or owner details. Failures after SSE headers have been sent are sanitized, logged, and close the connection; they cannot become a new HTTP error response.

## Successful response

Status 200 with `Content-Type: text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-store, no-transform`, and `X-Accel-Buffering: no`. Do not compress/buffer this endpoint in an HTTP proxy. Flush only after authorization, initial snapshot loading and listener readiness succeed.

Each state event has:

```text
event: session
id: <SessionView.version>
data: <single-line JSON encoding of the complete SessionView>

```

Use JSON serialization, including escaped output newlines, rather than interpolating output into raw SSE frames. Exact fields are defined in the unchanged [shared view contract](../../packages/contracts/src/views/session-view.ts).

The first state event on every connection is a full snapshot. Later state events are also full replacements, never patches. Server heartbeat comments every 15 seconds do not carry an ID or advance state. A persistent stream may deliver multiple events with the same `id`: distinct domain events can share a version. Clients must apply each complete snapshot in arrival order, including equal-version snapshots. They must not deduplicate using `id` alone.

## Handoff and coalescing

1. The process has a healthy, committed LISTEN registration.
2. Authenticate the request and install cancellation cleanup immediately.
3. Register a provisional subscriber before loading its initial snapshot; notifications during loading mark it dirty but cannot send data before ownership is verified.
4. Load the authorized snapshot, then send it first. If a change arrived during that read, refresh afterwards.
5. Serialize session refreshes. Compare private projection revisions, not only public version, to avoid sending an older read after a newer one.

The user approved combining rapid updates into the latest complete state. The server applies every distinct supported event to persistent state, but it does not promise every intermediate output will be displayed. After the burst settles, both clients receive the same complete state.

## Disconnect and resource bounds

- On token expiry, response close, listener failure, database refresh failure, shutdown, or sustained backpressure, close and release the stream's subscriptions/timers.
- If `write()` returns false, wait for drain; retain only the latest pending snapshot. Close after 15 seconds without drain, rather than building a queue.
- Listener failure closes all affected streams and marks new stream admission unavailable. Reconnect LISTEN with bounded backoff (up to five seconds between attempts); new HTTP connections resnapshot after recovery.
- A client disconnect during initial authorization/read must also release its provisional subscription. No heartbeat or read may continue writing to that response.
- A valid token may open an already-abandoned session and receive its terminal snapshot. The connection remains read-only and follows normal expiry/disconnect rules.

## Browser and deployment integration

Native EventSource cannot attach an arbitrary Authorization header. Consumers must use fetch streaming or an SSE client supporting that header. Do not place bearer tokens in URLs to work around this limitation.

Engine CORS must allow exact configured origins, GET/OPTIONS, Authorization and Last-Event-ID; expose Retry-After when cross-origin clients need it. Wildcard credentialed CORS and new auth cookies are not introduced. Preflight does not require a bearer token; the GET does.

Route this path to game-engine, not the gateway session-command controller. A reverse proxy must leave event-stream responses unbuffered and allow idle periods exceeding the heartbeat interval. Full production ingress provisioning is outside this local feature.

## Acceptance matrix

- Two authenticated owners' views receive the same latest state; a different user cannot subscribe.
- Same-version updates change the visible snapshot without requiring a higher SSE ID.
- Missing/old/equal/future valid resume IDs all receive latest snapshot first.
- A commit between initial read and delivery/subscription completion is not lost.
- Invalid/missing/expired token and malformed cursors return HTTP errors before stream headers.
- Expiry closes active streams; a new valid token can reconnect without gameplay side effects.
- Listener outage, read failure, early client close, slow client and shutdown have bounded cleanup.
- Injected private properties are absent from actual serialized HTTP frames, not merely from TypeScript types.
