# TDP 2026 — Microservice Template

The **`main`** branch is a **ready-to-clone template** for a Node.js microservice that
deploys to AKS with the full platform integration already wired:

- ✅ Helm chart (`projecthon-team5-chart/`) — Deployment, Service, ServiceAccount
- ✅ Azure Key Vault via **Secrets Store CSI Driver** (`secretproviderclass.yaml`)
- ✅ **Application Insights** telemetry (SDK in `src/index.js`, connection string
  pulled from Key Vault and injected as `APPLICATIONINSIGHTS_CONNECTION_STRING`)
- ✅ RevUp CI/CD pipelines (`.github/`)
- ✅ SonarQube + quality gates

The baseline service name used throughout is **`projecthon-team5`**.

---

## Create a new microservice from this template

1. **Branch off this template**

   ```bash
   git checkout main
   git pull
   git checkout -b polyrepo-<new-ms-name>
   ```

2. **Rename the service** (single find-and-replace of the base name)

   ```bash
   NEW=<new-ms-name>          # e.g. projecthon-team5-orders

   # rename the chart directory
   git mv projecthon-team5-chart ${NEW}-chart

   # replace the base name everywhere
   grep -rl 'projecthon-team5' --exclude-dir=.git . | while read f; do
     sed -i '' "s/projecthon-team5/${NEW}/g" "$f"
   done
   ```

3. **Set the target namespace** (the only per-MS infra knob)

   Edit `.github/variables/dev/cd_vars.yaml`:

   ```yaml
   namespace: '<your-namespace>'
   ```

4. **Verify locally**

   ```bash
   helm lint ./${NEW}-chart
   helm template ${NEW} ./${NEW}-chart -f ./${NEW}-chart/envs/dev.yaml
   ```

5. **Commit & push**, then open a PR.

---

## Per-environment Azure prerequisites

The following are **infrastructure** resources (not code). They must exist for the
CSI secret mount and telemetry to work. For `projecthon-team5` these were provisioned
manually; capture them in IaC for new services:

| Requirement | Notes |
|-------------|-------|
| Key Vault | RBAC-authorization enabled |
| KV **private endpoint** | in the AKS subnet, wired to `privatelink.vaultcore.azure.net` |
| KV RBAC role | `Key Vault Secrets User` granted to the AKS **agentpool** managed identity |
| KV secrets | e.g. `applicationinsights-connection-string` |
| App Insights | workspace-based, linked to the Log Analytics workspace |
| App Insights **AMPLS link** | AI component added to the Azure Monitor Private Link Scope, otherwise telemetry is blocked (403) on locked-down clusters |

## Enable / disable secrets

`secrets.enabled` lives in `<chart>/envs/<env>.yaml`. If a service consumes **no**
Key Vault secrets, set `secrets.enabled: false` — enabling CSI with an empty object
list causes a `missing object versions` mount failure.
