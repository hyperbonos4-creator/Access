import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `enrolled_subjects` — empleado autorizado para acceso facial. El padrón
 * biométrico (vectores) vive en Qdrant; aquí solo la identidad de dominio.
 *
 * Simplificado del modelo residencial de URBAN: sin `conjuntoId` ni flujo de
 * doble aprobación; el ADMIN enrola directamente al empleado.
 */
@Entity('enrolled_subjects')
export class EnrolledSubject {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'full_name', type: 'varchar', length: 160 })
  fullName: string;

  /** EMPLOYEE | CONTRACTOR | STAFF */
  @Column({ type: 'varchar', length: 16, default: 'EMPLOYEE' })
  kind: string;

  /** Identificador interno del empleado (legajo), opcional. */
  @Column({ name: 'employee_code', type: 'varchar', length: 64, nullable: true })
  employeeCode: string | null;

  /** ACTIVE | DISABLED — gate operativo de acceso. */
  @Column({ type: 'varchar', length: 12, default: 'ACTIVE' })
  status: string;

  /** Sesión de demo efímera (aislamiento del demo público), o `null`. */
  @Column({ name: 'demo_session_id', type: 'uuid', nullable: true })
  demoSessionId: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
