import { Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { describeFailure } from '@team5/messaging';
import { isUUID } from 'class-validator';

export class SessionOwnerClient {
  private readonly logger = new Logger(SessionOwnerClient.name);

  constructor(private readonly baseUrl: string, private readonly token: string) {}

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