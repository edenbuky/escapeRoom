# ADR 0001: Embedded sandbox driver as the default

- Status: accepted
- Date: 2026-11-10
- Relates to: DESIGN-v2 §7 (Sandboxes)

## Context

DESIGN-v2 §7 runs every sandbox as its own Kubernetes pod, created by the engine in a dedicated sandbox
namespace. The Team 5 AKS namespace cannot create pods, so the deployed SQL puzzle was switched off, and
local runs needed either a kind cluster or a separate `sql-sandbox` container with a polling workaround.
The application must run its puzzles the moment it starts, locally and when deployed, without creating
containers or pods.

## Decision

Sandbox runtimes sit behind one interface, `SandboxDriver`
(`apps/game-engine/src/modules/sandbox/sandbox-driver.ts`). `SandboxWorker` and `SandboxExecutorService`
keep the whole §7 flow (provision, ready, exec with stored results per commandId, destroy, generations)
and call only the driver.

- `SANDBOX_DRIVER=embedded` (default): `EmbeddedDriver` runs sandboxes inside the engine process. Room 1 SQL
  runs on PGlite (Postgres compiled to WebAssembly) in a worker thread, loaded from the unchanged
  `sandboxes/sql/fixtures/room1-sql-v1.sql`. Each statement runs `BEGIN READ ONLY`, as `sandbox_player`,
  and is rolled back. Output format, 64 KB limit, 5 s limit, diagnostics and execution-token rules match
  the pod helper (`sandboxes/sql/query-helper.mjs`). An overrunning query's thread is terminated and
  replaced from a snapshot, because WebAssembly Postgres does not enforce `statement_timeout`.
- `SANDBOX_DRIVER=kubernetes`: `KubernetesDriver`, unchanged, for environments that allow sandbox pods.

The database keeps requiring digest-pinned sandbox templates. The embedded runtime's pinned identity is
`embedded/room1-sql@sha256:<sha256 of the fixture>`; `seed:room1:sql --embedded` publishes SQL template 2
with it, and `EmbeddedDriver` accepts only that identity, as the Kubernetes driver accepts only
allowlisted images. A database published for one runtime is therefore not silently served by the other;
use a separate database per runtime.

## Consequences

- SQL works on start in the AKS pod and locally, with no container, kind cluster or pod.
- Isolation is weaker than §7's pod controls. The player's SQL runs in an in-memory WebAssembly database
  with no host files, network or processes, and cannot write (read-only transaction, read-only role), but
  it shares the engine's process and CPU, and there is no kernel-level isolation or per-sandbox memory/CPU
  limit. Sandboxes share one database instance and run one query at a time.
- The `local` (container) and `kind` modes of `scripts/demo-room1.sh` remain available.
- Room 2's `terminal-git` sandbox uses the same driver; see "Room 2 git" below.

## Room 2 git

Room 2's `terminal-git` sandbox (Nathaniel's git terminal) is a second seed of the same embedded driver
(`seedRef: room2-git-v1`, template `nethanel-git@1`), and it is writable, unlike SQL.

- Each sandbox is its own worker thread holding an in-memory repository: isomorphic-git on a memfs volume,
  rebuilt from `sandboxes/git/fixtures/room2-git-v1.json` whenever the thread starts (per sandbox, per
  generation). The thread refuses to start unless the rebuilt HEAD oid equals the fixture's last oid.
- Pinned identity: `embedded/room2-git@sha256:<sha256 of the fixture>` (published in catalog v5, accepted
  by `EmbeddedDriver.validateImage` next to the SQL one).
- There is no shell. One line is split into words and checked against the template policy
  (`allowedCommands`, `allowedGitSubcommands`); pipes, redirection, `;`, `&&`, backticks, `$(` and every
  other command are blocked before anything runs (`rejected/policyBlocked`). Implemented: `git log`
  (`--oneline`, `-p`, `-n N`), `show` (`<rev>`, `<rev>:<path>`), `status`, `diff`, `checkout` (revision,
  branch, `-b`, `<rev> -- <path>`), `branch`, `add`, `commit` (`--allow-empty`, `-m`, `-a`), `reset`, and
  `ls`, `cat`, `pwd`, `help`.
- The 5 s limit, the 64 KB output cap and the one stored result per `commandId` match the SQL path (the
  executor and its tables are shared). An overrunning command terminates the thread; the sandbox starts over
  from the fixture history.
- The goal is the full private key PEM (`server.key` at `HEAD~1`) appearing in stdout. The `inspect` helper
  mode reports the sandbox's HEAD (`head`, `branch`, `headMessage`), which is what ruin detection and reset
  (R2-04) compare with the template's `invariants`.
- Kubernetes mode does not support git: no git container image exists, and `KubernetesDriver` rejects the
  git seed and the embedded image with `unsupportedSandbox`. Room 2 needs `SANDBOX_DRIVER=embedded`.
- Isolation is the same trade-off as for SQL: in-process memory only (no host files, network or processes),
  but no kernel-level isolation or per-sandbox CPU/memory limit.
