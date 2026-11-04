# Conversation Summary and Clone Handoff

Updated: 2026-10-27.

## Why This Handoff Exists

The current working folder came from an extracted archive. Work is moving to a properly `git clone`-created copy with the same project structure.
Implementation is paused for that move. This file records decisions and actual progress so work can resume without repeating the design review.

The previous folder's Git commands resolved to an enclosing repository with unrelated changes. In the clone, confirm `git rev-parse --show-toplevel`, `git status`, and the remote before editing. Do not copy the old folder's Git metadata or revert unrelated changes.

## Latest Implementation Request

Implement the Phase 1 foundation according to [DESIGN-auth-phase1.md](DESIGN-auth-phase1.md):

- NestJS setup and local PostgreSQL through Docker Compose.
- TypeORM entities, migrations, and an explicit admin seed.
- Username/password signup and login with JWT authentication.
- Authentication and role guards, plus GET/PATCH `/me`.
- Swagger, README, and a placeholder `.env.example`.
- Focused tests and verification of every Demo 1 requirement.
- Preserve existing deployment infrastructure.

The latest design explicitly permits incremental delivery: the foundation and a real API/database flow come first; remaining authentication endpoints can follow.
The subsequent request was to create this summary before moving folders, not to continue implementation here.

## Design Review History

1. Reviewed the project files, original architecture, authentication proposal, Demo 1 requirements, Dockerfile, Helm, CI/CD, and environment guide.
2. Updated both design documents to separate the existing greeting-service scaffold from the planned NestJS application and to prioritize local development.
3. Reviewed JWT precision, admin races, refresh replay, logout, rate limiting, and future browser storage.
4. At the user's request, simplified the auth design from 726 to 321 lines: removed account lockout, detailed future integration plans, replacement chains, repetitive explanations, and diagrams.
5. At the user's next request, restored two concise sequence diagrams, an ER diagram, and a detailed schema/index definition. Raised login/signup limits to 60 requests/minute/IP per route and aligned the Compose project name with repository metadata.
6. The user then clarified in the design that authentication may be implemented incrementally, before requesting code implementation.

[DESIGN-auth-phase1.md](DESIGN-auth-phase1.md) is authoritative for current authentication decisions. [DESIGN.md](DESIGN.md) retains wider product plans and some older auth wording; do not reintroduce removed lockout or future-integration complexity from it.

## Agreed Technical Decisions

### Stack and Local Setup

- NestJS/TypeScript, PostgreSQL 16, TypeORM 0.3, Swagger, JWT, argon2id, and Jest.
- One local API process and PostgreSQL managed by Compose; no Azure connection required for the demo.
- Compose project name: `projecthon-team5`, matching [package.json](package.json) and [.github/variables/shared_vars.yaml](.github/variables/shared_vars.yaml).
- Planned API container uses Node 22 Alpine; the existing deployment Dockerfile uses corporate Node 20 images and remains unchanged.
- Published ports bind to loopback. Inside Compose, PostgreSQL is `postgres:5432`; host-run development uses the local `.env` address/port.
- Persistent database volume; explicit migrations and seed; `synchronize: false` and `migrationsRun: false`.
- Database configuration comes from `.env` locally, with validated values shared by the app, migration CLI, and seed. Never commit secrets.

### Authentication and Security

- Roles: `Role.PLAYER = 'player'`, `Role.ADMIN = 'admin'`; authorization uses the database role.
- Passwords: argon2id, at least 19 MiB memory, two iterations, parallelism one; 15-128 Unicode code points, without trimming or truncation.
- Signup creates active players only. Reject role/status mass assignment and return explicit DTOs without credential metadata.
- HS256 JWTs contain `sub`, `fid`, `ver`, `iat`, `exp`, `iss`, and `aud`; default access lifetime is 15 minutes.
- Validate signature, algorithm, required claim types, issuer, audience, and expiry. Check active user, matching token version, and valid owned refresh family in the database on protected requests.
- Use integer `token_version` for invalidation, never comparisons between second-resolution JWT timestamps and database timestamps.
- No account lockout or failed-login counters. Basic in-memory throttling: login/signup 60/minute/IP per route, refresh/logout 30, other API routes 100; password changes additionally 5/minute/authenticated user.
- Keep tokens out of logs, URLs, persistent browser storage, and persisted Swagger authorization. Auth responses use `Cache-Control: no-store`.

