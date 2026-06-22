import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `demo_sessions` — sesión de demostración pública, efímera y aislada.
 *
 * Cada visitante que pulsa "Probar demo" obtiene una sesión propia con
 * credenciales únicas. Todo lo que cree (identidades, rostros en Qdrant, puntos,
 * eventos) queda etiquetado con esta `id` y se **autodestruye** al expirar
 * (`expiresAt`), liberando Postgres y la colección Qdrant `faces_demo_<id>`.
 *
 * Nunca se almacena la contraseña en claro: solo se entrega una vez al crearse
 * (el hash vive en el `User` asociado).
 */
@Entity('demo_sessions')
@Index('idx_demo_sessions_expiry', ['status', 'expiresAt'])
export class DemoSession {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Email único del usuario de la sesión (demo-<slug>@visionyx.lat). */
  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  /** Etiqueta legible para la UI (p. ej. "Invitado a3f9"). */
  @Column({ name: 'display_name', type: 'varchar', length: 80 })
  displayName: string;

  /** Punto de acceso por defecto creado para la sesión (para el kiosko). */
  @Column({ name: 'access_point_id', type: 'uuid', nullable: true })
  accessPointId: string | null;

  /** ACTIVE | EXPIRED | PURGED */
  @Column({ type: 'varchar', length: 12, default: 'ACTIVE' })
  status: string;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt: Date;

  @Column({ name: 'purged_at', type: 'timestamptz', nullable: true })
  purgedAt: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
