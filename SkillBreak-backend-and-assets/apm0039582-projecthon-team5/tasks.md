# Tasks

The work to build the platform in [DESIGN-v2.md](DESIGN-v2.md), split into three features. Each task names an owner (Eden or Amit), a size, its dependencies and a "done when" check. Each task's brief is written so it can be picked up without reading the other tasks.

Sizes: **S** ≈ 1–2 days, **M** ≈ 3–4 days, **L** ≈ 5+ days.

## Already Done (Demo 1)

- gateway-api: signup, login, refresh and logout (`/auth/*`), JWT access tokens, `gateway_db` with migrations, `GET /health`, Swagger, docker compose.

## Ground Rules

- **Contracts first.** Task 1.1 fixes the message types, event envelope, transport interface and session view shape in a shared package. After that, both people build against the contract and do not wait for each other's code.
- **No Event Hubs access yet.** Feature 1 uses an in-memory transport adapter in tests. It lets us build and test service behavior without connecting to Event Hubs, but it does not connect separately running service processes. The Event Hubs adapter and full multi-service runtime are explicitly deferred until access is available.
- **Local stack.** Everything needed for current work runs in docker compose: one Postgres per service and Redis. No Event Hubs emulator, namespace, or checkpoint storage is required yet.
- **One PR per task.** Each PR has tests, and the CI must pass before merge.
- **Split by area.** Eden owns sandbox-manager, the messaging library and projection. Amit owns game-engine and script-catalog. The frontend is split by screen. This keeps both people in separate code most of the time.

---

## Feature 1: Room 1 Playable End to End

**Committed deliverable.** A signed-in player starts a game and plays the whole of room 1 in the browser:

1. They query Idan's database read-only in a real SQL sandbox and find Dana's username and password hash.
2. They crack the hash in the Hash-Cracker.
3. They log in to Dana's computer.

The login moves the session to room 2, which shows a "coming soon" screen. Backend and frontend both work, with live updates over SSE and the countdown running.

**Out of scope for Feature 1:**
- Ruin and reset. The SQL user is read-only, so a write fails and nothing can be ruined.
- Reconnect, the janitor, hints, room 2 and gVisor (locally the sandbox runs with the default Docker runtime).

| # | Task | Owner | Size | Depends on |
| --- | --- | --- | --- | --- |
| 1.1 | Shared contracts and local stack | Amit | S | none |
| 1.2 | Messaging contracts, in-memory adapter, outbox and inbox | Eden | M | 1.1 |
| 1.3 | script-catalog with the room-1 script | Amit | M | 1.1 |
| 1.4 | game-engine core: sessions, state machine, components | Amit | L | 1.1, (1.2 to wire) |
| 1.5 | sandbox-manager: SQL sandbox | Eden | L | 1.1, (1.2 to wire) |
| 1.6 | gateway-api: session routes | Amit | S | 1.1, (1.2 to wire) |
| 1.7 | projection: session view and SSE | Eden | M | 1.1, (1.2 to wire) |
| 1.8 | Frontend shell: sign-in, start game, SSE, room frame | Amit | M | 1.1 |
| 1.9 | Frontend room-1 screens and copy/paste | Eden | M | 1.1, 1.8 (frame only) |
| 1.10 | Room-1 end-to-end test and demo run | Eden + Amit | S | all above |

**Parallel plan:**
- Day 1: both people agree on 1.1.
- Then Eden builds 1.2 → 1.5 → 1.7 → 1.9, while Amit builds 1.3 → 1.4 → 1.6 → 1.8.
- Each service is built and tested against the contracts and in-memory adapter. The services can be tested together in a single-process integration harness; full multi-process messaging is deferred until the Event Hubs adapter is available.

### 1.1 Shared contracts and local stack — Amit (S)

- **Brief:** create the shared TypeScript package `packages/contracts` used by every service and the frontend. It holds:
  - every message type from DESIGN-v2 section 5: StartSession, SubmitInput, ProvisionSandbox, SandboxReady, SessionStarted, PuzzleOpened, CommandEvaluated, PuzzleSolved, RoomEntered and the others;
  - the event envelope `{eventId, sessionId, sessionVersion, occurredAt}`;
  - the `messageId` property;
  - the verdicts `progress | solved | rejected | ruined`;
  - the session view shape that projection sends over SSE.
