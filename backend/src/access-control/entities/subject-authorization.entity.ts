import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Ventana horaria permitida (JSONB). `null`/ausente => 24/7. */
export interface AuthorizationSchedule {
  /** Días permitidos (0=domingo..6=sábado). Vacío/ausente => todos. */
  days?: number[];
  /** Hora inicio "HH:mm". */
  from?: string;
  /** Hora fin "HH:mm". */
  to?: string;
}

/**
 * `subject_authorizations` — autorización de un empleado en un punto de acceso,
 * con horario opcional (ej. solo lunes-viernes 7:00-20:00). La decisión de
 * acceso valida autorización + franja horaria.
 */
@Entity('subject_authorizations')
@Index('uq_subject_auth', ['subjectId', 'accessPointId'], { unique: true })
export class SubjectAuthorization {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  @Column({ name: 'access_point_id', type: 'uuid' })
  accessPointId: string;

  @Column({ type: 'jsonb', nullable: true })
  schedule: AuthorizationSchedule | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
