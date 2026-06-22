import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * `cameras` — cámara IP de la puerta. El `rtspUrl` embebe host y credenciales
 * (de ahí se derivan host/usuario/clave para el snapshot ISAPI); es SECRETO y
 * nunca se serializa al cliente. `externalKey` identifica la cámara ante el
 * Vision_Service.
 */
@Entity('cameras')
export class Camera {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  /** rtsp://user:pass@host:554/... — SECRETO. No se devuelve al cliente. */
  @Column({ name: 'rtsp_url', type: 'text' })
  rtspUrl: string;

  /** Clave externa para el Vision_Service (opcional). */
  @Column({ name: 'external_key', type: 'varchar', length: 120, nullable: true })
  externalKey: string | null;

  /** Canal de NVR (0/null = cámara directa; >0 = nvrChannel*100 + canal). */
  @Column({ name: 'nvr_channel', type: 'int', nullable: true })
  nvrChannel: number | null;

  /** ACTIVE | DISABLED */
  @Column({ type: 'varchar', length: 12, default: 'ACTIVE' })
  status: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
