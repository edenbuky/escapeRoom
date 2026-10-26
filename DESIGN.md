# Smart Test Components: Platform and Escape Room Design

# Part 1: Platform

## Project Definition

- A platform of smart test components: interactive riddles that test a real skill, such as SQL, git, hashing, RSA, or TLS.
- A **component** is a factory product: a small live sandbox of one kind. Some kinds run the player's commands (SQL database, terminal with a filesystem and git). Others check a submitted answer (hash, key, lock).
- A **riddle** is a component kind plus data: a **seed** (the starting sandbox), a **policy** (what is allowed, rejected, or ruins it), and a **goal** (what solves it). The same component with different data is a different riddle. For example, one terminal component can serve:
  - read the git history to find a leaked key (read-only),
  - search folders for a specific file,
  - rebase a broken history until the tree matches a target.
- The server is the judge. It holds the sandboxes, the answers, the timer, and the rules, decides every outcome (`ok`, `solved`, `rejected`, `ruined`, `expired`), and records how long each riddle took and how many tries it needed. It never renders.
- The frontend is the stage. It draws the game's skin (rooms, pictures, windows), sends what the player typed, and shows what the server answered. It never decides whether something is right.
- **The escape room is the first game:** one Script (which riddles, in what order, with which data) plus one skin. A later game is a new Script and a new skin over the same components. There is no second backend.

## Scope

| Status | Items |
| --- | --- |
| Built (base) | Entra sign-in, session start, session timer |
| Demo target | Escape room Script playable end to end: component factory, all six kinds, policy and goal engine, sessions, escape room skin. Does not depend on any Later Feature |
| Later | Hint Platform, Admin Statistics, Clippy Board, SkillSwapper, Struggles |

## Technology Stack

These are binding constraints. A design choice that drops one is a change to this section, not a local exception.

| Area | Rule |
| --- | --- |
| Backend | NestJS in TypeScript. The REST API (HTTP and JSON) owns all business logic: validation, state changes, and domain rules. OpenAPI is published through Swagger UI (`@nestjs/swagger`). TypeScript only; no Java or JDK. |
| Frontend | React in TypeScript. It talks to the backend only through the REST API. It draws the skin, collects input, and presents state. It never owns a business rule and never opens Postgres, Redis, or the event bus. |
| Authentication | Microsoft Entra ID. The browser signs in with Entra and sends the token. The server validates it on every call. No passwords are collected, hashed, or stored, and there are no server-side session cookies. |
| Authorization | Role-based and enforced on the server. Every protected action names its role (see API Routes). A missing or insufficient role is rejected by the API. Hiding a button is not authorization. |
| Database | Postgres is the system database, accessed only through repositories built on TypeORM (see Repository Pattern). Users store their Entra identity, never a password. TypeORM migrations build the schema and seed the Scripts, and one documented command rebuilds a clean local database. Connection settings come from environment variables: `.env.example` lists them with placeholders, and the real `.env` and secrets stay out of git. No in-memory or mocked substitute: an API write survives a restart. |
| Caching | Redis for exactly one feature: **Admin Statistics**. It caches read-heavy aggregates for `GET /admin/stats`. Postgres is the source of truth, and the cache is invalidated on every session status change. No other feature adds a cache. |
| Event-driven | Exactly one feature: **Hint Platform**. Sessions publishes `RiddleSolved`, and a separate handler stores the earned note. The request does not do that work inline. Every other feature is request/response. |
| Game assets | Azure Blob Storage + CDN for the skin only (pictures, backgrounds, icons). Static, published by deploy, browser read-only. Riddle data never goes to Blob. |

### Sandbox Engines

Sandboxes are riddle state, not TypeORM data and not a cache. Postgres remains the system database. Each engine sits behind an adapter (see Adapter Pattern), so components never import a library directly.

| Engine | Library | Used by |
| --- | --- | --- |
| SQL engine | sqlplay (SQLite, in memory) built from seed tables | `sql` |
| Filesystem + git engine | `memfs` in-memory filesystem, isomorphic-git on that filesystem, and a small shell (`ls`, `cd`, `cat`, `find`, `grep`, `git <subcommand>`) | `terminal` |
| Crypto engine | Node `crypto`: sha256, RSA decrypt, TLS key derivation and record decrypt | `cracker:hash`, `cracker:rsa`, `cracker:tls` |
| None | Field comparison | `lock` |

- xterm.js (`@xterm/xterm`) only draws the terminal. Each line goes to the server, and the server returns text.
- The browser only ever receives output: columns and rows, terminal text, or a result message.
- Limits: the engine adapters enforce a command timeout (SQLite: progress-handler step limit), a row cap, an output cap and a max input length. Over a limit → `rejected` with a message, not ruin.

## Architecture Patterns

| Pattern | Where | What it buys |
| --- | --- | --- |
| Factory | `ComponentFactory` builds a component by `kind`. `GoalEvaluatorFactory` builds a goal check by goal `type` | New riddle = new data, not new code. New kind = one class registered in one place |
| Strategy | Policies and goals are data interpreted by small, interchangeable evaluators | Riddle rules live in `Riddle.config`, not in component classes |
| Repository | One repository per entity wraps TypeORM. Modules share repositories, never the ORM | Several modules can read and write Postgres through one controlled path, testable with fakes |
| Singleton | NestJS default-scope providers: factories, `SandboxStore`, `EventBus`, cache client, SkillSwapper client | One registry and one sandbox store per process; no duplicated state |
| Event-Driven | `RiddleSolved` on the event bus, handled by `HintHandler` | Hint work is decoupled from the solve request |
| Adapter (Ports and Adapters) | Domain code depends on ports. Adapters wrap sqlplay, isomorphic-git and memfs, Node `crypto`, `@nestjs/event-emitter`, Redis, Entra JWKS, and the SkillSwapper API | Libraries and external services can be swapped without touching domain code |

### Factory: Components Built by Kind

- `ComponentFactory.create(kind)` returns the `SmartComponent` for a riddle's `kind`. Kinds are registered once at module start (`sql`, `terminal`, `cracker:hash`, `cracker:rsa`, `cracker:tls`, `lock`).
- A component knows how to build a sandbox from a seed, parse input, run it, and report facts about the result as **signals** (for example `match`, `keyMatched`, `decrypted`). It knows nothing about any specific riddle, story, or neighbouring riddle.
- `GoalEvaluatorFactory.create(goal.type)` returns the evaluator that decides whether the goal is met. Goal types are a small closed set implemented once (see Riddle Config).
- Adding a riddle: write a config row in a Script; ScriptValidator rejects a bad one before it runs. Adding a goal type or a kind: one class plus one registration. Sessions does not change in either case.

### Repository: Shared, Controlled Database Access

- Every entity has exactly one repository class, owned by one module and exported for others: `UserRepository` (Users), `ScriptRepository` and `RiddleRepository` (Scripts), `SessionRepository`, `ProgressRepository`, `CommandRecordRepository`, `StruggleRepository` (Sessions), `HintRepository` (Hints), `StatsReadRepository` (Stats, read-only aggregate queries).
- Services call repository methods that speak the domain (`findActiveForOwner`, `openRiddles`, `countTries`), never raw TypeORM.
- Several modules may use the same repository. Sessions, Hints, Stats, Coach, and SkillSwapper all read session data through `SessionRepository` and `ProgressRepository`. Only the owning module writes.
- **Unit of Work:** a multi-step write (solve, ruin, reset) runs in one `DataSource.transaction`. Repositories accept the transaction's `EntityManager` (`repo.with(em)`), so all writes commit or roll back together.

### Singleton: One Instance per Process

- NestJS providers are singletons by default. The design relies on this for `ComponentFactory`, `GoalEvaluatorFactory`, `SandboxStore`, the `EventBus` adapter, the Redis client, and the SkillSwapper client.
- Components are stateless singletons. All riddle state lives in sandboxes held by `SandboxStore`, keyed by session, riddle slug, run number, and restore count.
- Constraint: `SandboxStore` is in process memory, so the demo runs one API instance. A lost sandbox (restart, other instance) is rebuilt from the seed by replaying the `ok` commands for that session, riddle, runNumber and restoreCount, in order, from `CommandRecord`. Read-only riddles rebuild from the seed alone.
- `discardSession` runs after commit on complete, ruin (resetSession), expire and reset. An idle sandbox (no command for 30 minutes, `SANDBOX_IDLE_MINUTES`) is evicted; replay rebuilds it if the player returns.

