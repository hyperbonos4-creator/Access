import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `copilot_audit` — registro **append-only** de cada herramienta que el copiloto
 * ejecutó. Atribuye la acción al `user_id` del admin que la disparó, igual que
 * `access_events.actorId`. Es la bitácora de "qué hizo el agente en mi nombre".
 *
 * Solo se inserta; nunca se actualiza ni borra desde el código.
 */
@Entity('copilot_audit')
@Index('idx_copilot_audit_user', ['userId', 'createdAt'])
@Index('idx_copilot_audit_tool', ['tool', 'createdAt'])
export class CopilotAudit {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ name: 'conversation_id', type: 'uuid', nullable: true })
  conversationId: string | null;

  /** Nombre de la herramienta ejecutada. */
  @Column({ type: 'varchar', length: 64 })
  tool: string;

  /** Argumentos con los que se llamó (JSON). */
  @Column({ type: 'jsonb', nullable: true })
  args: unknown | null;

  /** Resumen del resultado (recortado; nunca secreto). */
  @Column({ name: 'result_summary', type: 'text', nullable: true })
  resultSummary: string | null;

  /** false si la herramienta lanzó error. */
  @Column({ type: 'boolean', default: true })
  ok: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
