# SkillBreak Team 5 — Quickstart for an Agent (or a Person)

Goal: from the two folders, run the whole game (Room 1 → Room 2 → victory) on one machine, with no
GitHub, no Kubernetes and no sandbox containers. Read this top to bottom once; every step was run and
checked on 10 Nov 2026. For what was built and how it fits together, open
[`docs/skillbreak-explainer.html`](docs/skillbreak-explainer.html) in a browser.

## 1. The two folders

| Folder | What it is | Branch to use |
| --- | --- | --- |
| `apm0039582-projecthon-team5` | Backend monorepo: gateway (`:3000`), game engine (`:3001`), local runtime that runs both in one process, Postgres via Docker Compose | `room2/R2-09-e2e` (or a later branch built on it) |
| `apm0039582-projecthon-fe` | Shared frontend (Vite + React). **Team 5 may only change `src/teams/team5/**`.** | `team5/room2/R2-09-e2e` (or `team5/background-blur`, which adds the blurred background) |

**There is no GitHub remote.** Each folder is a complete git repository (the hidden `.git` folder holds every
branch and its full history). To hand the project to someone, copy or zip both folders **including `.git`**.
Do not `git push` or `git pull`; there is nothing to push to.

How the two folders connect: **only through ports, never through paths.** Put them anywhere (side by
side is easiest). The frontend's dev server proxies (see `src/teams/team5/vite.local.config.ts`):

- `/api/team5/sessions/<id>/stream` → `http://127.0.0.1:3001` (engine, live updates over SSE)
- every other `/api/team5/*` → `http://127.0.0.1:3000` (gateway)

So: backend running on 3000/3001 + frontend on 5173 = connected.

Branch history (each branch is cut from the one before it, one branch per feature):

```
backend : main … sync/github-main-nov9 → embedded-sql-sandbox → room2/R2-01-content → room2/R2-05-capture
          → room2/R2-06-rsa → room2/R2-08-door-escape → room2/R2-07-tls → room2/R2-03-git
          → room2/R2-04-ruin-reset → room2/R2-09-e2e → docs/agent-quickstart
frontend: main → team5/sync-nov9 → team5/room2/R2-02-scene → …-R2-05-capture → …-R2-06-rsa
          → …-R2-08-keypad-victory → …-R2-07-tls → …-R2-03-terminal → …-R2-04-ruin-reset
          → team5/room2/R2-09-e2e → team5/background-blur
```

The order differs from the task numbers because each task was added when it was approved. Old branches
`Feature1_task1.*` in the backend point at commits that are not in this copy of the repository; they were
already broken before Room 2 and are harmless — ignore them.

## 2. Prerequisites

- Node.js 22 (backend requires ≥ 20) and npm.
- Docker Desktop running (only for the two Postgres databases and one-off migration/seed containers).
- `openssl` (to generate secrets).
- macOS/Linux shell. **The backend path must not contain spaces** (see step 4).

## 3. npm packages (the AT&T registry problem)

Both `package-lock.json` files point at AT&T's registries (`artifact.it.att.com`,
`jfrog-pkg-proxy.it.att.com`). On the AT&T network, a plain `npm ci` works and you can skip this section.
Outside it, those hosts are unreachable, so:

1. Create a public npm config file **outside both repositories**, e.g. `~/skillbreak-local/public.npmrc`:

   ```
   registry=https://registry.npmjs.org/
   replace-registry-host=always
   ```

   `replace-registry-host=always` makes npm download every locked package (same versions, same integrity
   hashes) from the public registry. The lockfiles are not changed.

2. For the backend's Docker install step, also create a public copy of the backend lockfile and a Compose
   override that mounts it (both outside the repo):

   ```sh
   mkdir -p ~/skillbreak-local
   sed -E 's#https://[a-z0-9.-]+\.att\.com/artifactory/api/npm/[^/]+/#https://registry.npmjs.org/#g' \
     <backend>/package-lock.json > ~/skillbreak-local/package-lock.public.json
   cat > ~/skillbreak-local/override.yml <<EOF
   services:
     workspace-init:
       volumes:
         - $HOME/skillbreak-local/package-lock.public.json:/app/package-lock.json:ro
   EOF
   ```

   Regenerate `package-lock.public.json` whenever the backend `package-lock.json` changes (Room 2 added
   `isomorphic-git`, `memfs` and their dependencies).

## 4. Backend: one-time setup

```sh
# A path without spaces (the demo script puts the repo path into NODE_OPTIONS, which breaks on spaces).
ln -s "<full path to>/apm0039582-projecthon-team5" ~/team5-backend
cd ~/team5-backend
git checkout room2/R2-09-e2e

cp .env.example .env
# Edit .env: replace every REPLACE_WITH_… value. Generate secrets with:  openssl rand -base64 32
# Uncomment and set INTERNAL_API_TOKEN (its own random value, never the JWT secret).
# Set NPM_USER_CONFIG=$HOME/skillbreak-local/public.npmrc if you are outside the AT&T network.

npm ci --userconfig ~/skillbreak-local/public.npmrc    # drop --userconfig on the AT&T network

export COMPOSE_FILE="docker-compose.yml:$HOME/skillbreak-local/override.yml"   # outside AT&T only
docker compose up -d --wait postgres engine-db
set -a; . ./.env; set +a
docker compose exec -T postgres  psql -U "$DB_USER"        -d "$DB_NAME"        -c 'CREATE SCHEMA IF NOT EXISTS team5'
docker compose exec -T engine-db psql -U "$ENGINE_DB_USER" -d "$ENGINE_DB_NAME" -c 'CREATE SCHEMA IF NOT EXISTS team5'
```

