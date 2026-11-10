#!/bin/sh
# Room 1 demo: gateway (:3000) and engine (:3001) in one process (apps/local-runtime), trail in room1-trail.log.
# Usage: sh scripts/demo-room1.sh          # SQL puzzle in-process (embedded driver, no container or pod)
#        sh scripts/demo-room1.sh local    # SQL puzzle on the sql-sandbox container (S9, SANDBOX_LOCAL_CONTAINER=true)
#        sh scripts/demo-room1.sh kind     # SQL puzzle on kind (needs the kind setup from "Local Kubernetes Prerequisite")
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$root"
fail() { printf '%s\n' "$1" >&2; exit 1; }
mode=${1:-embedded}
if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then export FORCE_COLOR=1; fi
case "$mode" in embedded|local|kind) ;; *) fail 'Usage: sh scripts/demo-room1.sh [embedded|local|kind]' ;; esac
[ -f .env ] || fail 'Missing .env: see Configure in README.md'
node -r dotenv/config -e 'process.exit(process.env.INTERNAL_API_TOKEN ? 0 : 1)' \
  || fail 'INTERNAL_API_TOKEN must be set in .env (openssl rand -base64 32)'
if [ "$mode" = kind ]; then
  [ "${SANDBOX_KUBE_CONTEXT:-}" = kind-skillbreak-local ] && [ -n "${KUBECONFIG:-}" ] && [ -n "${SANDBOX_IMAGE_ALLOWLIST:-}" ] \
    || fail 'kind needs SANDBOX_KUBE_CONTEXT=kind-skillbreak-local, KUBECONFIG and SANDBOX_IMAGE_ALLOWLIST'
  [ -f .local/sql-sandbox-image-ref ] || sh scripts/build-sql-sandbox.sh --repository localhost:5001/room1-sql
fi
npm run build:foundation
npm run build --workspace @team5/local-runtime

# The joint runtime replaces the api and engine containers and uses their ports.
docker compose stop api engine
docker compose up -d --wait postgres engine-db
docker compose run --rm engine-migrate
docker compose run --rm --no-deps api npm run migration:run
docker compose run --rm --no-deps engine npm run seed:room1 --workspace @team5/game-engine

# Host processes reach the Compose databases through their published ports.
port() { docker compose port "$1" "$2" | sed 's/.*://'; }
export DB_HOST=127.0.0.1 DB_PORT="$(port postgres 5432)"
export ENGINE_DB_HOST=127.0.0.1 ENGINE_DB_PORT="$(port engine-db 5432)"
if [ "$mode" = embedded ]; then
  export SANDBOX_LOCAL_CONTAINER=false SANDBOX_ENABLED=true SANDBOX_DRIVER=embedded
  DOTENV_CONFIG_PATH="$root/.env" NODE_OPTIONS="--require $root/node_modules/dotenv/config" \
    npm run seed:room1:sql --workspace @team5/game-engine -- --embedded
elif [ "$mode" = local ]; then
  docker compose --profile demo-local up -d --wait sql-sandbox
  export SANDBOX_LOCAL_CONTAINER=true
  export SANDBOX_ENABLED=false
else
  export SANDBOX_LOCAL_CONTAINER=false
  export SANDBOX_ENABLED=true SANDBOX_DRIVER=kubernetes SANDBOX_RUNTIME_CLASS=runc
  # The engine CLI reads only its own dotenv file, so the root .env is preloaded for it.
  DOTENV_CONFIG_PATH="$root/.env" NODE_OPTIONS="--require $root/node_modules/dotenv/config" \
    npm run seed:room1:sql --workspace @team5/game-engine -- --image "$(cat .local/sql-sandbox-image-ref)"
fi

DOTENV_CONFIG_PATH="$root/.env" NODE_OPTIONS="--require $root/node_modules/dotenv/config" \
  npm run seed:gameplay --workspace @team5/game-engine

# Room 2 content (script v5); its git history runs embedded in every mode.
DOTENV_CONFIG_PATH="$root/.env" NODE_OPTIONS="--require $root/node_modules/dotenv/config" \
  npm run seed:room2 --workspace @team5/game-engine

# Run from the root so the gateway's dotenv/config loads the root .env.
node apps/local-runtime/dist/main.js 2>&1 | tee "$root/room1-trail.log"
