import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `copilot_message` — cada turno de la conversación (user / assistant / tool).
 * `tool_calls` guarda, en JSONB, la traza de herramientas que el agente usó en
 * ese turno del asistente (qué llamó, con qué args, qué devolvió). Permite
 * mostrar la "traza de razonamiento" en la UI y reconstruir el historial.
 */
@Entity('copilot_message')
@Index('idx_copilot_msg_conv', ['conversationId', 'createdAt'])
export class CopilotMessage {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'conversation_id', type: 'uuid' })
  conversationId: string;

  /** system | user | assistant | tool */
  @Column({ type: 'varchar', length: 16 })
  role: string;

  @Column({ type: 'text' })
  content: string;

  /**
   * Traza de herramientas del turno (solo en `assistant`): array de
   * `{ tool, args, result, ok }`. Nulo si no hubo tools.
   */
  @Column({ name: 'tool_trace', type: 'jsonb', nullable: true })
  toolTrace: unknown | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
