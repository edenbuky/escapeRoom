import type { ProvisionJob, SandboxIdentity } from './sandbox.contracts';

/** The runtime object the worker tracks for one sandbox: a Kubernetes pod, or an in-process instance. */
export interface SandboxResource {
  metadata?: { uid?: string };
  status?: { phase?: string };
}

export type HelperMode = 'ready' | 'query' | 'status' | 'cancel' | 'inspect';

/**
 * Where sandboxes run. SandboxWorker and SandboxExecutorService own the lifecycle (provision, ready, exec,
 * destroy) and call only these methods. KubernetesDriver runs each sandbox as a pod (DESIGN-v2 §7);
 * EmbeddedDriver runs it inside the engine process (docs/adr/0001-embedded-sandbox-driver.md).
 */
export interface SandboxDriver {
  validateImage(image: string): void;
  confirmAbsent(identity: SandboxIdentity): Promise<boolean>;
  checkAvailable(): Promise<void>;
  read(job: ProvisionJob, uid?: string): Promise<SandboxResource | null>;
  ensure(job: ProvisionJob): Promise<SandboxResource>;
  remove(job: ProvisionJob, uid: string): Promise<void>;
  helper(job: ProvisionJob, uid: string, mode: HelperMode, input?: Record<string, unknown>, timeoutMs?: number): Promise<unknown>;
  preflight(image: string): Promise<unknown>;
}

export const SANDBOX_DRIVER = Symbol('SANDBOX_DRIVER');
