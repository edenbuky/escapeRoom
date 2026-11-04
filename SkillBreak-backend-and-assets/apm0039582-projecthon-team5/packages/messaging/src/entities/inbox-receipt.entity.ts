import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ name: 'messaging_inbox_receipt' })
export class InboxReceipt {
  @PrimaryColumn({ type: 'varchar', length: 128 })
  consumer!: string;

  @PrimaryColumn({ name: 'message_id', type: 'varchar', length: 128 })
  messageId!: string;

  @Column({ name: 'processed_at', type: 'timestamptz', default: () => 'CURRENT_TIMESTAMP' })
  processedAt!: Date;
}
