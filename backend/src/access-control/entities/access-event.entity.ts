import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `access_events` — registro append-only de cada intento de acceso, concedido o
 * denegado, con su motivo auditable. Es la bitácora de la puerta.
 */
@Entity('access_events')
@Index('idx_access_events_recorded', ['recordedAt'])
@Index('idx_access_events_point', ['accessPointId', 'recordedAt'])
export class AccessEvent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'access_point_id', type: 'uuid' })
  accessPointId: string;

  /** Sesión de demo efímera (aislamiento del demo público), o `null`. */
  @Column({ name: 'demo_session_id', type: 'uuid', nullable: true })
  demoSessionId: string | null;

  /** NULL => desconocido (`unknown`). */
  @Column({ name: 'subject_id', type: 'uuid', nullable: true })
  subjectId: string | null;

  @Column({ name: 'match_score', type: 'numeric', precision: 5, scale: 4, nullable: true })
  matchScore: number | null;

  @Column({ name: 'liveness_score', type: 'numeric', precision: 5, scale: 4, nullable: true })
  livenessScore: number | null;

  /** PASSIVE | ACTIVE */
  @Column({ name: 'liveness_mode', type: 'varchar', length: 8, nullable: true })
  livenessMode: string | null;

  /** GRANTED | DENIED */
  @Column({ type: 'varchar', length: 8 })
  decision: string;

  /** MATCHED | UNKNOWN_SUBJECT | LIVENESS_FAILED | CHALLENGE_REQUIRED | NOT_AUTHORIZED | OUT_OF_SCHEDULE | NO_CONSENT | MANUAL */
  @Column({ type: 'varchar', length: 24 })
  reason: string;

  @Column({ name: 'door_actuated', type: 'boolean', default: false })
  doorActuated: boolean;

  /** Operador que autorizó una apertura manual. */
  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId: string | null;

  @Column({ name: 'snapshot_url', type: 'text', nullable: true })
  snapshotUrl: string | null;

  @Column({ name: 'recorded_at', type: 'timestamptz' })
  recordedAt: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
