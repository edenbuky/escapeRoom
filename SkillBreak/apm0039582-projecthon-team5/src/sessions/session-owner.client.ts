import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describeFailure } from '@team5/messaging';
import { isUUID } from 'class-validator';

export class SessionOwnerClient {
  private readonly logger = new Logger(SessionOwnerClient.name);

  constructor(private readonly baseUrl: string, private readonly token: string) {}

  async session(path: string, body?: object): Promise<{ sessionId: string | null }> {
    if (!this.token) throw new ServiceUnavailableException('Session service unavailable');
    try {
      const response = await fetch(`${this.baseUrl}/internal/sessions/${path}`, {
        method: body ? 'POST' : 'GET', headers: { 'x-internal-token': this.token, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000), redirect: 'error',
      });
      if (!response.ok) throw new Error('Session lookup failed');
      const result = await response.json() as { sessionId: unknown };
      if (result.sessionId !== null && (typeof result.sessionId !== 'string' || !isUUID(result.sessionId))) throw new Error('Invalid session identity');
      return { sessionId: result.sessionId as string | null };
    } catch { throw new ServiceUnavailableException('Session service unavailable'); }
  }

  async getOwner(sessionId: string): Promise<{ ownerId: string }> {
    if (!this.token) throw new ServiceUnavailableException('Session service unavailable');
    try {
      const response = await fetch(`${this.baseUrl}/internal/sessions/${encodeURIComponent(sessionId)}/owner`, {
        headers: { 'x-internal-token': this.token },
        signal: AbortSignal.timeout(2000),
        redirect: 'error',
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 404) throw new NotFoundException();
        throw new Error('Owner lookup failed');
      }
      const owner: unknown = await response.json();
      if (!owner || typeof owner !== 'object' || !('ownerId' in owner)
        || typeof owner.ownerId !== 'string' || !isUUID(owner.ownerId)) {
        throw new Error('Invalid owner response');
      }
      return { ownerId: owner.ownerId.toLowerCase() };
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.warn(`Session owner lookup failed: ${describeFailure(error)}`);
      throw new ServiceUnavailableException('Session service unavailable');
    }
  }
}