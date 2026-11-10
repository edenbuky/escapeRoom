# Quickstart Validation: Session Projection and SSE

## Status and prerequisites

This is the local acceptance guide for the current projection modules and
`test:projection:integration` command. It describes validation procedures, not
the target authorization requirements or a production transport guarantee.

Requirements: Node.js 22, repository dependencies restored through the existing root lockfile, Docker running for disposable PostgreSQL 16 tests, and the repository's existing package-registry configuration. No Azure/Event Hubs, kind cluster or real SQL sandbox is needed for the focused projection harness; the harness must use fake sandbox execution when exercising engine commands.

Run commands from the backend repository root. Do not use shared development databases for integration tests.

## 1. Build and fast checks

Existing commands:

```sh
npm run build --workspace @team5/contracts
npm run build --workspace @team5/messaging
npm run build --workspace @team5/game-engine
npm run typecheck --workspace @team5/game-engine
```

Focused unit tests:

```sh
npm test --workspace @team5/game-engine -- --runInBand --runTestsByPath \
  test/projection.reducer.test.ts test/projection.schema.test.ts \
  test/projection.auth.test.ts test/projection.stream.test.ts \
  test/config.test.ts test/health.test.ts test/app.module.test.ts \
  test/schema-migration.test.ts
```

Expected: valid output exactly matches shared DTO shape; same-version reduction works; no private fields leak; invalid/expired tokens and bad configuration fail; migration registration preserves previous identities; stream lifecycle mocks leave no timers or subscriptions.

## 2. Disposable database and real streaming acceptance

The engine workspace script is:

```text
test:projection:integration =
  RUN_PROJECTION_DB_TESTS=1 jest --config jest.config.cjs --runInBand
  --runTestsByPath test/projection.integration.test.ts
```

Then run:

```sh
npm run test:projection:integration --workspace @team5/game-engine
# Include open-handle diagnostics when checking shutdown/recovery:
npm run test:projection:integration --workspace @team5/game-engine -- --detectOpenHandles
```

The test follows existing engine integration conventions: create a uniquely labelled disposable Postgres container with a random password and loopback random port, run forward migrations, initialize the in-memory transport and injected engine, and open two actual HTTP fetch readers on an ephemeral port. Generate short-lived test tokens in memory; never print them. Teardown must close apps, owned pools, transport subscriptions and only the exact container it created.

The harness must assert all of these, not just HTTP 200:

| Scenario | Expected evidence |
|---|---|
| Fresh and existing-schema migration | Projection tables exist; earlier migration identities/data unchanged; second migrate is a no-op |
| Schema isolation | Projection receipt/attempt/dead-letter writes do not affect same-identity public engine rows; missing projection tables never fall back to public tables |
| SessionStarted + PuzzleOpened, same version | Full initial state includes the opened puzzle and private owner is absent from JSON |
| CommandEvaluated + PuzzleSolved + next puzzle/RoomEntered | Both clients converge on correct room, statuses and results, even with repeated SSE IDs |
| Sandbox readiness status | PuzzleOpened status-only update preserves puzzle state and reflects ready/failed sandbox |
| Duplicate and stale delivery | No duplicate effects, no revision increment or NOTIFY for no-op handling; no rollback to old state |
| Transaction rollback | Neither receipt nor view change survives; observer receives no rolled-back notification |
| Retry/restart | Five persisted total attempts, metadata-only dead letter, no full payload; restart does not reset count |
| Stream setup race | Commit during initial snapshot acquisition causes a subsequent refresh; final state is not missed |
| Reconnect | Missing/old/equal/future valid Last-Event-ID receives current full snapshot first; no historical replay requirement |
| Authentication | 401 invalid/missing/expired token; 403 wrong owner; short token closes at expiry; subsequent valid token reconnects |
| Unready and failure cases | Safe 503 before headers for unavailable view/listener; listener/read failure after headers closes rather than silently freezing |
| Resource cleanup | Early disconnect, slow writer, expiry, listener recovery and shutdown leave no subscriber/timer/pool leaks |
| Content filtering | Extra nested owner/answer/input/definition properties are absent from actual serialized frames; authorized output text survives unchanged |
| No gameplay reconnect | Reconnection invokes no player command, sandbox operation or engine mutation |

For unsupported SessionExpired/SessionEscaped/HintRevealed/PuzzleReset, assert the explicit unsupported handling outcome and unchanged projection watermark; do not claim their gameplay behavior is implemented.

## 3. Measured delivery threshold

In the integration harness, send 100 observable updates for one session, waiting for both clients to see each before advancing. Record elapsed time from immediately before each event's publication to the in-memory transport to complete-frame receipt at both clients, including reduction and persistence. At least 95 must reach both within 1,000 ms.

Next, publish a burst of distinct supported updates, including equal-version events. Intermediate frames may be combined; assert both clients receive the exact final expected snapshot within 1,000 ms of the final event's submission. Assert equality of fields/results, not only matching versions.

Timeouts are failures with diagnostic counts/timings, not skipped tests. Document the local test environment in implementation evidence; this is not a production load/SLA claim.

## 4. Existing behavior regression

Because migration and lifecycle wiring change, run:

```sh
npm run test:engine:integration --workspace @team5/game-engine
```

Update only assertions invalidated by the new migration (migration count, projection tables no longer empty). Existing engine and catalog behavior must remain intact. Run broader foundation checks only if focused checks expose shared regressions.

## 5. Optional manual stream inspection

Only after a same-process test/development harness has created a projected session, use two terminals with a valid owner token and session ID:

```sh
curl --no-buffer --fail-with-body \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H 'Accept: text/event-stream' \
  "$ENGINE_BASE_URL/sessions/$SESSION_ID/stream"
```

Reconnect one with `-H 'Last-Event-ID: 1'`. Both should receive `event: session` frames containing full views, and reconnect should start with current state. Do not paste credentials into committed documents, command logs, or screenshots. Missing projected state should return an explicit retryable 503.

Starting separate gateway/engine Compose services alone does not wire the in-memory transport and cannot prove end-to-end live gameplay. Use the same-process integration harness for this acceptance.

## Client and deployment notes

- Supply the gateway's matching JWT access-token settings to engine. If all JWT
  settings are omitted, engine can start but SSE returns `projection_unavailable`.
- Use fetch streaming with an Authorization header; native EventSource cannot
  attach it. Do not put credentials in query strings.
- Apply every complete snapshot, including repeated domain-version SSE IDs.
  Intermediate updates may coalesce; reconnect always starts with latest state.
- Streams close strictly at expiry; refresh through gateway before reconnecting.
  Logout/account/family revocation is not rechecked before expiry.
- Exact CORS origins, GET/OPTIONS and Authorization/Last-Event-ID are supported.
  Proxy this route to engine without compression/buffering; allow idle timeouts
  longer than the 15-second heartbeat interval.
- 400: malformed session/cursor; 401: invalid credentials; 403: wrong owner/origin;
  503: missing projection (`Retry-After: 1`) or unavailable store/listener/auth.
- Health exposes projection tables, listener, consumer, auth and live status
  independently. Standalone/Compose transport is `not_connected`, not live.
- Unsupported expiry/escape/hint/reset events remain no-ops; no complete terminal
  parity or production transport guarantee is implied.

## References

- [Authoritative design](../../DESIGN-v2.md)
- [Session stream contract](session-stream-contract.md)
