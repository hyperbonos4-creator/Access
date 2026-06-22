import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `biometric_consents` — consentimiento explícito, previo e informado para el
 * tratamiento del dato facial del empleado (Ley 1581 CO / buenas prácticas de
 * biometría). Sin un consentimiento `ACTIVE` no puede existir un Face_Template.
 */
@Entity('biometric_consents')
@Index('idx_biometric_consents_subject', ['subjectId'])
export class BiometricConsent {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'subject_id', type: 'uuid' })
  subjectId: string;

  /** Finalidad acotada del tratamiento. */
  @Column({ type: 'varchar', length: 200 })
  purpose: string;

  @Column({ name: 'policy_version', type: 'varchar', length: 32 })
  policyVersion: string;

  /** ACTIVE | REVOKED */
  @Column({ type: 'varchar', length: 12, default: 'ACTIVE' })
  status: string;

  /** Actor que registró el consentimiento. */
  @Column({ name: 'granted_by', type: 'uuid', nullable: true })
  grantedBy: string | null;

  @Column({ name: 'granted_at', type: 'timestamptz', default: () => 'NOW()' })
  grantedAt: Date;

  @Column({ name: 'revoked_at', type: 'timestamptz', nullable: true })
  revokedAt: Date | null;

  @Column({ name: 'ip_address', type: 'varchar', length: 64, nullable: true })
  ipAddress: string | null;

  @Column({ name: 'user_agent', type: 'varchar', length: 256, nullable: true })
  userAgent: string | null;

  @Column({ type: 'text', nullable: true })
  signature: string | null;
}
