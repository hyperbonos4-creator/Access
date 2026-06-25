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

  /**
   * Fotografía del estado del sistema tomada al cierre del último turno del
   * copiloto en esta conversación (JSONB). Permite que la tool `novedades`
   * calcule el diff contra la consulta anterior. Null si aún no hay turno
   * previo. Ver `ConversationSnapshot` para la forma del contenido.
   */
  @Column({ name: 'state_snapshot', type: 'jsonb', nullable: true })
  stateSnapshot: unknown | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
