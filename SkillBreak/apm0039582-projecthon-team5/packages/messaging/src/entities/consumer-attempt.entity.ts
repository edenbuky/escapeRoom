import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'messaging_consumer_attempt' })
export class ConsumerAttempt {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  consumer!: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Column({ name: 'attempt_count', type: 'smallint' })
  attemptCount!: number;

  @Column({ name: 'last_failure', type: 'varchar', length: 1024, nullable: true })
  lastFailure!: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt!: Date;
}
