#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
fail() { printf '%s\n' "$1" >&2; exit 1; }
[ "$#" -eq 2 ] && [ "$1" = --repository ] || fail 'Usage: build-sql-sandbox.sh --repository localhost:5001/room1-sql'
[ "$2" = localhost:5001/room1-sql ] || fail 'Only the explicitly dedicated loopback SQL registry repository is supported'
repository=$2
[ "${SANDBOX_KUBE_CONTEXT:-}" = kind-skillbreak-local ] || fail 'SANDBOX_KUBE_CONTEXT must explicitly be kind-skillbreak-local'
SANDBOX_KUBE_CONTEXT=kind-skillbreak-local sh "$root/scripts/setup-sandbox-local.sh" --check
node -r "$root/node_modules/ts-node/register" -e '
const fs=require("node:fs"),path=require("node:path");
const root=process.argv[1];
const {ROOM1}=require(path.join(root,"apps/game-engine/src/modules/script-catalog/room1.ts"));
const fixture=fs.readFileSync(path.join(root,"sandboxes/sql/fixtures/room1-sql-v1.sql"),"utf8");
if(!fixture.includes(ROOM1.danaUsername)||!fixture.includes(ROOM1.danaPasswordSha256)||fixture.includes(ROOM1.danaPassword))
  throw new Error("SQL fixture compatibility failed");
' "$root"
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) fail 'Unsupported Docker node architecture' ;;
esac
mkdir -p "$root/.local"
if [ -n "${SANDBOX_BUILD_NPMRC:-}" ]; then
  [ -f "$SANDBOX_BUILD_NPMRC" ] || fail 'SANDBOX_BUILD_NPMRC must name an existing build-only npm config file'
  set -- --secret "id=npmrc,src=$SANDBOX_BUILD_NPMRC"
else
  set --
fi
docker buildx build --platform "linux/$arch" --push --provenance=false \
  "$@" \
  --metadata-file "$root/.local/sql-sandbox-build.json" \
  -t "$repository:local" "$root/sandboxes/sql"
digest=$(node -e 'const fs=require("node:fs");const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"))["containerimage.digest"];
if(typeof d!=="string"||!/^sha256:[a-f0-9]{64}$/.test(d))throw new Error("Manifest digest unavailable");process.stdout.write(d)' \
  "$root/.local/sql-sandbox-build.json")
actual=$(docker buildx imagetools inspect "$repository@$digest" --format '{{.Manifest.Digest}}')
[ "$actual" = "$digest" ] || fail 'Registry manifest digest does not match the build'
printf '%s@%s\n' "$repository" "$digest" > "$root/.local/sql-sandbox-image-ref"
printf 'Verified SQL manifest: %s@%s\n' "$repository" "$digest"
