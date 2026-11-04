import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logger } from '@nestjs/common';
import { KubernetesDriver } from './kubernetes-driver';
import { SandboxExecutionError } from './sandbox-errors';

async function main(): Promise<void> {
  if (process.env.SANDBOX_KUBE_CONTEXT !== 'kind-skillbreak-local' || !process.env.KUBECONFIG) {
    throw new SandboxExecutionError('runtimeUnavailable');
  }
  const image = process.env.SANDBOX_SQL_IMAGE
    ?? readFileSync(resolve(__dirname, '../../../../../.local/sql-sandbox-image-ref'), 'utf8').trim();
  const allowlist = process.env.SANDBOX_IMAGE_ALLOWLIST?.split(',').map(value => value.trim()).filter(Boolean) ?? [];
  const driver = new KubernetesDriver({ runtimeClass: process.env.SANDBOX_RUNTIME_CLASS ?? 'runc',
    kubeContext: process.env.SANDBOX_KUBE_CONTEXT, imageAllowlist: allowlist });
  const report = await driver.preflight(image);
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

void main().catch((error: unknown) => {
  new Logger('SandboxRuntimeCheck').error(error instanceof SandboxExecutionError ? error.code : 'preflightFailed');
  process.exitCode = 1;
});