- **Transport interface:** define producer and consumer interfaces in `packages/contracts` so services don't depend directly on an Event Hubs SDK.
- **Local stack:** extend docker compose with one Postgres per service and Redis. Do not add an Event Hubs emulator or checkpoint store yet.
- **Repo layout and config:** add the empty NestJS apps (game-engine, sandbox-manager, script-catalog) next to gateway-api, with an empty projection module inside game-engine (`apps/game-engine/src/projection/`), and a `.env.example` per service (DESIGN-v2 section 16).
- **Done when:** `docker compose up` starts the local databases and Redis healthy; each service answers `GET /health`; and both Eden and Amit have reviewed the contracts PR.

### 1.2 Messaging foundation — Eden (M)

- **Brief:** create `packages/messaging` against the interfaces from 1.1, without importing or connecting to an Event Hubs SDK. It provides:
  - **In-memory transport:** producer and consumer for tests; supports multiple consumers, per-session ordering, and duplicate delivery simulation. It is a test adapter, not a durable broker and not for connecting separately running services.
  - **Outbox and inbox:** TypeORM entities and helpers so each service can save state changes and outgoing messages together, and deduplicate by `(consumer, messageId)`.
  - **Outbox relay interface:** services can relay committed rows through an injected transport. The in-memory adapter is used now; the Event Hubs transport implementation is deferred.
  - **Retry/dead-letter policy:** reusable handler logic that retries up to 5 times and records exhausted failures in the service's `dead_letters` table. Do not claim Event Hubs checkpoint or production delivery semantics until its adapter is implemented.
- **Reference:** DESIGN-v2 sections 5 and 8 ("One Transition, One Transaction", "Outbox and Inbox").
- **Done when:** tests using only the in-memory adapter prove per-session order, duplicate handling, 5 failed attempts followed by a dead-letter record, and that a resent outbox message is dropped by the inbox. No Event Hubs credentials or connection are needed.
- **Explicitly deferred:** Event Hubs producer/consumer adapter, checkpoint store, and a multi-process compose test. Add these once the team has namespace access and credentials; verify ordering, checkpoints, retries, and recovery against the real service before calling messaging production-ready.

### 1.3 script-catalog with the room-1 script — Amit (M)

- **Brief:** build `catalog_db` with scripts, script_versions and templates (DESIGN-v2 section 9).
- **Seed room 1** as version 1 of the `escape-room` script:
  - three puzzles: `idan-db` (sql), `hash-cracker` (hash, opensAfter idan-db) and `dana-login` (answer, opensAfter hash-cracker);
  - a transition from room-1 to room-2 on AllSolved. room-2 has no puzzles yet and is not final, so the game stops there.
  - **Templates:**
    - `sql`: image digest placeholder, seed reference, read-only policy, goal check.
    - `hash`: the expected sha256.
    - `answer`: Dana's username and password.
- **Routes:**
  - internal `GET /internal/scripts/:id/versions/:v`;
  - internal `GET /internal/templates/:key/versions/:v`;
  - a "current published version" lookup by slug.
- **Publish:** the publish-time checks are not needed yet; seed data is inserted as published.
- **Done when:** the engine can fetch the room-1 script and its three templates over HTTP, and published rows can't be updated (enforced in code and covered by a test).

### 1.4 game-engine core — Amit (L)

- **Brief:** build `engine_db` with sessions, session_puzzles, command_log, outbox, inbox and dead_letters (DESIGN-v2 section 9).
- **State machine:** the pure function `transition(snapshot, event, scriptVersion) -> {nextSnapshot, effects[]}` (section 6).
- **Handlers:**
  - **StartSession:** load the script from the catalog, create the session with a deadline, enter room-1, open idan-db, and emit ProvisionSandbox, SessionStarted and PuzzleOpened.
  - **SandboxReady / SandboxFailed:** set `sandboxStatus`.
  - **SubmitInput:** run the guards (Active, before deadline, puzzle open, sandbox ready, generation matches), then the component, then commit with the version column check.
