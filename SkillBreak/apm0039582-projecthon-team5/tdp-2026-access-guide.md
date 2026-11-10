# Accessing the `tdp-2026` Namespace — User Guide

This guide is for **any developer granted access** to connect to the
**`tdp-wst2-dev-app-aks`** cluster and work inside the **`tdp-2026`** namespace.

Access is **namespace-scoped read/write (`edit`)**:
- ✅ You can view and modify workloads/configs/secrets **inside `tdp-2026`**.
- ❌ You cannot list all namespaces, see other namespaces, view nodes, or change RBAC.
- ℹ️ Always target the namespace explicitly with `-n tdp-2026`.

---

## 1. Prerequisites — install these tools

> **macOS users — install Homebrew first.** The macOS commands below use
> [Homebrew](https://brew.sh) (`brew`). If you don't have it yet, install it with:
> ```bash
> /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
> ```
> Then add it to your `PATH` (Apple Silicon shown; skip on Intel Macs where it's already on PATH):
> ```bash
> echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
> eval "$(/opt/homebrew/bin/brew shellenv)"
> ```
> Verify: `brew --version`
>
> **Windows users — `winget` is built in.** The Windows commands below use
> [winget](https://learn.microsoft.com/windows/package-manager/winget/), which ships
> with Windows 10 (1809+) and Windows 11 via the *App Installer*. If `winget` isn't found,
> install **App Installer** from the Microsoft Store, then verify: `winget --version`.
>
> **Linux users — use your package manager.** The Linux commands below assume a
> Debian/Ubuntu-style distro (`apt`) with `curl` available. If needed:
> ```bash
> sudo apt-get update && sudo apt-get install -y curl
> ```
> For other distros, substitute your package manager (`dnf`, `yum`, `zypper`, etc.).

| Tool | Purpose | Install (macOS - Homebrew) | Install (Windows) | Install (Linux) |
|------|---------|----------------------------|-------------------|-----------------|
| **Azure CLI** (`az`) | Sign in to Azure / AKS | `brew install azure-cli` | `winget install Microsoft.AzureCLI` | [docs](https://learn.microsoft.com/cli/azure/install-azure-cli-linux) |
| **kubectl** | Talk to the cluster | `brew install kubectl` | `winget install Kubernetes.kubectl` | `az aks install-cli` |
| **kubelogin** | AAD login plugin for kubectl (REQUIRED — cluster is Azure AD managed) | `brew install Azure/kubelogin/kubelogin` | `az aks install-cli` (bundles it) | `az aks install-cli` |

> **Why `kubelogin`?** This cluster uses **Azure AD (Entra ID)** authentication.
> Without `kubelogin`, `kubectl` cannot complete the AAD login handshake.

Verify installs:
```bash
az version
kubectl version --client
kubelogin --version
```

---

## 2. Sign in to Azure

```bash
az login --tenant e741d71c-c6b6-47b0-803c-0f3b32b07556
```

Set the correct subscription:
```bash
az account set --subscription "ACC-NPRD-32659-MLRNP"
```

---

## 3. Get cluster credentials (kubeconfig)

```bash
az aks get-credentials \
  --resource-group tdp-wst2-dev-app-aks-rg \
  --name tdp-wst2-dev-app-aks
```

Convert the kubeconfig to use AAD device/browser login via kubelogin:
```bash
kubelogin convert-kubeconfig -l azurecli
```

> `-l azurecli` reuses your existing `az login` token (simplest).
> Alternatively use `-l devicecode` for a browser device-code flow.

---

## 4. First connection (triggers AAD auth)

The **first** kubectl command opens an AAD login/consent (browser or device code).
After that your token is cached until it expires.

```bash
kubectl get pods -n tdp-2026
```

---

## 5. Everyday commands (always use `-n tdp-2026`)

### View resources
```bash
# List pods
kubectl get pods -n tdp-2026

# List pods with more detail (node, IP, status)
kubectl get pods -n tdp-2026 -o wide

# Watch pods live (updates as they change)
kubectl get pods -n tdp-2026 -w

# List everything common in the namespace
kubectl get all -n tdp-2026

# Deployments / services / configmaps / secrets
kubectl get deploy,svc,configmap,secret -n tdp-2026
```

### Inspect a specific pod
```bash
# Describe a pod (events, container status, why it's failing)
kubectl describe pod <pod-name> -n tdp-2026

# View logs
kubectl logs <pod-name> -n tdp-2026

# Follow logs live
kubectl logs -f <pod-name> -n tdp-2026

# Logs from a previous crashed container
kubectl logs <pod-name> -n tdp-2026 --previous

# If a pod has multiple containers, specify one
kubectl logs <pod-name> -c <container-name> -n tdp-2026
```

### Exec into a running pod (shell)
```bash
kubectl exec -it <pod-name> -n tdp-2026 -- /bin/sh
# or, if bash is available:
kubectl exec -it <pod-name> -n tdp-2026 -- /bin/bash
```

### Resource usage (if metrics-server is available)
```bash
kubectl top pods -n tdp-2026
```

### Make changes (you have read/write `edit`)
```bash
# Apply a manifest
kubectl apply -f my-deployment.yaml -n tdp-2026

# Restart a deployment (rolling restart)
kubectl rollout restart deployment/<deploy-name> -n tdp-2026

# Scale a deployment
kubectl scale deployment/<deploy-name> --replicas=2 -n tdp-2026

# Edit a resource in place
kubectl edit deployment/<deploy-name> -n tdp-2026

# Delete a pod (it will be recreated if managed by a Deployment)
kubectl delete pod <pod-name> -n tdp-2026
```

---

## 6. Tip: make `tdp-2026` your default namespace

So you don't have to type `-n tdp-2026` every time:
```bash
kubectl config set-context --current --namespace=tdp-2026
```
After this, `kubectl get pods` automatically targets `tdp-2026`.

---

## 7. Check your permissions
```bash
# See everything you're allowed to do in the namespace
kubectl auth can-i --list -n tdp-2026

# Check a specific action
kubectl auth can-i create pods -n tdp-2026     # -> yes
kubectl auth can-i get nodes                   # -> no (cluster-scoped, denied)
kubectl auth can-i get ns                       # -> no (listing namespaces denied)
```

---

## Troubleshooting

| Symptom | Cause / Fix |
|---------|-------------|
| `error: You must be logged in to the server (Unauthorized)` | Run `az login` again, then `kubelogin convert-kubeconfig -l azurecli` |
| `Error from server (Forbidden)` on `get ns` / `get nodes` | Expected — those are cluster-scoped and outside your access |
| `Forbidden` when using another namespace | Expected — you only have access to `tdp-2026` |
| `pods is forbidden: User "<you>@intl.att.com" cannot list resource "pods"` in `tdp-2026` | Your **Kubernetes RBAC** binding is missing or lists the wrong identity. This cluster authorizes by **UPN** (e.g. `no4411@intl.att.com`), not the AAD Object ID. An admin must add your **UPN** as a subject in the `tdp-2026-user-access` RoleBinding (see `tdp-2026-rbac.yaml`). |
| `(AuthorizationFailed) ... listClusterUserCredential` on `az aks get-credentials` | Your **Azure RBAC** is missing the **"Azure Kubernetes Service Cluster User Role"** on the cluster. The Reader role is not enough — an admin must grant it, then re-run `az login`. |
| kubectl hangs on first command | AAD browser/device-code prompt — complete the login in the opened browser or follow the device-code URL printed in the terminal |
| `kubelogin: command not found` | Install kubelogin (see Prerequisites) or run `az aks install-cli` |

---

## Quick reference (cluster facts)

| Item | Value |
|------|-------|
| Cluster | `tdp-wst2-dev-app-aks` |
| Resource group | `tdp-wst2-dev-app-aks-rg` |
| Subscription | `ACC-NPRD-32659-MLRNP` |
| Tenant ID | `e741d71c-c6b6-47b0-803c-0f3b32b07556` |
| Namespace | `tdp-2026` |
| Access level | `edit` (read/write within `tdp-2026` only) |