### Event-Driven: Hint Platform

- Publish/subscribe through an `EventBus` port with an in-process `@nestjs/event-emitter` adapter.
- One event, one publisher, one subscriber (see Event Bus). Published only after the solve transaction commits.
- Cross-riddle completion (`solvedBy`) is not an event. It must commit in the same transaction as the solve, so it is a synchronous rule inside Sessions.

### Adapter: Ports Around Every Library and External Service

| Port (domain interface) | Adapter | Library or service |
| --- | --- | --- |
| `SqlEngine` | `SqlplayEngine` | sqlplay / SQLite |
| `FsGitEngine` | `MemfsGitEngine` | memfs + isomorphic-git |
| `CryptoEngine` | `NodeCryptoEngine` | Node `crypto` |
| `EventBus` | `EventEmitterBus` | `@nestjs/event-emitter` |
| `StatsCache` | `RedisStatsCache` | Redis |
| `TokenVerifier` | `EntraJwksVerifier` | Microsoft Entra ID (JWKS) |
| `SkillSwapperPort` | `SkillSwapperAdapter` | Other team's HTTP API (their contract, mapped to ours) |

## System Architecture

Color key: blue = browser, gray = API modules, dark gray = core, purple = event bus, green = data stores, orange = external services.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontSize": "20px", "fontFamily": "Arial, Helvetica, sans-serif", "lineColor": "#334155", "primaryTextColor": "#0f172a"}, "flowchart": {"nodeSpacing": 40, "rankSpacing": 70, "curve": "basis"}}}%%
flowchart TB
  subgraph Browser["Browser"]
    UI["React App<br/>MSAL sign-in<br/>Game skin: rooms · windows<br/>Countdown"]
  end

  subgraph API["NestJS REST API · Swagger UI /api/docs"]
    Auth["Auth + Roles Guard<br/>TokenVerifier port"]
    Sessions["Sessions<br/>policy · goal · solvedBy"]
    Components["Components<br/>ComponentFactory · GoalEvaluatorFactory<br/>SandboxStore"]
    Engines["Engine adapters<br/>SQL · FsGit · Crypto"]
    Users["Users"]
    Scripts["Scripts"]
    Hints["Hints · HintHandler"]
    Stats["Stats"]
    Coach["Coach (Clippy)"]
    SSH["SkillSwapper Adapter"]
    Repos["Repositories (TypeORM)<br/>Unit of Work"]
    Bus{{"EventBus port<br/>RiddleSolved"}}
  end

  Entra["Microsoft Entra ID"]
  PG[("Postgres<br/>System DB")]
  Redis[("Redis<br/>Admin Stats")]
  Blob[("Blob Storage + CDN<br/>Skin assets")]
  SS["SkillSwapper API<br/>Other team"]

  UI -- "Sign-in" --> Entra
  UI -- "REST + Bearer" --> Auth
  UI -- "Load skin assets" --> Blob
  Auth -. "JWKS" .-> Entra
  Auth --> Sessions & Users & Scripts & Hints & Stats & Coach & SSH
  Sessions --> Components
  Components --> Engines
  Sessions -- "StatsService.invalidate()" --> Stats
  Sessions -- "publish" --> Bus
  Bus -- "subscribe" --> Hints
  Stats -- "StatsCache port" --> Redis
  SSH -- "sync HTTP read" --> SS
  Users & Scripts & Sessions & Hints & Stats & Coach & SSH --> Repos
  Repos --> PG

  classDef browser fill:#1d4ed8,stroke:#1e3a8a,color:#ffffff,stroke-width:2px
  classDef module fill:#f1f5f9,stroke:#334155,color:#0f172a,stroke-width:2px
  classDef core fill:#334155,stroke:#0f172a,color:#ffffff,stroke-width:2px
  classDef bus fill:#7c3aed,stroke:#4c1d95,color:#ffffff,stroke-width:2px
  classDef store fill:#15803d,stroke:#14532d,color:#ffffff,stroke-width:2px
  classDef external fill:#ea580c,stroke:#9a3412,color:#ffffff,stroke-width:2px
  class UI browser
  class Auth,Users,Scripts,Hints,Stats,Coach,SSH,Repos,Engines module
  class Sessions,Components core
  class Bus bus
  class PG,Redis,Blob store
  class Entra,SS external
```

### Architecture Rules

- Only repositories access Postgres. Each entity has one owning repository; other modules use the owner's exported repository and never TypeORM directly. Only the owning module writes.
- Only the Stats module accesses Redis, through the `StatsCache` port. Other modules call `StatsService.invalidate()`.
- Nothing outside Postgres is in a transaction. Sandbox discard or restore, events and stats invalidation run after commit.
- Only Sessions publishes events, and only after commit. Only Hints subscribes.
- Only Sessions calls components, always through `ComponentFactory`. Components never call Sessions, repositories, or other components.
- Components hold no riddle-specific rules. Seed, policy, and goal come only from `Riddle.config`.
- Sandboxes live in `SandboxStore` in server memory, per session, riddle, run, and restore count. They are riddle state, not Postgres data and not a cache.
- Commands for one session are serialized; different sessions run in parallel.
- Domain code depends on ports. Only adapters import sqlplay, isomorphic-git, memfs, Redis, the event emitter, or HTTP clients.
- SkillSwapper belongs to another team. Read-only, synchronous, nothing stored.
- Only the browser reads Blob Storage (public, static skin assets). No API module touches it, and no riddle data is stored there.

### Service Layout: One Backend, Two Repos

- Two repos: frontend (React) and backend (NestJS).
- One backend service: a modular monolith. Riddles (Components module: factories, kinds, engine adapters, `SandboxStore`) and Story (Scripts and Sessions modules) are modules inside it, not separate services. Hints, Stats, Coach, and the SkillSwapper adapter are modules too.
- Why not microservices:
  - One team, one domain. No independent scaling or deploy need.
  - Ruin-and-reset must be atomic: stop session and write records in one transaction, then discard the sandbox and respond. Across services that becomes a distributed transaction or saga.
  - A command is one in-process call (Sessions to component), not a network hop with retries, timeouts, and versioned contracts.
  - One deploy, one database, one log stream, one Swagger.
  - Module boundaries plus the Architecture Rules give the same separation.
- Split later if needed: modules talk through repositories, ports, and the one event, so a module (for example Hints or Stats) can be extracted without redesign.

### Frontend Skin

- Every smart component has two halves, linked only by the riddle's `slug`. Brain: server-side (component, sandbox, policy, goal). Face: React (a picture in the room plus the window that opens when it is clicked).
- The face belongs to the game's **skin**, not to a shared component package. A skin is one folder in the frontend repo: scene manifest, rooms, pictures, and windows. A new game draws its own skin and may copy windows from another.
- The scene manifest maps each riddle `slug` to its room, picture, position, and window. It holds no answers, no order, no input fields.
- Pictures light up, unlock, or show solved only from server state: the `opened` and `alsoSolved` lists in a command response, and `GET /sessions/:sid` on load. React never computes unlock order.
- Skin images (scene pictures, room backgrounds, icons) are static assets in Azure Blob Storage behind a CDN, one folder per script: `<scriptSlug>/...`, published by a deploy step from the frontend repo (`assets/<scriptSlug>/`). No upload API.
- Riddle handouts (for example `Cibus_payment_try.pcap`) are riddle data, not skin. They must match the riddle's answers, so the API serves them from `Riddle.config.handouts`.
- Secrets never go to Blob Storage or the manifest: no solutions, no decrypted pcap, no card number, no passwords. Those come only from server responses.
- Frontend env: `VITE_ASSETS_BASE_URL` (CDN base URL).

## React Rules & Constraints

**Allowed**

- Sign in with MSAL and call the REST API with the Entra token.
- Draw the skin: rooms, pictures, and windows (SQL box with result grid, xterm.js terminal, answer forms).
- Render the countdown from server `deadlineAt` / `remainingMs`.
- Display outcomes and output returned by the server.
- Load skin assets from `VITE_ASSETS_BASE_URL`. Never hard-code solutions or secrets in assets or the manifest.

**Not allowed**

- Decide solved, ruined, allowed, or which riddle opens next.
- Parse SQL or git; hash or compare.
- Perform RSA or TLS decryption, or any puzzle computation.
- Hold a repository, a filesystem, or a SQLite file.
- Gate steps or own the timer.
- Open Postgres, Redis, or the event bus.

**Server-side riddles**

- Every sandbox and every answer check runs on the server. The browser sends input and renders output.
- The browser never decrypts the pcap. It receives the decrypted records only as the server response to a correct TLS decryptor submission.

## Frontend Scene State Machine

Room-level view for the escape room skin. The puzzle-level flow is in Part 2.

Color key: blue = room hubs, green = start and win, red = ruined, amber = expired.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontSize": "18px", "fontFamily": "Arial, Helvetica, sans-serif", "lineColor": "#334155", "primaryTextColor": "#0f172a"}, "flowchart": {"nodeSpacing": 35, "rankSpacing": 55, "curve": "basis"}}}%%
flowchart TB
  START(["START"])
  R1["ROOM 1 HUB<br/>SQL console · Hash-Cracker · Dana login"]
  R2["ROOM 2 HUB<br/>Encrypted pcap preview · Git terminal<br/>RSA decryptor · TLS decryptor<br/>Decrypted pcap view · Final lock"]
  RUINED["RUINED<br/>reset returns to Room 1"]
  EXPIRED["EXPIRED<br/>reset returns to Room 1"]
  WIN(["WIN"])
  START --> R1
  R1 -- "opened: nethanel-git, rsa-decryptor" --> R2
  R1 -- "outcome ruined" --> RUINED
  R1 -- "expired, remainingMs at 0" --> EXPIRED
  R2 -- "outcome ruined" --> RUINED
  R2 -- "expired, remainingMs at 0" --> EXPIRED
  R2 -- "session completed" --> WIN
  classDef ui fill:#1d4ed8,stroke:#1e3a8a,color:#ffffff,stroke-width:2px
  classDef store fill:#15803d,stroke:#14532d,color:#ffffff,stroke-width:2px
  classDef bad fill:#b91c1c,stroke:#7f1d1d,color:#ffffff,stroke-width:2px
  classDef warn fill:#d97706,stroke:#78350f,color:#ffffff,stroke-width:2px
  class R1,R2 ui
  class START,WIN store
  class RUINED bad
  class EXPIRED warn
```