- **Component factory** with three components:
  - `SqlComponent`: calls sandbox-manager `POST /internal/sandboxes/:id/exec`; the goal is met when the output shows Dana's auth log hash.
  - `HashComponent`: sha256 with `timingSafeEqual` on a worker_threads pool with a 2 s limit.
  - `AnswerComponent`: compares the fields.
- **Room change and owner route:** emit RoomEntered when all room-1 puzzles are solved, and serve `GET /internal/sessions/:id/owner` for the gateway.
- **Done when:**
  - unit tests cover `transition()` for every room-1 step;
  - an integration test plays StartSession → solve all three → RoomEntered(room-2) using a stubbed sandbox exec;
  - a version conflict retries and does not double-apply.

### 1.5 sandbox-manager: SQL sandbox — Eden (L)

- **Brief:** build `sandbox_db` with sandboxes, exec_results, outbox, inbox and dead_letters (DESIGN-v2 section 9).
- **SQL image:** a Postgres-based image seeded with the `employees` and `logs` tables (Dana's row; her `auth` log entry with the password hash, matching the template in 1.3). The player connects as a read-only role, so writes fail.
- **Provision** (consume ProvisionSandbox):
  - Use `sandboxId = hash(sessionId, puzzleKey, generation)` as the container name.
  - Upsert the row, create and start the container with labels, run the seed and health-check it (3 tries, 10 s).
  - Emit SandboxReady, or emit SandboxFailed and destroy the container.
- **Exec** (`POST /internal/sandboxes/:id/exec`):
  - Return the stored result if the commandId was already run.
  - Otherwise run the query with a 5 s timeout and a 64 KB cap, return rows as a grid, store the result and extend the lease.
- **Destroy:** consume DestroySandbox.
- **Docker runtime:** locally the default runtime, with network none, limits and non-root. gVisor comes in Feature 3.
- **Done when:**
  - a ProvisionSandbox message yields a ready container and SandboxReady;
  - a SELECT returns rows; an UPDATE or DROP is rejected by the database;
  - running the same commandId twice runs the query once;
  - a destroy removes the container.

### 1.6 gateway-api: session routes — Amit (S)

- **Brief:** add these routes on top of the existing auth:
  - `POST /sessions {scriptSlug, requestId}` → new sessionId, send StartSession, reply 202;
  - `POST /sessions/:sid/puzzles/:key/inputs {commandId, input}` → owner check, send SubmitInput, reply 202;
  - `POST /sessions/:sid/abandon`.
- **Owner check:** call the engine's `GET /internal/sessions/:id/owner` (no cache yet).
- **Errors:** if Event Hubs is unreachable, return 503.
- **Swagger:** document the new routes.
- **Done when:** in Swagger, a signed-in player starts a session and posts an input. Another user gets 403 on that session, and a missing token gets 401.

### 1.7 projection: session view and SSE — Eden (M)

- **Brief:** in the projection module inside game-engine, build the `projection` schema in engine_db with session_view, inbox and dead_letters.
- **Consume game-events:** handle SessionStarted, PuzzleOpened, CommandEvaluated, PuzzleSolved, RoomEntered and SessionAbandoned. Update `session_view` only if the event's sessionVersion is newer, then send a Postgres NOTIFY.
- **SSE route** `GET /sessions/:sid/stream`:
  - Verify the JWT (same secret, iss, aud) and that the user owns the session.
  - Send the current snapshot first (id = version), then changes. Honor Last-Event-ID.
- **View contents:** current room, puzzle statuses, `deadlineAt`, sandbox status, and the last command output per puzzle (the SQL grid, the hash-cracker result, the login result).
- **Done when:**
  - two browser tabs on the same session receive the same updates;
  - a stale event is ignored;
  - a reconnect with Last-Event-ID resumes without a gap.

### 1.8 Frontend shell — Amit (M)

- **Brief:** React + TypeScript app (Vite) with the following parts:
  - **Auth pages:** signup and login pages against the existing `/auth/*`, with token refresh.
  - **Start game:** a "Start game" button (`POST /sessions`).
  - **SSE hook:** an SSE client hook that keeps the latest session view and reconnects by itself.
  - **Room frame:** shows the room's skin image from the CDN or local assets, clickable hotspots defined per room, a central "zoom" panel where puzzle screens open, closing by clicking outside, the countdown from `deadlineAt`, and a status line ("sandbox starting…", "ready").
  - **Room 2 placeholder:** a "coming soon" screen for room-2.
  - **Commands:** a helper to post inputs with a fresh commandId, retried with the same id on network errors.
- **Done when:** a player signs up, starts a game, sees the room-1 image with hotspots and the countdown, and the frame shows "ready" when SandboxReady arrives.

### 1.9 Frontend room-1 screens and copy/paste — Eden (M)

- **Brief:** build the three puzzle screens that open inside 1.8's zoom panel:
  1. **Idan's computer:** a DataGrip-style SQL view with table names, a query box and a result grid. Results come from the view, not from the HTTP reply.
  2. **Hash-Cracker:** an input and an output.
  3. **Dana's computer:** a login window that, after success, shows the "open room" file. Clicking it shows the move to room 2.
- **Copy and paste** (DESIGN-v2 section 13): grid cells and outputs are selectable and have a Copy button; all inputs accept paste and single-line fields trim spaces.
- **Inventory note:** when the password is cracked, add a note to the inventory bar.
- **Errors:** rejected verdicts (wrong answer, blocked query) show a short message.
- **Done when:** the whole room 1 can be solved with mouse and keyboard only, using copy/paste between screens.

### 1.10 Room-1 end-to-end test and demo run — Eden + Amit (S)

- **Brief:** add a Playwright test against the frontend and a single-process backend integration harness using the in-memory transport: sign up, start a game, run the two SQL queries, copy the hash, crack it, log in as Dana, and see room 2. This verifies the feature flow, not multi-process broker delivery.
- **CI:** run the test in CI.
- **Demo run:** rehearse the demo once.
- **Split:** Eden writes the test; Amit fixes integration issues on the backend side and writes the README "how to run room 1".
- **Done when:** the test is green in CI and the README steps work on a clean machine.

---

## Feature 2: Room 2 and Escaping

**Deliverable.** The full story is playable:

1. git terminal on Nathaniel's computer.
2. Capture viewer on his computer.
3. RSA decryptor.
4. TLS decryptor ("The file has been decrypted").
5. Decrypted capture.
6. Door code.
7. Victory screen.

Ruining a sandbox puzzle resets it.

| # | Task | Owner | Size | Depends on |
| --- | --- | --- | --- | --- |
| 2.1 | Room-2 puzzle material: git repo, keys, capture | Eden | M | Feature 1 |
| 2.2 | sandbox-manager: git terminal sandbox and ruin checks | Eden | L | 2.1 |
| 2.3 | script-catalog: room-2 script, templates, room files | Amit | S | 2.1 (values only) |
| 2.4 | game-engine: RSA and TLS components, room files | Amit | M | 2.3 |
| 2.5 | game-engine: ruin and reset, Escaped ending | Amit | M | Feature 1 |
| 2.6 | projection: room files, resets, ending | Eden | S | contracts for 2.4/2.5 |
| 2.7 | Frontend: git terminal and capture viewer | Eden | M | 2.6 (view shape) |
| 2.8 | Frontend: RSA, TLS, door lock and victory | Amit | M | 2.6 (view shape) |
| 2.9 | Full-game end-to-end test | Eden + Amit | S | all above |

**Parallel plan:**
- Eden starts with 2.1, because the room-2 values (key, capture) feed everything else.
- Meanwhile Amit does 2.5, which needs nothing new.
- Then Eden does 2.2 → 2.6 → 2.7, and Amit does 2.3 → 2.4 → 2.8.

### 2.1 Room-2 puzzle material — Eden (M)

- **Brief:** write a reproducible script (in the repo, run in CI) that generates:
  - **Keys:** an RSA key pair and a self-signed server certificate.
  - **Git repo:** a git repository for Nathaniel in which an earlier commit contains the private key and the last commit is "Security fix: Removed private key from repository."
  - **Capture:** `Cibus_payment_try.pcap`, a TLS 1.2 RSA-key-exchange capture of a Cibus payment that contains Nathaniel's credit card number in the Application Data.
  - **Text views:** a text view of the capture in two versions. The encrypted version shows the handshake in clear up to the Client Key Exchange, then encrypted records. The decrypted version shows the Application Data payload.
- **Seed values:** output the values the templates need: N, e, the encrypted PMS, client random, server random, the encrypted records, and the card number (the door code).
- **Secrets:** no real card data; use a test card number.
- **Done when:** running the script twice gives working material; decrypting with the key and the PRF reproduces the card number.

### 2.2 sandbox-manager: git terminal sandbox — Eden (L)

- **Brief:** build a `terminal-git` image with the repo from 2.1, `GIT_PAGER=cat`, `PAGER=cat`, and a non-root user.
- **Exec:** run one shell line per call (5 s, 64 KB) and return stdout and stderr.
- **Checks** (probe commands after each exec):
  - **Goal:** the player has printed the key, for example via `git show <commit>`.
  - **Invariant** (ruin): no new commit and no rewritten history.
- **Deny-list:** block network tools and interactive programs (vim, less).
- **Done when:**
  - `git log` and `git show HEAD~1` work;
  - a `git commit` is reported as ruined by the checks;
  - `vim` is rejected without running.

### 2.3 script-catalog: room-2 script — Amit (S)

- **Brief:** publish version 2 of `escape-room`:
  - room-2 with `nethanel-git` (terminal-git), `rsa-decryptor` (rsa), `tls-decryptor` (tls) and `door` (answer), each opening after the one before;
  - room-2 → escaped on AllSolved;
  - `onRuin = resetPuzzle` everywhere;
  - room-2 file `Cibus_payment_try.pcap` with `revealedBy = tls-decryptor` (DESIGN-v2 section 6, "Room Files").
- **Templates:** fill them from the 2.1 seed values.
- **Publish checks:** add the publish checks from section 6 (reachable states, a final state reachable, no opensAfter cycles, templates exist).
- **Done when:** version 2 publishes, a broken script is rejected by the checks, and running sessions stay on version 1.

### 2.4 game-engine: RSA and TLS components — Amit (M)

- **`RsaComponent`:** the pasted key must match N, then decrypt the PMS (PKCS#1 v1.5). On success the output is the PMS.
- **`TlsComponent`:** TLS 1.2 PRF(PMS, client random, server random) → keys → decrypt the records. On success the output is the decrypted capture view.
- **Room files:**
  - Send the encrypted file in RoomEntered.
  - When tls-decryptor is solved, put the decrypted content in PuzzleSolved, with the message "The file has been decrypted".
  - The decrypted content must never leave the engine before the solve.
- **Limits:** both run on the worker pool (2 s, input size caps).
- **Done when:** unit tests with the 2.1 values pass for the right answer and reject a wrong key, a wrong PMS and a wrong client random.

### 2.5 game-engine: ruin and reset, Escaped — Amit (M)

- **Ruin:** on `ruined`, increase the generation and emit DestroySandbox (old), ProvisionSandbox (new) and PuzzleReset.
- **Stale sandbox:** reject commands, and ignore sandbox events, for an old generation.
- **Ending:** reaching the final state sets the session to Escaped and emits SessionEscaped.
- **Expiry guard:** the deadline is checked on every command (already in 1.4) and covered by a test here.
- **Done when:** an integration test ruins the git puzzle and gets a fresh sandbox while the clock keeps running, and the full winning path ends as Escaped.

### 2.6 projection: room files, resets, ending — Eden (S)

- **Brief:** extend the session view with:
  - room files (encrypted, then decrypted);
  - "puzzle reset, sandbox restarting" on PuzzleReset;
  - the ending (Escaped, Expired, Abandoned).
- **Done when:** the SSE stream shows the file switching from encrypted to decrypted after the TLS solve, and shows the reset and the ending.

### 2.7 Frontend: git terminal and capture viewer — Eden (M)

- **git terminal:** an xterm.js terminal on Nathaniel's computer, line by line, with a prompt, local editing and up-arrow history.
- **Terminal copy and paste:** Cmd+C or Ctrl+Shift+C copies a selection; plain Ctrl+C cancels the line. A pasted line break is not sent as Enter.
- **Capture viewer:** Nathaniel's computer shows the pcap file. Clicking it opens the capture large in the middle, scrollable and selectable; clicking outside closes it. After the TLS solve the same file shows the decrypted content.
- **Reset message:** show "sandbox restarting" in the terminal on reset.
- **Done when:** a player recovers and copies the key from the terminal, and copies N, the encrypted PMS, the client random and later the card number from the viewer.

### 2.8 Frontend: RSA, TLS, door and victory — Amit (M)

- **RSA decryptor:** a multi-line key field plus the encrypted PMS and N fields. The output is the PMS with a Copy button.
- **TLS decryptor:** PMS and client random fields. On success it shows "The file has been decrypted".
- **Door lock:** a card-number keypad or field.
- **Victory screen:** Dana, the "Welcome to the team" sign and the AT&T icon.
- **Other endings:** "Time is up" and "Game abandoned" screens.
- **Done when:** these screens complete room 2 together with 2.7, and every field accepts paste.

### 2.9 Full-game end-to-end test — Eden + Amit (S)

- **Brief:** extend the Playwright test from 1.10 to play the whole game to Escaped, plus one ruin-and-reset case.
- **Split:** Eden writes the room-2 steps; Amit writes the ruin case and the README update.
- **Done when:** the test is green in CI.

---

## Feature 3: Hints, Reliability, Admin and Deployment

**Deliverable:**
- Hints work in both rooms.
- The game survives reconnects, timeouts and failures.
- Sandboxes are hardened.
- Admins can see the overview and publish.
- Everything runs in Azure.

| # | Task | Owner | Size | Depends on |
| --- | --- | --- | --- | --- |
| 3.1 | Hints backend: RequestHint, HintRevealed, hint texts | Amit | M | Feature 2 |
| 3.2 | Hints frontend and projection | Eden | S | 3.1 (contract) |
| 3.3 | Reconnect flow and engine janitor | Amit | M | Feature 2 |
| 3.4 | Sandbox hardening: gVisor, isolation, reaper | Eden | L | Feature 2 |
| 3.5 | Dead-letter replay and alerts | Eden | S | 1.2 |
| 3.6 | Admin overview | Eden | M | 3.1 (hintsUsed) |
| 3.7 | Admin publish flow | Amit | S | 2.3 |
| 3.8 | Azure deployment and Key Vault | Amit | M | all services |
| 3.9 | Final end-to-end and failure tests | Eden + Amit | S | all above |

**Parallel plan:** Amit does 3.1 → 3.3 → 3.7 → 3.8, and Eden does 3.2 → 3.4 → 3.5 → 3.6.

### 3.1 Hints backend — Amit (M)

- **Script:** add `hint` to PuzzleDef in the catalog and a script version with the four demo hints (DESIGN-v2 section 13: on dana-login, rsa-decryptor, tls-decryptor and door).
- **Gateway:** `POST /sessions/:sid/hints {commandId}` sends RequestHint.
- **Engine:**
  - The current hint is the first unsolved puzzle with a hint in the current room.
  - The first time a hint is shown, set `hintRevealedAt`.
  - Emit HintRevealed `{puzzleKey, text, firstTime}`.
  - If there is no current hint, reject the request with `noHint`.
  - A hint costs no time.
- **Done when:** tests show the right hint at each stage, a second request isn't counted twice, and `noHint` works after the last hinted puzzle.

### 3.2 Hints frontend and projection — Eden (S)

- **projection:** add the revealed hints to the view; they come back after a reconnect.
- **Frontend:** a Hint button at the bottom right; the hint shows in a small panel. "No hint for this step" is shown for `noHint`.
- **Done when:** each of the four hints appears at the right time in the browser.

### 3.3 Reconnect and janitor — Amit (M)

- **Reconnect:** `POST /sessions/:sid/reconnect` sends PlayerReconnected. Every open sandbox puzzle gets generation+1 and a fresh container (DESIGN-v2 F5). The frontend calls it when the SSE stream reconnects.
- **Janitor:** a background job runs every 60 s with one leader (Redis lock). It handles:
  - Active sessions past the deadline → Expired, and destroy their sandboxes;
  - sessions idle for 30 min → Abandoned;
  - puzzles that wait more than 3 min for a sandbox → provision again (max 3 times);
  - outbox rows unsent for more than 5 min → alert.
- **Done when:** tests cover the race between expiry and a solve, a reconnect mid-room, and a stuck sandbox that recovers.

### 3.4 Sandbox hardening — Eden (L)

- **Brief:** apply the isolation table in DESIGN-v2 section 7:
  - the gVisor `runsc` runtime;
  - no network and egress denied;
  - a read-only root with a 64 MB tmpfs `/work`;
  - user 1000, all capabilities dropped, `no-new-privileges` and seccomp;
  - limits of 64 processes, 256 MB memory, 0.5 CPU and 256 open files;
  - images pinned by digest and built in CI.
- **Reaper:** runs every 60 s and handles:
  - an expired lease, or a sandbox older than 2 h → destroy;
  - stuck in creating → failed;
  - orphan containers → remove;
  - 3 failed health probes → SandboxFailed.
- **Done when:** a test container can't reach the network, a fork bomb is stopped by the limits, and an orphan container is removed.

### 3.5 Dead-letter replay and alerts — Eden (S)

- **Replay:** an admin route per service to list and replay `dead_letters`.
- **Alerts:** an alert (log-based for now) when a table isn't empty.
- **Done when:** a poisoned message lands in `dead_letters` and, after a fix, a replay processes it once.

### 3.6 Admin overview — Eden (M)

- **Route:** projection serves `GET /admin/overview`, protected by the JWT and the admin role.
- **Overview:** games in progress; games finished today by ending; and per puzzle the average solve time, wrong attempts, ruin resets and hints used.
- **Refresh:** recompute on session start and end. Store the result in Redis key `admin:overview`; if Redis isn't available, compute it from the `projection` schema (DESIGN-v2 section 12).
- **Frontend:** a simple admin page.
- **Done when:** the numbers match a scripted set of test games.

### 3.7 Admin publish flow — Amit (S)

- **Brief:** `POST /admin/scripts/:id/versions/:v/publish` on the gateway calls the catalog over HTTP with the admin role.
- **On publish:** the catalog validates the script, commits it, emits ScriptVersionPublished and drops the current-version pointer. New sessions use the new version; running sessions keep theirs.
- **Done when:** publishing a hint-text change affects only new games.

### 3.8 Azure deployment — Amit (M)

- **Brief:** provision the infrastructure:
  - an Event Hubs namespace with the five event hubs and consumer groups;
  - Postgres databases, Redis, and Blob Storage for checkpoints and skin images (CDN);
  - Key Vault with managed identity (no secrets in git; `.env.example` has placeholders only);
  - a separate sandbox node pool.
- **CI/CD:** deploy each service on its own.
- **Done when:** the full game is playable on the Azure environment.

### 3.9 Final end-to-end and failure tests — Eden + Amit (S)

- **Brief:** run the full game in Azure, plus failure drills from DESIGN-v2 section 14:
  - kill sandbox-manager mid-game;
  - restart a consumer;
  - send a duplicate command;
  - let the time run out.
- **Split:** Eden runs the sandbox and messaging drills; Amit runs the session and deployment drills.
- **Done when:** every drill behaves as the design says and the results are written down.

---

## Later (Not in These Three Features)

- **Event Hubs connection and adapter:** implement the real Event Hubs producer/consumer, configure the namespace and checkpoint store, and run multi-process end-to-end tests only after credentials and network access are available. Until then, the in-memory adapter is for automated tests only; the distributed service runtime is not yet runnable end to end.
- **SkillSwapper teacher recommendations** (DESIGN-v2 section 15): after a game, show teachers for skills solved slower than the target time. Uses `skillSwapApiToken`. It needs the SkillSwapper API contract first.
- **Clippy coach.**
- **Redis caches** beyond locks and `admin:overview`: the session-owner cache in the gateway and the template cache in the engine. Add them only when measurements show the need.

## Workload Balance

| | Eden | Amit |
| --- | --- | --- |
| Feature 1 | 1.2 M, 1.5 L, 1.7 M, 1.9 M, 1.10 shared | 1.1 S, 1.3 M, 1.4 L, 1.6 S, 1.8 M, 1.10 shared |
| Feature 2 | 2.1 M, 2.2 L, 2.6 S, 2.7 M, 2.9 shared | 2.3 S, 2.4 M, 2.5 M, 2.8 M, 2.9 shared |
| Feature 3 | 3.2 S, 3.4 L, 3.5 S, 3.6 M, 3.9 shared | 3.1 M, 3.3 M, 3.7 S, 3.8 M, 3.9 shared |
