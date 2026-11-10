#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:-}
fail() { printf '%s\n' "$1" >&2; exit 1; }
case "$mode" in --check|--create) ;; *) fail 'Usage: setup-sandbox-local.sh --check|--create';; esac
[ "$#" -eq 1 ] || fail 'Usage: setup-sandbox-local.sh --check|--create'
[ "${SANDBOX_KUBE_CONTEXT:-}" = kind-skillbreak-local ] || fail 'SANDBOX_KUBE_CONTEXT must explicitly be kind-skillbreak-local'
kubeconfig=${KUBECONFIG:-"$root/.local/kind.kubeconfig"}
kind=${KIND_BIN:-"$root/.local/bin/kind"}
node=skillbreak-local-control-plane
registry=skillbreak-sandbox-registry
calico_version=v3.33.0
calico_sha=2de8f47595fb9c41b3f47d7b767a1f8e72ecf84057af834738ff12689a234da5

k() {
  kubectl --kubeconfig "$kubeconfig" --context kind-skillbreak-local --request-timeout=30s "$@"
}
check() {
  [ -f "$kubeconfig" ] || fail 'Dedicated local kubeconfig missing; use --create for a new cluster'
  [ -x "$kind" ] || fail 'Pinned kind binary missing; install kind v0.33.0 into .local/bin/kind'
  command -v kubectl >/dev/null 2>&1 || fail 'kubectl is required'
  version=$("$kind" version) || fail 'Cannot inspect kind version'
  case "$version" in 'kind v0.33.0 '*) ;; *) fail 'Use pinned kind v0.33.0';; esac
  k get node "$node" >/dev/null || fail 'Dedicated local cluster unavailable'
  annotation=$(k get node "$node" -o 'jsonpath={.metadata.annotations.team5\.sandbox-setup}')
  [ "$annotation" = "calico-$calico_version-pids64-v2" ] ||
    fail 'Existing local cluster is incompatible. Do not recreate it automatically; migrate it explicitly after inspecting owned resources.'
  k get --raw "/api/v1/nodes/$node/proxy/configz" |
    node -e "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{if(JSON.parse(s).kubeletconfig.podPidsLimit!==64)process.exit(1)})" ||
    fail 'Node PID ceiling is not 64'
  k -n kube-system rollout status daemonset/calico-node --timeout=120s || fail 'Calico is not ready'
  k -n kube-system rollout status deployment/calico-kube-controllers --timeout=120s || fail 'Calico controllers are not ready'
  k -n team5-sandboxes get networkpolicy sandbox-default-deny >/dev/null || fail 'Sandbox default deny missing'
  [ "$(k get runtimeclass runc -o 'jsonpath={.handler}')" = runc ] || fail 'runc handler missing; no fallback is permitted'
  [ "$(docker inspect --format '{{index .Config.Labels "team5.owner"}}' "$registry")" = sql-sandbox-local ] ||
    fail 'Local registry missing or ownership mismatch'
  printf '%s\n' 'Dedicated cluster setup verified. Actual isolation/query probes are a separate required gate.'
}

if [ "$mode" = --check ]; then check; exit 0; fi
[ -x "$kind" ] || fail 'Pinned kind binary missing; install kind v0.33.0 into .local/bin/kind'
[ ! -e "$kubeconfig" ] || fail 'Refusing to overwrite an existing kubeconfig; run --check and inspect compatibility'
clusters=$("$kind" get clusters) || fail 'Cannot inspect kind clusters'
if printf '%s\n' "$clusters" | grep -qx skillbreak-local; then
  fail 'Dedicated cluster already exists; run --check with its explicit kubeconfig. Never recreate automatically.'
fi
if docker container inspect "$registry" >/dev/null 2>&1; then
  fail 'Registry container name already exists; inspect it rather than replacing it'
fi
version=$("$kind" version)
case "$version" in 'kind v0.33.0 '*) ;; *) fail 'Use pinned kind v0.33.0';; esac
mkdir -p "$root/.local/downloads"
calico="$root/.local/downloads/calico-$calico_version.yaml"
curl -fsSL "https://raw.githubusercontent.com/projectcalico/calico/$calico_version/manifests/calico.yaml" -o "$calico"
printf '%s  %s\n' "$calico_sha" "$calico" | shasum -a 256 -c - || fail 'Calico manifest checksum mismatch'
docker run -d --restart=unless-stopped --name "$registry" --label team5.owner=sql-sandbox-local \
  -p 127.0.0.1:5001:5000 \
  registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373 >/dev/null
printf '%s\n' "Creating dedicated cluster. On failure inspect $registry and skillbreak-local; no automatic deletion is performed."
NO_PROXY="${NO_PROXY:+$NO_PROXY,}$registry" no_proxy="${no_proxy:+$no_proxy,}$registry" \
  "$kind" create cluster --config "$root/infra/local/kind.yaml" --kubeconfig "$kubeconfig" --wait 0s
docker network connect kind "$registry"
docker exec "$node" mkdir -p /etc/containerd/certs.d/localhost:5001
docker exec -i "$node" tee /etc/containerd/certs.d/localhost:5001/hosts.toml >/dev/null <<'EOF'
[host."http://skillbreak-sandbox-registry:5000"]
  capabilities = ["pull", "resolve"]
EOF
# Use the host's verified trust store; do not disable TLS inside kind nodes.
case "$(docker info --format '{{.Architecture}}')" in
  aarch64|arm64) arch=arm64 ;;
  x86_64|amd64) arch=amd64 ;;
  *) fail 'Unsupported Docker node architecture' ;;
esac
for pinned in \
  'quay.io/calico/calico:v3.33.0@sha256:4ebc20730127bc9e8bf1db5f5a2d8b58cf37fe0e891b3c7b5471992221d213e5' \
  'quay.io/calico/third-party-cni-plugins:v3.33.0@sha256:0f32f48279484c0d6f0e0d0e767b2d0e1a6c6ca34cb3421a61b989d992f3df41' \
  'quay.io/calico/node:v3.33.0@sha256:565d8db3200e443955557f8f28ff44ab8a4a456754bc74a19c4f2f3444af9b1c'
do
  image=${pinned%@*}
  docker pull --platform "linux/$arch" "$pinned"
  docker tag "$pinned" "$image"
  docker image save --platform="linux/$arch" "$image" -o "$root/.local/downloads/calico-preload.tar"
  "$kind" load image-archive "$root/.local/downloads/calico-preload.tar" --name skillbreak-local
  rm "$root/.local/downloads/calico-preload.tar"
done
k apply -f "$calico"
# Calico applies workload egress policy first; blanket host DROP also blocks its own API client.
k -n kube-system set env daemonset/calico-node FELIX_DEFAULTENDPOINTTOHOSTACTION=ACCEPT GOMAXPROCS=2
k -n kube-system set env deployment/calico-kube-controllers GOMAXPROCS=2
k -n kube-system rollout status daemonset/calico-node --timeout=180s
k -n kube-system rollout status deployment/calico-kube-controllers --timeout=180s
k wait --for=condition=Ready "node/$node" --timeout=180s
k apply -f "$root/infra/sandbox/namespace.yaml"
k apply -f "$root/infra/sandbox/network-policy.yaml"
k apply -f "$root/infra/sandbox/engine-role.yaml"
k annotate node "$node" "team5.sandbox-setup=calico-$calico_version-pids64-v2"
check
