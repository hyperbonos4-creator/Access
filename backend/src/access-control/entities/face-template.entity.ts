import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * `face_templates` — metadatos de una plantilla facial. El embedding crudo
 * NUNCA vive aquí: solo `vectorPointId` (referencia opaca al punto en Qdrant) y
 * metadatos (modelo, dimensión, calidad). Privacidad por diseño.
 */
@Entity('face_templates')
@Index('idx_face_templates_subject', ['subjectId'])
export class FaceTemplate {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  /** Id del punto en Qdrant. */
  @Column({ name: 'vector_point_id', type: 'varchar', length: 64 })
  vectorPointId: string;

  /** ARCFACE | ADAFACE */
  @Column({ type: 'varchar', length: 24, default: 'ARCFACE' })
  model: string;

  @Column({ type: 'smallint', default: 512 })
  dim: number;

  @Column({ type: 'numeric', precision: 5, scale: 4, nullable: true })
  quality: number | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
