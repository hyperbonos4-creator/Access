import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `copilot_conversation` — una conversación de un usuario con el copiloto
 * interno. Agrupa los mensajes y se titula con el primer turno del usuario.
 * Aislada por `user_id` (cada admin ve solo la suya).
 */
@Entity('copilot_conversation')
@Index('idx_copilot_conv_user', ['userId', 'updatedAt'])
export class CopilotConversation {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar', length: 160 })
  title: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
