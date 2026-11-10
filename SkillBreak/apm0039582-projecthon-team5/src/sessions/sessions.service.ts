import { createHash } from 'node:crypto';
import { ForbiddenException, Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { PlayerCommand, PuzzleInput } from '@team5/contracts';
import type { MessageProducer } from '@team5/contracts/server';
import { describeFailure } from '@team5/messaging';
import { SessionOwnerClient } from './session-owner.client';

export const SESSION_PUBLISHER = Symbol('SESSION_PUBLISHER');

export function commandIdentity(name: string): string {
  const namespace = '7a7dfa5509c65a08bf8e331572241135';
  const bytes = createHash('sha1').update(Buffer.from(namespace, 'hex')).update(name).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class UnavailableSessionPublisher implements MessageProducer {
  async publish(): Promise<void> { throw new Error('No game transport configured'); }
}

@Injectable()
export class SessionsService {
  private readonly logger = new Logger(SessionsService.name);

  constructor(
    @Inject(SESSION_PUBLISHER) private readonly publisher: MessageProducer,
    private readonly owners: SessionOwnerClient,
  ) {}

  private async publish(command: PlayerCommand): Promise<void> {
    try { await this.publisher.publish('player-commands', command); }
    catch (error) {
      this.logger.warn(`Game transport publish failed: ${describeFailure(error)}`);
      throw new ServiceUnavailableException('Game transport unavailable');
    }
  }

  async start(userId: string, scriptSlug: string, requestId: string) {
    const result = await this.owners.session('start', { userId: userId.toLowerCase(), scriptSlug, requestId: requestId.toLowerCase() });
    if (!result.sessionId) throw new ServiceUnavailableException('Session service unavailable');
    this.logger.log(`Start game requested sessionId=${result.sessionId} scriptSlug=${scriptSlug}`);
    return result;
  }

  resume(userId: string) { return this.owners.session(`users/${encodeURIComponent(userId)}/resume`); }

  private async authorize(userId: string, sessionId: string): Promise<void> {
    const owner = await this.owners.getOwner(sessionId);
    if (owner.ownerId !== userId.toLowerCase()) throw new ForbiddenException();
  }

  async submit(userId: string, sessionId: string, puzzleKey: string, commandId: string, input: PuzzleInput) {
    sessionId = sessionId.toLowerCase();
    commandId = commandId.toLowerCase();
    await this.authorize(userId, sessionId);
    await this.publish({ type: 'SubmitInput', messageId: commandIdentity(`${sessionId}:${commandId}`), sessionId,
      payload: { userId, puzzleKey, input } });
    return { commandId };
  }

  async abandon(userId: string, sessionId: string): Promise<void> {
    sessionId = sessionId.toLowerCase();
    await this.authorize(userId, sessionId);
    await this.publish({ type: 'AbandonSession', messageId: commandIdentity(`abandon:${sessionId}`), sessionId,
      payload: { userId } });
  }

  async door(userId: string, sessionId: string, roomKey: string, commandId: string, type: 'OpenDoor' | 'EnterRoom') {
    sessionId = sessionId.toLowerCase();
    await this.authorize(userId, sessionId);
    await this.publish({ type, messageId: commandIdentity(`${sessionId}:${commandId.toLowerCase()}`), sessionId,
      payload: { userId, roomKey } });
    return { commandId };
  }
}