### Transition Rules

- Opening and closing windows, and click-outside, are local.
- Every progress transition (picture lights up, room unlock, riddle solved, win) fires only on server state: `opened`, `alsoSolved`, `riddle.status`, `session.status`.
- Room 2 unlocks when the `dana-login` solve response lists the Room 2 riddles in `opened`. The "open room" desktop icon is a local step after that response.

### Server-Driven States

| State | Trigger | Behavior |
| --- | --- | --- |
| Ruined | Outcome `ruined` | Show message; offer reset (`POST /sessions/:sid/reset`); return to Room 1 hub with fresh state |
| Expired | Outcome `expired`, or server `remainingMs` ≤ 0 | Show time-up; offer reset |
| Stuck (later) | Player action: `POST /sessions/:sid/struggles` (later) | Open help panel; stay in current scene |

### Timing and Hints

- The visible countdown renders server `deadlineAt` / `remainingMs`. It is the only countdown; no per-riddle or per-phase timers in the browser.
- The frontend sends no timer calls. Riddle timing arrives in command responses: `riddle {status, openedAt, solvedAt}`.
- On page load, `GET /sessions/:sid` restores session state, every riddle's status by slug, and the saved `result` of solved answer riddles.
- Hint Platform (later): after a `solved` outcome, refresh the inventory with `GET /sessions/:sid/hints`. The note may lag the response. The demo path never waits for a hint.

### Submissions

- Every riddle uses one endpoint: `POST /sessions/:sid/riddles/:slug/commands {input}`.
- Command kinds (`sql`, `terminal`) send `input` as a string. Answer kinds send `input` as an object of named fields, validated by the component's schema (for example `{hash}`, `{username, password}`, `{privateKey, encryptedPms, n}`). For `lock`, the fields are the field names in the riddle's seed (dana-login: `username`, `password`; door: its digits field).
- Handouts: `GET /sessions/:sid/riddles/:slug/handouts/:name`. Served while the riddle is open or solved, not while locked. Roles: see API Routes.

## Component Responsibilities

| Module | Responsibility |
| --- | --- |
| Config | Environment variables only (`.env`, `.env.example`) |
| Database | TypeORM `DataSource`, migrations, Script seeds, Unit of Work helper. Hosts no business logic |
| Auth | `TokenVerifier` port with the Entra JWKS adapter (audience = `ENTRA_API_CLIENT_ID`). Global guard. Role from Entra app roles (token `roles` claim), default `player`. No passwords |
| Roles (in Auth) | `@Roles(role)` + roles guard. Roles: `player`, `admin`. Every protected endpoint names one (see API Routes) |
| Users | `UserRepository`, user record and role. On the first authenticated request, upserts the User by `entraOid`. The role is copied to `User.role` on each sign-in, for reporting only. The first admin is assigned in Entra, not in our DB. `GET /me` |
| Scripts | `ScriptRepository`, `RiddleRepository`. Scripts and riddle configs (seed, policy, goal, `opensAfter`), seeded by migration. Read-only at runtime |
| Components | `ComponentFactory`, `GoalEvaluatorFactory`, `ScriptValidator`, the six kinds, engine adapters, `SandboxStore` |
| Sessions | Lifecycle, timer, command pipeline (policy, execute, invariant, goal, `solvedBy`), ruin and reset, progress, per-riddle timing, handouts, struggles (later). Publishes `RiddleSolved`. Calls `StatsService.invalidate()` |
| Hints (later) | `HintRepository`. `HintHandler` is the only event subscriber. `GET /sessions/:sid/hints` |
| Stats (later) | `StatsReadRepository`, `StatsCache` port, `StatsService.invalidate()`. Admin statistics. Only Redis user |
| SkillSwapper (later) | `SkillSwapperPort` and `SkillSwapperAdapter`, read-only client of the other team's API; they set the contract. `GET /sessions/:sid/helpers`. Stores nothing |
| Coach (later) | Clippy board: next small step, never a solution. Reads through Sessions repositories |

### API Routes

Roles: `player`, `admin`. Admin has every player right.

| Path | Role | Owner check | Demo or later |
| --- | --- | --- | --- |
| `GET /me` | any signed-in | – | Demo. Returns user, role, `activeSessionId` |
| `POST /sessions` | player | – | Demo |
| `GET /sessions/:sid` | player | owner | Demo |
| `POST /sessions/:sid/riddles/:slug/commands` | player | owner | Demo |
| `GET /sessions/:sid/riddles/:slug/handouts/:name` | player | owner | Demo |
| `POST /sessions/:sid/reset` | player | owner | Demo |
| `GET /sessions/:sid/hints` | player | owner | Later |
| `POST /sessions/:sid/struggles` | player | owner | Later |
| `POST /sessions/:sid/coach` | player | owner | Later (Clippy) |
| `GET /sessions/:sid/helpers` | player | owner | Later (SkillSwapper) |
| `GET /admin/stats` | admin | – | Later |
| `GET /api/docs` | none | – | Only when `SWAGGER_ENABLED=true` (true in dev, false in production) |

- Errors: `400` body fails DTO validation (not the `rejected` outcome); `401` no or invalid token; `403` wrong role; `404` session not found or not the owner, unknown slug, unknown handout; `409` session not active, or riddle not open (for commands). `expired` stays a 200 outcome. An invalid Script fails boot, so it never happens at runtime.

## Data Model

- Postgres holds system data and riddle configs.
- Live sandboxes (SQLite tables, filesystem, git repository) are not stored in Postgres. Only their seed is, inside `Riddle.config`.