### Persistence, Rotation, and Admin Protection

- Three tables: `users`, `refresh_families`, and `refresh_tokens`; full schema and indexes are in the auth design.
- A family represents one login and expires seven days after creation. Refresh tokens are random 32-byte credentials; store only SHA-256 hashes.
- Rotation marks the old token used and inserts a successor atomically. A partial unique index allows at most one unused token per family.
- Replay of a used token revokes its family. Commit revocation before returning 401 so exception handling cannot roll it back.
- One user-row lock serializes that user's credential writes; no separate family/token lock hierarchy is needed.
- Concurrent duplicate refreshes revoke the family; clients must not automatically retry refresh after an uncertain response.
- Logout identifies the family using the refresh credential and works without a valid access JWT. Logout-all requires access authentication.
- Role/password changes, disable, soft delete, and logout-all increment the user version and revoke all families. Enable never revives old credentials.
- Admin mutations and seed take a shared transaction-scoped PostgreSQL advisory lock, then caller/target user locks in UUID order. Recheck caller authority after waiting.
- Reject self-role changes, self-disable, self-delete, and any mutation leaving no active admin. Do not use an unlocked count or `COUNT(*) FOR UPDATE`.
- Soft deletion retains the row and reserves username/email. Seed must never silently promote, restore, or reset an existing user.

## Actual Implementation State

Only the initial tooling/configuration slice has been written. The API foundation is **not implemented or verified yet**.

| File | Current state |
| --- | --- |
| [package.json](package.json) | Updated description, build/dev/test/migration/seed/reset scripts, and ts-jest configuration. Runtime dependencies are now declared; many script targets do not exist yet |
| [package-lock.json](package-lock.json) | Installation may have updated it; carry and check it together with the package manifest before resuming |
| [tsconfig.json](tsconfig.json) | Strict CommonJS TypeScript with decorators; source root `src`, output `src/runtime` |
| [tsconfig.build.json](tsconfig.build.json) | Excludes tests, integration tests, dependencies, and generated output |
| [src/config/config.ts](src/config/config.ts) | dotenv loading, shared database/app config, explicit boolean/integer parsing, placeholder rejection, base64 JWT-secret validation |
| [src/config/config.test.ts](src/config/config.test.ts) | Focused tests for defaults, TLS parsing, and invalid settings; not successfully run yet |
| [.gitignore](.gitignore) | Added local env variants, exception for `.env.example`, and generated `src/runtime` exclusion |
| [src/index.js](src/index.js) | Still the original HTTP greeting server and optional Application Insights initialization |
| [src/index.test.js](src/index.test.js) | Still the original greeting tests; current Jest matching selects TypeScript tests instead |

The manifest now includes NestJS 10, Swagger 7, JWT 10, throttler 6, TypeORM, pg, argon2, class-validator/transformer, dotenv, helmet, reflect-metadata, and rxjs alongside existing Application Insights.
At the last inspection, **Jest was still the only declared dev dependency**. TypeScript, ts-node, ts-jest, type packages, Nest testing utilities, Supertest, and nodemon still need installation/confirmation.

Missing implementation includes the Nest bootstrap/modules/controllers, entities/migrations, seed, guards/services, Compose file, README, `.env.example`, integration-test configuration, and reset script. Do not assume the new package scripts are runnable.

### Deployment Compatibility Approach

