import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `access_points` — punto físico de acceso (la puerta). Asociado a una Camera y
 * a un Door_Controller (relé/maglock). Guarda los umbrales efectivos de
 * match/liveness y el nivel de seguridad.
 *
 * `controllerRef` (URL/secreto del relé) NUNCA se expone al cliente.
 */
@Entity('access_points')
export class AccessPoint {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** PEDESTRIAN (única modalidad de la oficina). */
  @Column({ type: 'varchar', length: 16, default: 'PEDESTRIAN' })
  kind: string;

  @Column({ name: 'camera_id', type: 'uuid', nullable: true })
  cameraId: string | null;

  /** NORMAL | HIGH (HIGH exige reto activo de liveness). */
  @Column({ name: 'security_level', type: 'varchar', length: 8, default: 'NORMAL' })
  securityLevel: string;

  @Column({ name: 'match_threshold', type: 'numeric', precision: 5, scale: 4, default: 0.5 })
  matchThreshold: number;

  @Column({ name: 'liveness_threshold', type: 'numeric', precision: 5, scale: 4, default: 0.7 })
  livenessThreshold: number;

  /** RELAY | HTTP | HIKVISION_ISAPI | SIMULATED | NONE */
  @Column({ name: 'controller_kind', type: 'varchar', length: 16, nullable: true })
  controllerKind: string | null;

  /** Referencia/credencial del actuador. SECRETO — nunca se serializa. */
  @Column({ name: 'controller_ref', type: 'varchar', length: 200, nullable: true })
  controllerRef: string | null;

  /** ACTIVE | DISABLED */
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
