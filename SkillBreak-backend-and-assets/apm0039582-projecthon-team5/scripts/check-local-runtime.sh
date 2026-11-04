#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
kubeconfig=${KUBECONFIG:-"$root/.local/kind.kubeconfig"}
runtime=${SANDBOX_RUNTIME_CLASS:-runc}
timeout=${RUNTIME_CHECK_TIMEOUT_SECONDS:-120}
pod=

fail() { printf '%s\n' "$1" >&2; exit 1; }
case "$runtime" in ''|*[!a-z0-9.-]*) fail 'Invalid SANDBOX_RUNTIME_CLASS';; esac
case "$timeout" in ''|*[!0-9]*) fail 'Invalid runtime timeout';; esac
[ "$timeout" -ge 1 ] && [ "$timeout" -le 300 ] || fail 'Runtime timeout must be 1..300 seconds'
[ -f "$kubeconfig" ] || fail 'Local kubeconfig not found; configure kind first'
command -v kubectl >/dev/null 2>&1 || fail 'kubectl is required'

k() {
  kubectl --kubeconfig "$kubeconfig" --context kind-skillbreak-local --request-timeout=5s \
    --namespace skillbreak-foundation "$@"
}
cleanup() {
  status=$?
  trap - 0
  if [ -n "$pod" ]; then
    if ! k delete "$pod" --ignore-not-found=true --wait=true --timeout=10s; then
      printf 'Failed to clean up owned smoke pod: %s\n' "$pod" >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup 0
trap 'exit 1' INT TERM

k cluster-info >/dev/null || fail 'Local Kubernetes API unavailable'
k wait --for=condition=Ready nodes --all --timeout="${timeout}s" >/dev/null || fail 'Local Kubernetes nodes are not ready'
handler=$(k get runtimeclass "$runtime" -o 'jsonpath={.handler}') || fail 'Requested RuntimeClass is missing'
[ -n "$handler" ] || fail 'RuntimeClass has no CRI handler'
namespace=$(k get namespace skillbreak-foundation --ignore-not-found -o name) || fail 'Cannot inspect smoke namespace'
if [ -z "$namespace" ]; then
  k create namespace skillbreak-foundation >/dev/null || fail 'Cannot create smoke namespace'
fi
existing=$(k get pods -l app.kubernetes.io/name=skillbreak-runtime-smoke -o name) || fail 'Cannot inspect existing smoke pods'
[ -z "$existing" ] || fail 'A smoke pod already exists; inspect it rather than deleting another run'
pod=$(awk -v runtime="$runtime" '
  /^  runtimeClassName:/ { print "  runtimeClassName: " runtime; next }
  { print }
' "$root/infra/local/runtime-smoke.yaml" | k create -f - -o name) || fail 'Cannot create smoke pod'
case "$pod" in
  pod/skillbreak-runtime-smoke-*) ;;
  *) pod=; fail 'Unexpected pod identity; inspect namespace manually';;
esac
deadline=$(($(date +%s) + timeout))
while :; do
  phase=$(k get "$pod" -o 'jsonpath={.status.phase}') || fail 'Cannot inspect smoke pod'
  case "$phase" in
    Succeeded) printf 'Runtime %s (handler %s) verified by completed smoke pod.\n' "$runtime" "$handler"; break ;;
    Failed) k describe "$pod" >&2; fail 'Smoke pod failed; runtime handler may be unavailable' ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    k describe "$pod" >&2
    fail 'Smoke pod did not complete before timeout'
  fi
  sleep 1
done
