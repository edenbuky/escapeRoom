import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'messaging_dead_letter' })
export class DeadLetter {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  consumer!: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Column({ name: 'attempt_count', type: 'smallint' })
  attemptCount!: number;

  @Column({ name: 'failure_details', type: 'varchar', length: 1024 })
  failureDetails!: string;

  @Column({ name: 'failed_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  failedAt!: Date;
}
