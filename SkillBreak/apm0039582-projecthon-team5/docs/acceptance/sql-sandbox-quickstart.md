# Quickstart: SQL Sandbox Validation

## Status and scope

This guide covers the implemented local SQL sandbox and its repeatable validation gates. Builds or fake-executor tests alone do not establish runtime isolation.

The trusted image, Kubernetes driver, durable worker/executor, immutable catalog publication and live-runtime suite are implemented. Enabled startup requires migrated sandbox tables, a published digest-pinned SQL template and successful actual enforcement preflight. Configuration alone never establishes isolation.

Run commands from the repository root:

```sh
cd /Users/eb4148/Repositories/SkillBreakWorkspace/apm0039582-projecthon-team5
```

No Azure credentials, sandbox HTTP service, or production cluster is required. Local runc isolation is development-only.

## 1. Prerequisites

- Node.js 22, installed root workspace dependencies, Docker Desktop.
- kind and compatible kubectl; existing foundation guidance is in the [README](../../README.md).
- Dedicated `kind-skillbreak-local` cluster and ignored local kubeconfig, never the default/current corporate or production context.
- Policy-enforcing local CNI, node PID ceiling, requested RuntimeClass, sandbox namespace/RBAC/network policies, and a loopback local registry reachable by kind.
- Enough local capacity for the engine test database and multiple 256-MiB sandbox pods.

Do not overwrite existing environment files, print secrets, reset a development database, or automatically delete/recreate an existing cluster. The setup command must detect an incompatible existing cluster and stop with migration instructions.

## 2. Baseline code gates

Run the existing regression gates:

```sh
npm run build:foundation
npm run test:foundation -- --runInBand
npm run typecheck --workspace @team5/game-engine
npm run test:catalog:integration --workspace @team5/game-engine
npm run test:engine:integration --workspace @team5/game-engine
```

Database integration suites use disposable databases; they are not permission to migrate/reset a user-selected application database.

Focused unit and disposable-database checks:

```sh
npm test --workspace @team5/game-engine -- --runInBand --testPathPattern='sandbox-'
npm run test:sandbox:db --workspace @team5/game-engine
```

The default test run skips the opt-in database/runtime suites. `test:sandbox:db` requires Docker and creates only its own throwaway PostgreSQL containers, removing them afterward. It never uses the configured development database. `test:sandbox:runtime` additionally requires the dedicated cluster and built image below. Explicit integration commands fail when prerequisites or tests are missing, rather than succeed with zero tests.

## 3. Prepare the dedicated local runtime

Select the dedicated context explicitly:

```sh
export KUBECONFIG="$PWD/.local/kind.kubeconfig"
export SANDBOX_KUBE_CONTEXT=kind-skillbreak-local
export SANDBOX_RUNTIME_CLASS=runc

sh scripts/setup-sandbox-local.sh --check
```

If no dedicated cluster exists, explicitly create it:

```sh
sh scripts/setup-sandbox-local.sh --create
```

Creation installs checksum-pinned Calico with kind's default CNI disabled and kubelet `podPidsLimit: 64`, local registry wiring, the runc RuntimeClass, restricted namespaces, default-deny sandbox policies, and least-privilege engine pod/exec access. It never executes a fetched shell script. `--check` does not replace an existing cluster or change unrelated contexts. It rejects missing Calico/runtime/PID prerequisites.

The existing `scripts/check-local-runtime.sh` remains a foundation-only smoke test. It is not proof of SQL readiness, network isolation, or PID limits.

## 4. Build and pin the SQL image

Build and capture the verified manifest reference:

```sh
sh scripts/build-sql-sandbox.sh --repository localhost:5001/room1-sql
export SANDBOX_SQL_IMAGE="$(cat .local/sql-sandbox-image-ref)"
export SANDBOX_IMAGE_ALLOWLIST=localhost:5001/room1-sql
```

The script builds for the kind node architecture, projects only approved fictional username/hash seed content, pushes to the explicitly configured local registry, and writes the verified `repository@sha256:manifest-digest` into the ignored reference file. It must not infer the manifest digest from Docker's image configuration ID or keep a mutable tag as the pinned identity.

No catalog publication or engine database mutation occurs as a side effect of building the image.

If dependency installation requires private npm configuration, set `SANDBOX_BUILD_NPMRC` to its
existing absolute path before building. It is mounted as a BuildKit secret during dependency
installation only; never copy it into the build context, print its contents or commit it.

## 5. Verify enforcement before admitting queries

Run actual enforcement preflight:

```sh
sh scripts/check-sandbox-runtime.sh
```

Expected:

- The exact requested runtime exists and can start the restricted pod without fallback.
- Sandbox processes run non-root, capabilities are absent, privileged escalation is disabled, base filesystem is read-only, no host mounts/token are present, writable storage and CPU/memory/PIDs are bounded.
- Real denied-connection probes cover another sandbox, an external target, node/host endpoints, and the engine/application network. Use controlled probe targets with positive controls proving reachability from the non-sandbox test location; a timeout against an unreachable target is not evidence of policy enforcement.
- Engine still reaches the Kubernetes API and exec; PostgreSQL inside the sandbox has no TCP listener.
- Temporary probe resources are labeled with a test-run identity and cleaned by exact owned names/UIDs. A cleanup failure exits nonzero and reports remaining owned identities.

Missing CNI enforcement, unknown PID limits, absent runtime, or failed cleanup blocks the enabled worker. This guide does not claim that a default kind installation meets those requirements.

## 6. Run real end-to-end acceptance

