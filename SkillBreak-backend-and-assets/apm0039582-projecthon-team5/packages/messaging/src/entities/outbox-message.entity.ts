import type { GameEvent, PlayerCommand } from '@team5/contracts';
import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

export type MessageStream = 'player-commands' | 'game-events';
export type OutgoingPayload = PlayerCommand | GameEvent;

@Entity({ name: 'messaging_outbox' })
@Index('IDX_messaging_outbox_pending_order', ['publishedAt', 'createdAt', 'messageId'])
export class OutboxMessage {
  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Column({ type: 'varchar', length: 32 })
  stream!: MessageStream;

  @Column({ name: 'session_id', type: 'varchar', length: 128 })
  sessionId!: string;

  @Column({ type: 'jsonb' })
  payload!: OutgoingPayload;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  createdAt!: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;
}
