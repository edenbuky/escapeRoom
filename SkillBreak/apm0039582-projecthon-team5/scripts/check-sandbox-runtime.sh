#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "${SANDBOX_KUBE_CONTEXT:-}" = kind-skillbreak-local ] || {
  printf '%s\n' 'SANDBOX_KUBE_CONTEXT must explicitly be kind-skillbreak-local' >&2
  exit 1
}
TS_NODE_PROJECT="$root/apps/game-engine/tsconfig.json" \
  exec node --require "$root/node_modules/ts-node/register" "$root/apps/game-engine/src/modules/sandbox/check-runtime.ts"