The existing [Dockerfile](Dockerfile) copies `src` and launches `node src/index.js`.
The selected approach is to emit compiled TypeScript into `src/runtime` and later have the existing launcher load the compiled Nest bootstrap, preserving optional telemetry initialization.
Only the TypeScript output configuration is in place; **the launcher has not been changed**.
Preserve the Dockerfile, Helm chart, CI/CD workflows/variables, and quality configuration unless the user authorizes infrastructure changes.

## Environment and Installation Findings

- macOS host: Node `v24.20.0`, npm `11.19.0`; planned local container runtime is Node 22.
- Docker Compose `v5.5.1` was available. Docker daemon was initially stopped; opening Docker Desktop succeeded, and a later check reported server `29.7.2`.
- No project PostgreSQL container, migrations, or application server was started during implementation.
- The configured npm registry reported `https://registry.npmjs.org/`, but the network redirects requests to `https://jfrog-pkg-proxy.it.att.com/npm/`.
- Following that redirect with curl returned HTTP 200. The original lockfile also contained corporate JFrog artifact URLs.
- npm emitted an existing user-config warning about an unknown `egistry` key. No user npm configuration or credentials were changed.
- The first installation command stalled and was interrupted. Runtime dependencies subsequently appeared in the manifest, but the development-toolchain installation and focused test did not complete successfully.
- A proposed retry against the verified corporate mirror with bounded timeouts was cancelled by the user. Do not report dependency installation as complete.

## Verification Status

Before code implementation, document checks passed for required design content, local links, Markdown fences, embedded Compose YAML, and matching project names. These were document checks, not Mermaid rendering or runtime tests.
Hash comparisons confirmed the earlier design-only edits left other files unchanged at that time.

For the partial code implementation:

- No successful TypeScript build or configuration-test result yet.
- No database schema, seed, authentication, persistence, or concurrency verification yet.
- No Swagger-driven demo flow has been executed.
- Demo 1 compliance is therefore **pending**, not achieved.

## Resume in the Cloned Repository

1. Confirm the clone's root, branch, remote, instructions, and existing edits. Compare files before carrying work across; do not overwrite newer clone changes.
2. Carry the updated design documents, this summary, package manifest/lockfile, TypeScript configs, config source/tests, and relevant ignore rules. Do not carry `node_modules`, generated output, credentials, or Git metadata.
3. Complete dependency installation with the approved registry/network setup. Install the missing development tooling, confirm manifest/lockfile consistency, and run the focused configuration test first.
4. Implement the TypeORM entities, migration, local Compose setup, and safe repeatable admin seed. Test against real local PostgreSQL.
5. Implement Nest bootstrap, signup/login, JWT/role guards, profile read/update, health, and Swagger. Keep the requested foundation scope explicit; distinguish implemented endpoints from remaining design scope.
6. Add focused unit/integration tests, a complete README and `.env.example`, and the documented guarded reset workflow. Verify the existing deployment entrypoint remains compatible.
7. Build, run tests, and exercise the real application/database path. Use Swagger UI for the actual Demo 1 API evidence, including retrieving the same user/profile after an API restart.
8. Report verified results and any remaining blockers honestly; do not substitute mocks or documentation assertions for runtime evidence.

## Demo 1 Evidence to Complete

[FinalProject_Demo1Requirements.md](FinalProject_Demo1Requirements.md) remains unchanged and is the acceptance source:

- README covers prerequisites, configuration, install/start/stop/reset, and health checks without hidden steps.
- All local database variables are documented in `.env.example`, loaded from `.env`, and secrets are excluded from Git.
- At least one real TypeORM entity and API-to-database flow, demonstrated through Swagger UI only.
- Repeatable migration/schema setup and explained seed/reset behavior.
- Created/updated data is retrieved again after restarting the API without deleting the database volume.
- Demo 2 commitment: an authenticated player starts a server-timed escape-room session using `POST /sessions`, already described in the product design.