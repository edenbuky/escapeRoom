import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Role } from '../../config/config';

export enum UserStatus {
  ACTIVE = 'active',
  DISABLED = 'disabled',
  DELETED = 'deleted',
}

@Entity({ name: 'users' })
@Check('ck_users_username', `username ~ '^[a-z0-9_.-]{3,32}$'`)
@Check('ck_users_email', 'email = lower(btrim(email))')
@Check('ck_users_display_name', 'char_length(display_name) BETWEEN 1 AND 64')
@Check('ck_users_token_version', 'token_version >= 0')
@Check('ck_users_deleted_at', "(status = 'deleted') = (deleted_at IS NOT NULL)")
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 32, unique: true })
  username!: string;

  @Column({ type: 'varchar', length: 254, unique: true })
  email!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 64 })
  displayName!: string;

  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash!: string;

  @Column({ type: 'enum', enum: Role, enumName: 'user_role', default: Role.PLAYER })
  role!: Role;

  @Column({ type: 'enum', enum: UserStatus, enumName: 'user_status', default: UserStatus.ACTIVE })
  status!: UserStatus;

  @Column({ name: 'token_version', type: 'integer', default: 0 })
  tokenVersion!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;
}