With the explicit context and image from the preceding steps:

```sh
npm run test:sandbox:runtime --workspace @team5/game-engine
```

The harness uses the explicit local context, its own disposable engine PostgreSQL containers, current forward migrations, and the verified SQL image reference. It seeds catalog v1, explicitly publishes digest-pinned v2 in the disposable database, starts a real engine worker/executor, and sends commands through the existing in-memory transport or engine service. It must not replace SQL execution or outcome recording with stubs.

Run these checks:

| Scenario | Required evidence |
|----------|-------------------|
| Provision and clue | Start a new room-1 session after v2 publication; one owned ready pod; real employee/log join returns the catalog username/hash |
| Template compatibility | v1 content unchanged; v2 points to the exact built digest; legacy tag-based jobs fail visibly instead of resolving through a hidden override |
| Read-only permissions | Direct restricted-role tests reject UPDATE/DELETE/DROP/CREATE/privilege escalation; subsequent SELECT confirms fixture unchanged |
| Single statement | Empty/comment-only/multiple statements rejected; joins, subqueries, quoted/comment semicolons and a trailing semicolon handled correctly |
| Result fidelity | Empty rows, null/empty/literal-null strings, duplicate column names, tabs/newlines/backslashes and Unicode survive grid encoding |
| Deadline | A long query stops within five seconds and returns timeout within the additional one-second response allowance; subsequent bounded query works |
| Output | Exact/below/above 65,536-byte cases, multibyte values and oversized single rows stay bounded with explicit truncation and no false solve |
| Duplicates | Ten concurrent identical commands start one query; ten later replays, including after app restart, match the stored result |
| Busy behavior | Another command is rejected without sandbox admission, engine receipt/retry-budget consumption, or lease renewal; its same ID succeeds when retried later; another sandbox progresses |
| Crash during query | Recreate engine with the same test database; original command is never rerun; old remote work is quiesced or pod removed before new admission |
| Lifecycle recovery | Restart after claim/create/seed/readiness and before/after outcome recording; preserve original sixty-second deadline and three-check budget |
| Stale outcomes | Old generation cannot change the current one; duplicate outcome delivery is harmless |
| Expiry | At exact idle/max expiry reject new work and persist one destroy intent; replay remains unchanged without renewal |
| Destroy races | Concurrent provision/exec/destroy cannot resurrect destroyed intent; absent pod counts as success; unavailable API never yields false destruction |
| Engine transaction | Rolled-back StartSession leaves no runnable sandbox job; real outcome/command lock ordering does not deadlock |
| Room-1 integration | Actual SQL clue, hash answer, and login advance to non-final room-2 without changing published solution content |
| Health | Disabled worker is honest; enabled worker becomes ready only after preflight; loss of runtime is unavailable, not fabricated readiness |

Record wall-time measurements, exact output byte lengths, query admission counts, surviving pod identities, and retained rows/outcomes in assertions. Timing/state tests may use an injected clock for long lease durations, but the live query timeout test must use real wall time.

On all success/failure paths, the harness stops its owned app/DB clients, removes only run-owned pods by UID, and reports cleanup failures. It does not delete the shared dedicated kind cluster, namespace, registry, or other sessions' resources.

## 7. Optional manual local engine

Use the ordinary engine configuration in its ignored environment file. Explicitly enable sandbox operation only after runtime preflight. Existing defaults must still permit engine startup without Kubernetes when `SANDBOX_ENABLED=false`.

For a user-selected development database, inspect the target first; these commands deliberately mutate it:

```sh
npm run migration:run --workspace @team5/game-engine
npm run seed:room1 --workspace @team5/game-engine
```

Then explicitly publish the digest-pinned version:

```sh
npm run seed:room1:sql --workspace @team5/game-engine -- --image "$SANDBOX_SQL_IMAGE"
```

Repeat publication with the same digest is idempotent. Conflicting v2 content fails; do not overwrite or reset it. The original seed retains its exact conflict detection and must not be used to downgrade a database whose current script is v2. Existing sessions remain pinned to their old version; start a fresh session to select v2.

Configure `SANDBOX_ENABLED=true`, `SANDBOX_DRIVER=kubernetes`, the explicit kube context/configuration, requested runtime, and image allowlist privately, then:

```sh
npm run start:dev --workspace @team5/game-engine
```

`SANDBOX_WORKER_CONCURRENCY` defaults to 2 and is bounded to 1..4, reserving ordinary engine DB
capacity. An explicitly injected fake executor still wins and suppresses real worker startup.
Health reports `disabled`, `starting`, `ready` or `unavailable`; enabled readiness requires the
sandbox tables and enforcement preflight. API loss fences admission and returns 503 with a safe
category. Recovery repeats the actual preflight before reporting readiness.

Local setup uses a dedicated development administrator for node-configuration evidence. The
least-privilege engine role intentionally does not grant `nodes/proxy`; production preflight
authorization and the production RuntimeClass choice remain unresolved and fail closed. Do not broaden RBAC or
claim production readiness solely because local runc checks pass.

Use the engine's existing internal/test integration entry points for submissions; no new sandbox HTTP or Swagger endpoint is introduced. Gateway Swagger remains independently testable as before.

## Acceptance boundary

The [authoritative design](../../DESIGN-v2.md) defines target behavior. Production RuntimeClass
selection remains open (Q7); node placement and namespace capacity remain separate open questions.
Successful builds and fake-executor tests alone do not prove isolation. Public untrusted operation,
Azure delivery, periodic reaping, reconnect policy, and terminal/git sandboxes are outside this guide.