The `team5` schema step is needed once per fresh database: locally nothing else creates it (on AKS
`scripts/migrate-shared.js` does).

## 5. Backend: run

```sh
cd ~/team5-backend
export COMPOSE_FILE="docker-compose.yml:$HOME/skillbreak-local/override.yml"   # outside AT&T only
export NPM_USER_CONFIG="$HOME/skillbreak-local/public.npmrc"                   # outside AT&T only
sh scripts/demo-room1.sh
```

Despite its name, the script runs the whole game. It builds the shared packages, starts both databases,
runs migrations, publishes the game content (Room 1, the embedded SQL template, gameplay v4 and **Room 2
v5**), then starts gateway + engine in one process. Ready when the log shows
`gateway :3000, engine :3001`. The default mode is **embedded**: both puzzle sandboxes (SQL and git) run
inside the engine process. `Ctrl+C` stops it; the databases keep their data.

## 6. Frontend: run

```sh
cd "<full path to>/apm0039582-projecthon-fe"
git checkout team5/room2/R2-09-e2e        # or team5/background-blur
npm ci --userconfig ~/skillbreak-local/public.npmrc   # drop --userconfig on the AT&T network
node_modules/.bin/vite --config src/teams/team5/vite.local.config.ts --port 5173
```

Open **http://localhost:5173/src/teams/team5/standalone/index.html**. Use the standalone page: the shared
root page (`/`) needs every team's folder and may fail locally. Create an account on the sign-in screen,
then press **Start game**.

## 7. Check it works (2 minutes)

- Start game → Room 1 shows "Ready / Live / 0 / 3 solved".
- Idan's computer → `SELECT * FROM employees` returns rows (the embedded SQL sandbox answers).
- Full winning path: [`docs/acceptance/room2-quickstart.md`](docs/acceptance/room2-quickstart.md).
- Tests: `cd apps/game-engine && npx jest --config jest.config.cjs` (backend, no database needed);
  in the frontend: `npx vitest run src/teams/team5`.

## 8. Why Kubernetes did not work, and what replaced it

DESIGN-v2 §7 runs **every puzzle sandbox as its own Kubernetes pod**: the engine calls the Kubernetes API
and creates a locked-down pod (non-root, read-only filesystem, no network) per player per puzzle — one
Postgres pod for Room 1's SQL, one git pod for Room 2's repository.

That never worked for Team 5:

1. **No permission to create pods.** The Team 5 namespace on the shared AKS cluster lets our release run
   its own deployment, but the engine's service account cannot create pods. So in the deployed app the SQL
   puzzle was switched off (`SANDBOX_ENABLED=false`), and Room 2's git sandbox could not run at all.
2. **Locally it needed a cluster.** Running the design as written required a `kind` cluster, a local image
   registry and allowlisted image digests, or an extra `sql-sandbox` container with a polling workaround.
   Fragile and slow to set up.

Fix (ADR [`docs/adr/0001-embedded-sandbox-driver.md`](docs/adr/0001-embedded-sandbox-driver.md)): the
engine talks to sandboxes only through one interface, `SandboxDriver`. Two drivers exist:

- **`SANDBOX_DRIVER=embedded` (default, local and AKS):** Room 1 SQL runs on PGlite (Postgres compiled to
  WebAssembly) in a worker thread, read-only per query; Room 2 git runs on isomorphic-git over an
  in-memory file system in a worker thread, rebuilt from a fixture per sandbox generation. Same flow as the
  design: provision → ready → execute (5 s limit, 64 KB output cap, stored result per command id) →
  destroy, with generations for resets.
- **`SANDBOX_DRIVER=kubernetes`:** the original pod driver, kept for SQL in case pods become allowed. Git
  is not supported there (`sh scripts/demo-room1.sh kind` still runs Room 1 SQL on kind).

Trade-off: weaker isolation than pods (sandboxes share the engine process and CPU), but the player's code
never touches host files, network or processes, and it runs anywhere the app runs.

## 9. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `npm ci` hangs or `ENOTFOUND artifact.it.att.com` | Outside the AT&T network: use the public npm config (section 3). |
| Docker `workspace-init` fails on npm | Set `COMPOSE_FILE` with the override and `NPM_USER_CONFIG` (section 3/5). |
| `relation … does not exist` / `schema "team5" does not exist` | Run the two `CREATE SCHEMA` commands (section 4). |
| `Missing .env` / `INTERNAL_API_TOKEN must be set` | Create `.env` from `.env.example` and set the token. |
| Errors mentioning a path cut at a space | Run from the no-spaces link (`~/team5-backend`). |
| Frontend loads but every request fails | Backend not running on 3000/3001, or you opened `/` instead of the standalone page. |
| Esc does not close the git terminal | Same as the design HTML: xterm takes the key. Use the back button or ×. |
| Clicking the open Room 2 door opens the keypad | The keypad sits over the door (as in the design). Click the "To the victory room" label. |
| Port 3000/3001/5432/5433 in use | Stop the other process, or change `PORT` / `DB_PORT` / `ENGINE_DB_PORT` in `.env`. |