PK = primary key, FK = foreign key, UK = unique key.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontSize": "18px", "fontFamily": "Arial, Helvetica, sans-serif", "primaryColor": "#e0e7ff", "primaryBorderColor": "#1e3a8a", "primaryTextColor": "#0f172a", "lineColor": "#334155", "tertiaryColor": "#f8fafc"}}}%%
erDiagram
  User ||--o{ Session : plays
  Script ||--|{ Riddle : contains
  Script ||--o{ Session : runs
  Session ||--|{ SessionProgress : tracks
  Riddle ||--o{ SessionProgress : "per session"
  Session ||--o{ CommandRecord : logs
  Riddle ||--o{ CommandRecord : receives
  Session ||--o{ Struggle : records
  Riddle ||--o{ Struggle : "stuck on"
  Session ||--o{ Hint : earns
  Riddle ||--o{ Hint : grants

  User {
    uuid id PK
    string entraOid UK "upsert key on first request"
    string displayName
    string role "player | admin, copied from Entra roles claim"
    timestamp createdAt
  }
  Script {
    uuid id PK
    string slug "UK with version"
    string title
    int durationSec
    string onRuin "resetSession | resetRiddle"
    int version
    string completeOn "slug: solving it completes the session"
  }
  Riddle {
    uuid id PK
    uuid scriptId FK
    string slug "unique within script"
    int order
    string kind "factory key"
    string subject "skill: sql hashing auth git rsa tls"
    jsonb config "seed, policy, goal, handout names, hint. Never sent to client"
    string opensAfter "nullable: slug whose solve opens this one; null = open at start"
  }
  Session {
    uuid id PK
    uuid userId FK
    uuid scriptId FK
    string status "active | completed | ruined | expired"
    int runNumber
    timestamp startedAt
    timestamp deadlineAt "countdown hits zero, set at start"
    timestamp finishedAt "null while active"
  }
  SessionProgress {
    uuid sessionId PK, FK
    uuid riddleId PK, FK
    int runNumber PK
    string status "locked | open | solved"
    int restoreCount "default 0; incremented on each resetRiddle restore; 0 again on session reset"
    timestamp openedAt "null while locked"
    timestamp solvedAt
    jsonb result "solve output, re-readable after reload"
  }
  CommandRecord {
    uuid id PK
    uuid sessionId FK
    uuid riddleId FK
    int runNumber
    int restoreCount
    jsonb input "string or named fields"
    string outcome
    timestamp at
  }
  Struggle {
    uuid id PK
    uuid sessionId FK
    uuid riddleId FK
    string subject
    timestamp recordedAt
  }
  Hint {
    uuid id PK
    uuid sessionId FK
    uuid riddleId FK
    int runNumber "unique with sessionId, riddleId"
    string content "config.hint text, copied when earned"
    timestamp earnedAt
  }
```

### Data Rules

- A Riddle is one configured step of a Script. Its `kind` is the factory key for the component, and its `config` makes that component into this specific riddle.
- Unlock order is data: on a solve, the server opens every Riddle whose `opensAfter` is the solved riddle. Sessions never hard-codes order.
- Cross-riddle completion is data: a riddle whose goal is `solvedBy` is solved when the named riddle emits the named signal.
- What a ruin does is data: `Script.onRuin`. `resetSession` ruins the session; `resetRiddle` restores that riddle's sandbox, increments its `restoreCount`, and leaves it open. The ruin is recorded only as a CommandRecord with outcome `ruined`.
- `runNumber` starts at 1 and increments only on session reset. A wrong answer is not a new run; it is a CommandRecord with outcome `rejected` (see Outcomes).
- `Hint` belongs to the later Hint Platform. Maximum one hint per riddle per run. Hints are never deleted.
- Solve time = `solvedAt` − `openedAt` (from `SessionProgress`), per run.
- Tries and rejected commands per riddle are counted from `CommandRecord` per session, riddle, and runNumber.
- `subject` is the skill the riddle tests.
- Nothing from SkillSwapper is stored.
- A Script is immutable once a session uses it. A change is a new Script row with the same `slug` and a higher `version`; sessions keep the `scriptId` they started with, so their replay stays valid. `POST /sessions {scriptSlug}` starts the highest version.

## Riddle Config

`Riddle.config` turns a generic component into a specific riddle. It is seeded by migration and never sent to the client, except handout files through the handouts endpoint.

| Field | Meaning |
| --- | --- |
| `seed` | Starting sandbox: tables and rows, files and commits, or the expected values for an answer check |
| `policy` | `allow` and `ruin` patterns, matched in order (`ruin` first). Anything that matches neither is rejected. Optional `invariant`. Answer kinds default to allow all. Patterns are matched against the parsed input, not raw text (see Command Pipeline step 2) |
| `goal` | `{type, ...}`: what solves the riddle. Interpreted by a goal evaluator |
| `handouts` | Names of files stored in the backend repo at `seeds/<scriptSlug>/v<version>/handouts/`, produced offline by the seed builder and committed. Served only to the session owner while the riddle is open or solved, not while locked |
| `hint` | `{ text }`: note earned on solve; the text is copied into the Hint row (later Hint Platform) |

### Goal Types

| Type | Solved when | Demo |
| --- | --- | --- |
| `emits` | This riddle's own command emits the named signal (`match`, `decrypted`) | Yes |
| `solvedBy` | Another riddle in the same Script emits the named signal | Yes |
| `queryReturns` | The player's SQL result contains the configured value | Later |
| `stateMatches` | A check on the sandbox holds, for example `treeEquals` (git tree at a ref) or `fileExists` | Later |
| `answerEquals` | Submitted text equals the configured value (for example a found file path) | Later |

### Invariant Types

| Type | Holds when |
| --- | --- |
| `historyUnchanged` | Git commits equal the seed commits |
| `schemaUnchanged` | SQL tables and rows equal the seed |

### One Component, Three Riddles

The escape room uses only the first config. The others show that the same `terminal` component serves different riddles with no code change beyond goal types.

```jsonc
// escape room: find the leaked key in history (read-only)
{ "seed":   { "fs": { "/repo/README.md": "..." }, "git": ["c1: add private key", "c2: Security fix: Removed private key from repository."] },
  "policy": { "allow": ["git log*", "git show*", "git status", "git diff*", "ls*", "cat*"],
              "ruin":  ["git commit*", "git reset*", "git rebase*", "git checkout*", "git branch -D*", "rm*"],
              "invariant": { "type": "historyUnchanged" } },
  "goal":   { "type": "solvedBy", "riddle": "rsa-decryptor", "signal": "keyMatched" } }

// later: find a file in a folder tree
{ "seed":   { "fs": { "/home/a/b/c/secret.txt": "..." } },
  "policy": { "allow": ["cd*", "ls*", "find*", "grep*", "cat*"], "ruin": ["rm*"] },
  "goal":   { "type": "answerEquals", "value": "/home/a/b/c/secret.txt" } }

// later: fix a broken history with rebase
{ "seed":   { "git": ["c1", "c2: bad", "c3", "c4"] },
  "policy": { "allow": ["git *", "ls*", "cat*"], "ruin": ["git push --force*", "rm -rf*"] },
  "goal":   { "type": "stateMatches", "check": "treeEquals", "ref": "HEAD", "commits": ["c1", "c3", "c4"] } }
```

## Smart Component Contract (Class Diagram)

One contract for every kind. Kinds for the demo: `sql`, `terminal`, `cracker:hash`, `cracker:rsa`, `cracker:tls`, `lock`.

```mermaid
classDiagram
  direction TB
  class SmartComponent~S~ {
    <<interface>>
    +kind
    +seedSchema
    +inputSchema
    +signals string[]
    +parseInput(raw) Input
    +build(seed) S
    +classify(state, input, policy) Verdict
    +execute(state, input) ExecuteResult
    +checkInvariant(state, invariant) boolean
    +inspect(state, check) boolean
  }
  class Verdict {
    <<enumeration>>
    allow
    reject(reason)
    ruin(reason)
  }
  class ExecuteResult {
    +output
    +signals string[]
  }
  class ComponentFactory {
    <<singleton>>
    +register(component)
    +create(kind) SmartComponent
  }
  class GoalEvaluator {
    <<interface>>
    +type
    +isMet(goal, ctx) boolean
  }
  class GoalEvaluatorFactory {
    <<singleton>>
    +create(type) GoalEvaluator
  }
  class SandboxStore {
    <<singleton>>
    +getOrBuild(sessionId, slug, runNumber, restoreCount)
    +restore(sessionId, slug, runNumber, restoreCount)
    +discardSession(sessionId)
    +lock(sessionId)
  }
  class ScriptValidator {
    <<singleton>>
    +validate(script)
  }
  class SqlComponent {
    +kind = sql
    +engine = SqlEngine port
    +signals = none
  }
  class TerminalComponent {
    +kind = terminal
    +engine = FsGitEngine port
    +shell = ls cd cat find grep git
  }
  class AnswerComponent {
    <<abstract>>
    +build(seed) expected values
    +classify = allow
  }
  class HashCrackerComponent {
    +kind = cracker:hash
    +signals = match
  }
  class RsaDecryptorComponent {
    +kind = cracker:rsa
    +signals = keyMatched, decrypted
  }
  class TlsDecryptorComponent {
    +kind = cracker:tls
    +signals = decrypted
  }
  class LockComponent {
    +kind = lock
    +signals = match
  }
  class EmitsGoal
  class SolvedByGoal
  class SessionsService {
    +start(scriptSlug)
    +command(sessionId, slug, input)
    +reset(sessionId)
    +recordStruggle(sessionId, slug)
  }
  SmartComponent <|.. SqlComponent
  SmartComponent <|.. TerminalComponent
  SmartComponent <|.. AnswerComponent
  AnswerComponent <|-- HashCrackerComponent
  AnswerComponent <|-- RsaDecryptorComponent
  AnswerComponent <|-- TlsDecryptorComponent
  AnswerComponent <|-- LockComponent
  GoalEvaluator <|.. EmitsGoal
  GoalEvaluator <|.. SolvedByGoal
  SmartComponent ..> ExecuteResult
  SmartComponent ..> Verdict
  ComponentFactory --> SmartComponent : creates by kind
  GoalEvaluatorFactory --> GoalEvaluator : creates by type
  SessionsService --> ComponentFactory
  SessionsService --> GoalEvaluatorFactory
  SessionsService --> SandboxStore : discard on ruin and reset
  SandboxStore ..> SmartComponent : build(seed)
  ScriptValidator ..> ComponentFactory : schemas, signals
```

### Command Pipeline

Sessions runs the same pipeline for every kind. No step knows which riddle it is running.

| Step | Rule |
| --- | --- |
| 1. Guard | Lock the session: one command per session at a time (per-session mutex in SandboxStore). The transaction opens here with `SELECT … FOR UPDATE` on the Session row. Owner, session active, riddle open, `now < deadlineAt`. Not found or not the owner, or unknown slug → 404; session not active or riddle not open → 409. Past the deadline: `expired`, command not run |
| 2. Parse | `component.parseInput(raw)`. Invalid shape → `rejected`. `terminal`: one command split into argv; `;`, `&&`, `\|\|`, `\|`, `>`, `<`, backticks and `$(` are rejected. `sql`: parsed into statements; more than one statement is rejected; policy matches the statement type |
| 3. Policy | `component.classify(state, input, config.policy)`. A policy `reject` → `rejected`, no change. `ruin` → ruin path, command not run |
| 4. Execute | `component.execute(state, input)` on the sandbox; returns output and signals |
| 5. Invariant | If `config.policy.invariant` no longer holds, take the ruin path. The discard removes the effect |
| 6. Goal | `GoalEvaluatorFactory.create(goal.type).isMet(goal, {state, input, signals})`. Answer kind with goal not met → `rejected` |
| 7. solvedBy | Every open riddle whose goal is `solvedBy` this slug with an emitted signal is solved too. Runs even when this riddle's outcome is `rejected` |
| 8. Commit | The transaction from step 1 commits: progress updates (`solvedAt`, `openedAt` via `opensAfter`, `result`), session writes, CommandRecord. Session writes: `completeOn` riddle solved → status `completed` + `finishedAt`; `resetSession` ruin → status `ruined` + `finishedAt`; `resetRiddle` ruin → `restoreCount`++. After commit: sandbox discard or restore, publish `RiddleSolved` per solved riddle, stats invalidate. If the transaction fails, discard that riddle's sandbox (it rebuilds by replay) |
| 9. Respond | Outcome, output, `riddle`, `opened`, `alsoSolved`, `session` |

#### Outcomes

| Outcome | Meaning |
| --- | --- |
| `ok` | Command ran, this riddle not solved (`sql` and `terminal`) |
| `rejected` | Refused at Parse or Policy (no sandbox change), or an answer kind (`cracker:*`, `lock`) whose goal is not met |
| `solved` | This riddle's goal met |
| `ruined` | Ruin path taken |
| `expired` | Deadline passed, command not run |

### Script Validation

- At boot, `ScriptValidator` runs the structural checks below (schemas, references, cycles). A Script that fails does not load.
- Checks:
  - every `kind` is registered;
  - `config.seed` matches the kind's `seedSchema`;
  - policy and invariant types are known;
  - goal `type` is registered;
  - `opensAfter` and `solvedBy.riddle` name slugs in the same Script;
  - no unlock cycles;
  - every riddle is reachable from a start riddle;
  - `solvedBy.signal` and `emits.signal` are in the target kind's declared `signals`;
  - `completeOn` names a riddle;
  - a `solvedBy` dependent opens no later than its target;
  - every named handout file exists;
  - for `lock`, the seed fields exist and match the goal.
- Linked answers: values shared between riddles are generated from one source file per Script by a seed builder, not typed twice. The seed builder runs offline and deterministically, and commits both the seed JSON and the handout files to the backend repo. Migrations only insert the committed seed data.
- Winning path: in CI only, the validator also runs the Script's winning path (the seed builder's `solution` list of inputs per riddle) against fresh sandboxes and requires the session to end `completed`. `solution` is stored with the seed builder source only, never in `Riddle.config` and never in the client.

### Component Kinds

- **`sql`:** builds an in-memory SQLite from `seed.tables`. Read-only connection unless the policy allows writes; the read-only connection stays as a second guard behind the policy. Output: `{columns, rows}`.
- **`terminal`:** builds a memfs filesystem and an isomorphic-git repository from `seed.fs` and `seed.git`. Runs one shell line per command. Output: text.
- **Answer kinds** (`cracker:hash`, `cracker:rsa`, `cracker:tls`, `lock`): stateless sandbox holding the expected values from the seed. They compare or compute with the crypto engine and never reverse a hash. Policy defaults to allow, so they never ruin. Output: a result message or computed value (for example the decrypted PMS).
- **`lock` input:** the input fields are the field names in the riddle's seed (dana-login: `username`, `password`; door: its digits field).
- **Limits:** every kind runs under the engine limits (see Sandbox Engines). Over a limit → `rejected` with a message, not ruin.

## Session Lifecycle

Color key: green = active, blue = completed, red = ruined, amber = expired.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontSize": "18px", "fontFamily": "Arial, Helvetica, sans-serif", "lineColor": "#334155", "primaryTextColor": "#0f172a"}, "flowchart": {"nodeSpacing": 35, "rankSpacing": 55, "curve": "basis"}}}%%
flowchart TB
  S0(["POST /sessions"])
  A["active"]
  C["completed"]
  R["ruined"]
  E["expired"]
  S0 --> A
  A -- "completeOn riddle solved" --> C
  A -- "ruin, onRuin = resetSession" --> R
  A -- "request after deadlineAt" --> E
  R -- "reset" --> A
  E -- "reset" --> A
  C -- "reset" --> A
  N["ruin, onRuin = resetRiddle:<br/>riddle restored, session stays active"]
  A -.- N
  classDef ui fill:#1d4ed8,stroke:#1e3a8a,color:#ffffff,stroke-width:2px
  classDef store fill:#15803d,stroke:#14532d,color:#ffffff,stroke-width:2px
  classDef bad fill:#b91c1c,stroke:#7f1d1d,color:#ffffff,stroke-width:2px
  classDef warn fill:#d97706,stroke:#78350f,color:#ffffff,stroke-width:2px
  class S0,A store
  class C ui
  class R bad
  class E warn
```

### Lifecycle Steps

- **Start:** `POST /sessions {scriptSlug}`. One active session per user per script: a partial unique index on (`userId`, `scriptId`) where status = `active`. The server first applies lazy expiry; if an active session remains, it returns that one (200) instead of creating a new one. `deadlineAt` = now + script duration. Riddles with `opensAfter` null open (`openedAt` stamped), the rest are locked. Sandboxes are built on first command.
- **Read:** `GET /sessions/:sid`: session status, `deadlineAt`, `remainingMs`, and every riddle's status by slug, with `result` for solved riddles. Each riddle also returns `kind` and `inputFields` (names and types only). For a `lock` riddle they come from the seed; for every other kind, from the kind's `inputSchema`. `GET /me` returns `activeSessionId`, so a new tab can resume.
- **Timer:** server-owned. Every session request checks `deadlineAt`. Past it: session expired, command not run. No scheduler. A session is expired when `now ≥ deadlineAt`, whether or not a request marked it. Reads (`GET /sessions/:sid`, stats) treat an `active` session past `deadlineAt` as expired; the next request writes `expired` and `finishedAt = deadlineAt`.
- **Command:** `POST /sessions/:sid/riddles/:slug/commands`. Runs the Command Pipeline.
  - Response: `outcome` (`ok`, `solved`, `rejected`, `ruined`, `expired`; see Outcomes), `output`, `riddle {slug, status, openedAt, solvedAt}`, `opened [slugs]`, `alsoSolved [slugs]`, `session {status, deadlineAt, remainingMs}`.
  - `opened`: riddles opened by this command. `alsoSolved`: other riddles solved in this command via `solvedBy`.
  - Every command that reaches Parse writes a CommandRecord, so it counts as a try. A command refused before Parse (400, 404, 409, `expired`) writes none.
- **Solve:** one transaction marks the riddle solved (`solvedAt`, `result`), solves its `solvedBy` dependents, opens the next riddle(s) (`openedAt`), and records the command. After commit, publish `RiddleSolved` for each solved riddle.
- **Ruin:** request/response, not an event. By `Script.onRuin`:
  - `resetSession`: commit (status `ruined`, `finishedAt`, CommandRecord `ruined`), then `SandboxStore.discardSession`, then stats invalidate, then respond.
  - `resetRiddle`: commit (`restoreCount`++, CommandRecord `ruined`), then discard the old sandbox key, then respond. The riddle stays open; the next `getOrBuild` builds from the seed under the new key.
  - HTTP 200 with outcome `ruined`, not an error.
- **Reset:** `POST /sessions/:sid/reset`. Allowed from `ruined`, `expired` or `completed`. From `active`: 409 with the current state, which also makes a double click harmless. Takes the same per-session lock and Session `FOR UPDATE`. Returns progress to the start state, starts new SessionProgress rows for the new runNumber (earlier runs keep their timings), increments runNumber, sets `startedAt` = now, recomputes `deadlineAt` and clears `finishedAt`. After commit, discards all sandboxes. Earned hints are kept.
- **Complete:** the riddle named by `Script.completeOn` solved → session completed.
- **Stats:** Sessions calls `StatsService.invalidate()` after commit on every session status change: start, reset, complete, ruin, expire write. Best-effort: errors are logged and never roll back. Until Admin Statistics ships it is a no-op, so the demo does not depend on a Later Feature.

### Per-Riddle Timing

- `openedAt` is stamped by the server: riddles with `opensAfter` null at start, and the next riddle(s) in the unlocking solve transaction.
- No timer endpoints. No frontend timing calls. `deadlineAt` stays the only countdown.
- Each run keeps its own timings.
- Use: per-skill solve time and tries select which SkillSwapper skill teachers to request. Admin Statistics may aggregate per-riddle durations.

## Data Flow

### Sequence 1: SQL SELECT

```mermaid
sequenceDiagram
  autonumber
  participant UI as React SQL window
  participant Auth as Guards
  participant Svc as SessionsService
  participant Repo as Repositories
  participant F as ComponentFactory
  participant Store as SandboxStore
  participant SQL as SqlComponent

  UI->>Auth: POST /sessions/:sid/riddles/idan-db/commands {input: SELECT ...}
  Auth->>Auth: Entra token (JWKS), role player
  Auth->>Svc: command(sid, idan-db, input)
  Svc->>Repo: begin tx + lock Session (FOR UPDATE)
  Svc->>Repo: SessionRepository + ProgressRepository load
  Svc->>Svc: owner, active, open, now < deadlineAt
  Svc->>F: create(sql)
  Svc->>Store: getOrBuild(sid, idan-db, run, restores)
  Store-->>Svc: SQLite built from seed
  Svc->>SQL: classify(policy) → allow
  Svc->>SQL: execute
  SQL-->>Svc: {columns, rows}, no signals
  Svc->>SQL: checkInvariant(schemaUnchanged) → true
  Svc->>Svc: goal solvedBy hash-cracker → not met
  Svc->>Repo: CommandRecordRepository insert (ok), commit
  Svc-->>UI: 200 {outcome: ok, output, riddle, opened: [], alsoSolved: [], session}
  UI->>UI: render result grid
```

### Sequence 2: Ruined Terminal Command

```mermaid
sequenceDiagram
  autonumber
  participant UI as React xterm.js
  participant Auth as Guards
  participant Svc as SessionsService
  participant Repo as Repositories (Unit of Work)
  participant Store as SandboxStore
  participant Git as TerminalComponent
  participant Stats as StatsService

  UI->>Auth: POST /sessions/:sid/riddles/nethanel-git/commands {input: git commit ...}
  Auth->>Svc: token + role player OK
  Svc->>Repo: begin tx + lock Session
  Svc->>Repo: load + checks (as Sequence 1)
  Svc->>Store: getOrBuild(sid, nethanel-git, run, restores)
  Svc->>Git: classify(policy)
  Git-->>Svc: ruin (matches git commit*)
  Note over Svc,Git: Command is not executed
  Svc->>Repo: commit: session ruined (resetSession), finishedAt, CommandRecord (ruined)
  Svc->>Store: after commit: discardSession(sid)
  Svc->>Stats: invalidate() (best-effort)
  Svc-->>UI: 200 {outcome: ruined, output: history changed: session ruined, reset to try again, session: ruined}
  UI->>UI: term.write(output), ruined state
  Note over UI,Svc: Player may call POST /sessions/:sid/reset
```

- Variant: a command that passes the policy but fails `checkInvariant` takes the same path from the commit step. The discard removes its effect.

### Sequence 3: Hash Solved, SQL Solved, Hint Handler

```mermaid
sequenceDiagram
  autonumber
  participant UI as React
  participant Auth as Guards
  participant Svc as SessionsService
  participant Cr as HashCrackerComponent
  participant Repo as Repositories (Unit of Work)
  participant Bus as EventBus port
  participant H as HintHandler

  UI->>Auth: POST /sessions/:sid/riddles/hash-cracker/commands {input: {hash}}
  Auth->>Svc: token + role player OK
  Svc->>Repo: begin tx + lock Session
  Svc->>Repo: load + checks (as Sequence 1)
  Svc->>Cr: parseInput, classify → allow
  Svc->>Cr: execute: compare to seed sha256
  Cr-->>Svc: output: password message, signals [match]
  Svc->>Svc: goal emits match → hash-cracker solved
  Svc->>Svc: idan-db goal solvedBy hash-cracker match → idan-db solved
  Svc->>Repo: commit: both solved + solvedAt, dana-login opened + openedAt, CommandRecord (solved)
  Svc->>Bus: after commit: RiddleSolved for hash-cracker and idan-db
  Svc-->>UI: 200 {outcome: solved, output, alsoSolved: [idan-db], opened: [dana-login], session}
  Note over UI,Svc: Request does not wait for the hint
  Bus-)H: RiddleSolved
  H->>Repo: RiddleRepository read config.hint
  alt no hint configured
    H->>H: stop
  else hint configured
    H->>Repo: HintRepository upsert on (sessionId, riddleId, runNumber)
  end
```

- One event and one handler serve every riddle.
- Riddles without a hint in config are skipped.
- Upsert makes a repeated event harmless.
- On startup: re-publish for solved riddles with hint config and no `Hint` row.
- The note may appear after the solve response.

## Later Features

Specified, not built. Each is tied to exactly one mechanism. The demo does not depend on any of them.

| Feature | Mechanism | Behavior |
| --- | --- | --- |
| Hint Platform | **Event bus** (the one event-driven feature) | On riddle solve, `RiddleSolved` is published; `HintHandler` saves the configured hint (max one per riddle per run). Read: `GET /sessions/:sid/hints` returns only the hints for the session's current runNumber. Hints are never deleted |
| Admin Statistics | **Redis** (the one cached feature) | `GET /admin/stats`. Reads `stats:v1` through `StatsCache`; on miss, aggregates through `StatsReadRepository` and stores with a TTL (`STATS_CACHE_TTL_SECONDS`, 60). Invalidated through `StatsService.invalidate()`, best-effort after commit, on every session status change, including when a request writes `expired`. Errors are logged and never roll back. Redis down → serve from Postgres; staleness after Redis recovers is bounded by the TTL. Aggregates count `active` past `deadlineAt` as expired, so the TTL plus that rule covers an unwritten expiry |
| Clippy Board | Request/response | Coach API (`POST /sessions/:sid/coach`): given session, hints, and struggle subject, returns the next small step. Never a solution. Reads struggles through `StruggleRepository` |
| SkillSwapper | Request/response, **Adapter** | `SkillSwapperAdapter` implements `SkillSwapperPort` over the other team's API (their contract). `GET /sessions/:sid/helpers`: server picks skills from slowest riddles and struggles (subject → skill from a static map in the adapter), calls their API synchronously (`SKILLSWAPPER_TIMEOUT_MS`, 5000), returns people. On failure: log and store nothing; the next struggle retries. Nothing stored |

**Admin statistics aggregates:** sessions by status, completion rate, average completion time (per run, from SessionProgress: the run's first `openedAt` to the `completeOn` riddle's `solvedAt` for that runNumber; not `Session.startedAt`, because reset reuses the Session row), ruins per component kind, struggles per subject, and possibly per-riddle solve times.

**Request/response only:** ruin and reset, `solvedBy` completion, stats cache invalidation, session completion, struggle recording, SkillSwapper.

### Event Bus

- `EventBus` port with an in-process `@nestjs/event-emitter` adapter.
- One event: `RiddleSolved { sessionId, riddleId, runNumber, solvedAt }`.
- One publisher: SessionsService, after the solve transaction commits.
- One subscriber: `HintHandler`, an async listener (`{async: true}`), so the request does not wait. Errors are caught and logged; startup recovery is the only retry.
- `HintHandler` reads `Riddle.config.hint` (`{ text }`); none → stop; otherwise upserts one `Hint` per session, riddle, and runNumber, with the text copied in.
- Startup recovery: re-publish for solved progress rows with hint config and no `Hint` row.
- Read path: `GET /sessions/:sid/hints` after a solved outcome; only the current runNumber's hints; eventually consistent.

### Struggles

- Later Feature, owned by Sessions.
- `POST /sessions/:sid/struggles {slug}`: plain record of the "I'm stuck" action. The riddle must be open, otherwise 409.
- `Struggle(id, sessionId, riddleId, subject, recordedAt)`; subject set by the server from the riddle.
- No event. Read by Clippy and the SkillSwapper helper lookup.

# Part 2: Escape Room (Demo)

The escape room is one Script (`escape-room`, `onRuin = resetSession`, `completeOn = door`) plus one skin. Everything story-specific lives here, as data and skin. Part 1 does not change for it.

## Story in Brief

- Two locked rooms. The player must solve every puzzle and get out to join the TDP program.
- Room 1: Dana leaves; Idan's computer (SQL) and Dana's computer (login) hold the first clues.
- Room 2: Nathaniel's computer holds an encrypted Cibus payment capture and a git terminal.
- The final door opens with Nathaniel's credit card digits. Dana waits outside: "Welcome to the team."
- Correction: `story-script.txt` lists `users` and `passwords` tables. That is wrong; `employees` and `logs` are correct.

## Puzzle Flow

Color key: blue = UI screen, dark gray = server call, amber = hint earned (later), green = start and win. Labeled edges carry data the player copies.

```mermaid
%%{init: {"theme": "base", "themeVariables": {"fontSize": "18px", "fontFamily": "Arial, Helvetica, sans-serif", "lineColor": "#334155", "primaryTextColor": "#0f172a"}, "flowchart": {"nodeSpacing": 35, "rankSpacing": 55, "curve": "basis"}}}%%
flowchart TB
  START(["START GAME"])
  NEWS["POST /sessions"]
  START --> NEWS --> R1HUB

  subgraph ROOM1["ROOM 1"]
    R1HUB["Room 1 hub"]
    SQLC["SQL console"]
    SQLCALL["POST commands · idan-db<br/>rows"]
    HASH["Hash-Cracker"]
    HASHCALL["POST commands · hash-cracker<br/>password message<br/>alsoSolved: idan-db"]
    HINT1[/"Hint (later): password note"/]
    LOGIN["Dana's computer"]
    LOGINCALL["POST commands · dana-login<br/>opened: Room 2 riddles"]
    R1HUB --> SQLC & HASH & LOGIN
    SQLC --> SQLCALL
    HASH --> HASHCALL
    HASHCALL -.-> HINT1
    LOGIN --> LOGINCALL
    SQLCALL -- "hash" --> HASH
    SQLCALL -- "username" --> LOGIN
    HASHCALL -- "password" --> LOGIN
  end

  OPEN["Local: open room icon"]
  LOGINCALL --> OPEN --> R2HUB

  subgraph ROOM2["ROOM 2"]
    R2HUB["Room 2 hub"]
    PCAP["Encrypted pcap preview"]
    PCAPCALL["GET handouts · rsa-decryptor<br/>Cibus_payment_try.pcap"]
    GIT["Git terminal"]
    GITCALL["POST commands · nethanel-git<br/>git log · git show"]
    RSA["RSA decryptor"]
    RSACALL["POST commands · rsa-decryptor<br/>keyMatched: alsoSolved nethanel-git<br/>decrypted: PMS"]
    TLS["TLS decryptor"]
    TLSCALL["POST commands · tls-decryptor<br/>solved, decrypted records"]
    HINT2[/"Hint (later): card-number note"/]
    DPCAP["Decrypted pcap view<br/>from TLS output"]
    LOCK["Final lock"]
    LOCKCALL["POST commands · door<br/>session completed"]
    R2HUB --> PCAP & GIT & RSA & TLS & LOCK
    PCAP --> PCAPCALL
    GIT --> GITCALL
    RSA --> RSACALL
    TLS --> TLSCALL
    TLSCALL --> DPCAP
    TLSCALL -.-> HINT2
    LOCK --> LOCKCALL
    GITCALL -- "private key" --> RSA
    PCAPCALL -- "encrypted PMS + N" --> RSA
    RSACALL -- "decrypted PMS" --> TLS
    PCAPCALL -- "client + server random" --> TLS
    DPCAP -- "card digits" --> LOCK
  end

  WIN(["WIN"])
  LOCKCALL --> WIN

  NOTE["RUINED · EXPIRED · STUCK (later)<br/>reachable from any screen<br/>(see Server-Driven States)"]

  classDef ui fill:#1d4ed8,stroke:#1e3a8a,color:#ffffff,stroke-width:2px
  classDef server fill:#334155,stroke:#0f172a,color:#ffffff,stroke-width:2px
  classDef hint fill:#f59e0b,stroke:#78350f,color:#0f172a,stroke-width:2px
  classDef edge fill:#15803d,stroke:#14532d,color:#ffffff,stroke-width:2px
  classDef note fill:#fee2e2,stroke:#b91c1c,color:#7f1d1d,stroke-width:2px,stroke-dasharray:6 4
  class R1HUB,SQLC,HASH,LOGIN,OPEN,R2HUB,PCAP,GIT,RSA,TLS,DPCAP,LOCK ui
  class NEWS,SQLCALL,HASHCALL,LOGINCALL,PCAPCALL,GITCALL,RSACALL,TLSCALL,LOCKCALL server
  class HINT1,HINT2 hint
  class START,WIN edge
  class NOTE note
```

## Puzzle Steps

| # | Room | Screen | Player does | Server call | Outcome | Opens next |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 1 | SQL console | SELECT employees by name → Dana's username; SELECT logs where username = Dana's and type = 'auth' → hash | POST commands (idan-db) | ok, rows (ruined on DROP or write) | – |
| 2 | 1 | Hash-Cracker | Paste hash | POST commands (hash-cracker) | solved, message with Dana's password; `alsoSolved: [idan-db]` | dana-login |
| 3 | 1 | Dana's computer | Username + password, Login | POST commands (dana-login) | solved / rejected | nethanel-git, rsa-decryptor |
| 4 | 2 | Encrypted pcap preview | Download; copy client random, server random, encrypted PMS (CKE), modulus N (certificate) | GET handouts (rsa-decryptor) | – | – |
| 5 | 2 | Git terminal | `git log`; `git show <previous commit>` → private key | POST commands (nethanel-git) | ok (ruined on `git commit/reset/rebase/checkout/branch -D`, `rm`) | – |
| 6 | 2 | RSA decryptor | Private key + encrypted PMS + N, Decrypt | POST commands (rsa-decryptor) | Key match only → `rejected` + `alsoSolved: [nethanel-git]`; all correct → solved, decrypted PMS | tls-decryptor |
| 7 | 2 | TLS decryptor | PMS + client random + server random, Decrypt | POST commands (tls-decryptor) | solved, decrypted App-Data records in output | door |
| 8 | 2 | Decrypted pcap view | Find Nathaniel's card in App-Data records | None (TLS output; `GET /sessions/:sid` after reload) | – | – |
| 9 | 2 | Final lock | Enter card digits | POST commands (door) | solved → session completed | WIN |

- After step 3, the "open room" icon is a local step that moves to the Room 2 hub.
- With the later Hint Platform, the hash cracker and TLS decryptor also earn inventory notes. The story says the card note is earned "on copy"; copying is local and cannot be a server event, so the note is earned on TLS solve.

## Gating and Timing

| Riddle | Opens (`openedAt`) | Solved (`solvedAt`) |
| --- | --- | --- |
| idan-db | Session start | `solvedBy` hash-cracker `match` |
| hash-cracker | Session start | Own signal `match` |
| dana-login | hash-cracker solve | Own signal `match` |
| nethanel-git | dana-login solve | `solvedBy` rsa-decryptor `keyMatched` |
| rsa-decryptor | dana-login solve | Own signal `decrypted` |
| tls-decryptor | rsa-decryptor solve | Own signal `decrypted` |
| door (final lock) | tls-decryptor solve | Own signal `match` |

- idan-db and nethanel-git follow the same rule: each is solved by the next riddle's correct input, expressed as a `solvedBy` goal.
- All gating is stored as `opensAfter` and `goal` in the Script's Riddle rows.

## Script Riddles

| # | Slug | Kind | Subject | opensAfter | Seed | Policy | Goal |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | idan-db | sql | sql | null | `employees`, `logs`; Dana's auth log holds a sha256 hex built with `node:crypto` at seed time | allow single `SELECT` / `WITH … SELECT`; ruin `DROP DELETE UPDATE INSERT ALTER ATTACH`; invariant `schemaUnchanged` | `solvedBy` hash-cracker `match` |
| 2 | hash-cracker | cracker:hash | hashing | null | Dana's sha256, password message | allow all | `emits match` |
| 3 | dana-login | lock | auth | hash-cracker | username, password | allow all | `emits match` |
| 4 | nethanel-git | terminal | git | dana-login | memfs repo, commit 1 adds the private key, commit 2 removes it: "Security fix: Removed private key from repository." | allow `git log/show/status/diff`, `ls`, `cat`; ruin `git commit/reset/rebase/checkout/branch -D`, `rm`; invariant `historyUnchanged` | `solvedBy` rsa-decryptor `keyMatched` |
| 5 | rsa-decryptor | cracker:rsa | rsa | dana-login | private key, N, encrypted PMS; handout `Cibus_payment_try.pcap` | allow all | `emits decrypted` |
| 6 | tls-decryptor | cracker:tls | tls | rsa-decryptor | PMS, client random, server random, encrypted App-Data records | allow all | `emits decrypted` |
| 7 | door | lock | tls | tls-decryptor | Nathaniel's card digits | allow all | `emits match` |

- **Room 2:** riddles 4 and 5 open together. Riddle 4 is solved by a matching private key on riddle 5, not by a terminal command.
- **RSA partial answer:** a matching key with a wrong PMS or N emits `keyMatched` only. Step 7 (`solvedBy`) still runs on that signal: nethanel-git is solved, rsa-decryptor stays open, and the response is `rejected` with `alsoSolved: [nethanel-git]` and a message.
- **Lock inputs:** a `lock` riddle's input fields are its seed field names (dana-login: `username`, `password`; door: its digits field).
- **Hints (later):** hash-cracker → note with Dana's password. tls-decryptor → note with the card number.
- **Linked answers:** shared values (Dana's username and password, the logs sha256, the private key in git and in rsa-decryptor, N and encrypted PMS in the pcap handout and rsa seed, PMS and client and server random for TLS, the card digits in the TLS records and door) are generated from one source file per Script by a seed builder, not typed twice. It runs offline and deterministically and commits the seed JSON and handout files to the backend repo; migrations only insert that data. The winning path is checked by `ScriptValidator` in CI (see Script Validation).

## Escape Room Skin (Demo)

The skin is built in the frontend repo for the demo. It is the game's look and owns no rules.

```
src/skins/escape-room/
  manifest.ts          slug → room, picture, position, window
  rooms/Room1.tsx      Idan's computer, Dana's computer, hash-cracker icon
  rooms/Room2.tsx      Nathaniel's computer, pcap file, decryptors, door
  windows/SqlWindow.tsx       command box + result grid
  windows/TerminalWindow.tsx  xterm.js
  windows/AnswerForm.tsx      fields from `GET /sessions/:sid` inputFields
  windows/PcapViewer.tsx      renders handout and TLS output
assets/escape-room/    pictures, backgrounds, icons → Blob Storage
```

```ts
// manifest.ts (shape)
{ slug: 'idan-db',       room: 1, picture: 'idan-computer.png', at: { x: 120, y: 340 }, window: SqlWindow }
{ slug: 'nethanel-git',  room: 2, picture: 'nathaniel-pc.png',  at: { x: 410, y: 300 }, window: TerminalWindow }
{ slug: 'door',          room: 2, picture: 'door.png',          at: { x: 900, y: 200 }, window: AnswerForm }
```

- A picture is dimmed while its riddle is `locked`, active while `open`, and shows a solved state when `solved`, all from server state.
- Room 2 becomes reachable when its riddles appear in `opened`.
- Win screen on `session.status = completed`.

# Appendix

## Environment Configuration

- Backend `.env.example` placeholders: `DATABASE_URL`, `ENTRA_TENANT_ID`, `ENTRA_API_CLIENT_ID` (also the token audience), `REDIS_URL`, `STATS_CACHE_TTL_SECONDS` (60), `SKILLSWAPPER_BASE_URL`, `SKILLSWAPPER_API_KEY`, `SKILLSWAPPER_TIMEOUT_MS` (5000), `PORT`, `CORS_ORIGINS`, `SWAGGER_ENABLED` (true in dev, false in production), `SANDBOX_IDLE_MINUTES` (30), `SANDBOX_COMMAND_TIMEOUT_MS` (2000), `SANDBOX_MAX_ROWS` (500), `SANDBOX_MAX_OUTPUT_BYTES` (65536), `COMMAND_MAX_INPUT_LENGTH` (2000).
- Frontend `.env.example` placeholders: `VITE_API_BASE_URL`, `VITE_ASSETS_BASE_URL`, `VITE_ENTRA_CLIENT_ID`, `VITE_ENTRA_TENANT_ID`, `VITE_ENTRA_API_SCOPE`.
- Local rebuild: `npm run db:reset` (drop, migrate, seed).
- No secrets in git.

## Resolved Conflicts

| Conflict | Decision |
| --- | --- |
| Story script lists `users` and `passwords` tables; binding context says `employees` and `logs` | `employees` and `logs` only |
| The original technologies document said sqlplay supplies the console UI; binding context says thin client | sqlplay is a server-side engine; React draws the SQL window |
| Earlier draft put allowed, ruin, and invariant rules inside component classes | Rules moved to `Riddle.config.policy`; components stay generic so the same kind serves different riddles |
| Earlier draft had crackers solve the previous riddle in code | Expressed as `solvedBy` goals in Script data |
| Earlier draft served the encrypted pcap from Blob Storage | Served by the API as a riddle handout, since it must match the riddle's answers |
| Earlier draft delivered the decrypted pcap only through hints | TLS solve output carries it; hints are an optional extra |

## Open Items

- "Open room" executable and room transitions: skin, not a component.
- Automatic stuck detection (for example after N failures): not in this design. Only the explicit stuck action.
- Full list of admin statistics beyond those named.
- Scale-out beyond one API instance: needs sticky sessions or shared sandbox storage; replay already allows rebuilding, and the per-session lock moves to the database row lock only.
