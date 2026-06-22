import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { BiometricConsent } from './entities/biometric-consent.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import { FaceTemplate } from './entities/face-template.entity';
import { VisionServiceClient } from './vision-service.client';

export interface GrantConsentInput {
  purpose: string;
  policyVersion: string;
  ipAddress?: string | null;
  userAgent?: string | null;
  signature?: string | null;
}

/**
 * `ConsentService` — gestión del consentimiento biométrico.
 *
 * Invariantes:
 * - Sin un Biometric_Consent `ACTIVE` no puede generarse un Face_Template.
 * - Revocar el consentimiento elimina TODOS los Face_Templates del sujeto
 *   (Qdrant + metadatos), de forma verificable (fail-loud: si Qdrant no
 *   confirma el borrado, se propaga el error y NO se deja biometría huérfana).
 */
@Injectable()
export class ConsentService {
  private readonly logger = new Logger(ConsentService.name);

  constructor(
    @InjectRepository(BiometricConsent)
    private readonly consents: Repository<BiometricConsent>,
    @InjectRepository(EnrolledSubject)
    private readonly subjects: Repository<EnrolledSubject>,
    @InjectRepository(FaceTemplate)
    private readonly templates: Repository<FaceTemplate>,
    private readonly vision: VisionServiceClient,
  ) {}

  /** ¿El sujeto tiene un consentimiento vigente? */
  async hasActiveConsent(subjectId: string): Promise<boolean> {
    const count = await this.consents.count({ where: { subjectId, status: 'ACTIVE' } });
    return count > 0;
  }

  /** Registra un consentimiento explícito previo al enrolamiento. */
  async grant(
    subjectId: string,
    input: GrantConsentInput,
    actorId: string,
  ): Promise<BiometricConsent> {
    await this.assertSubject(subjectId);
    const consent = this.consents.create({
      subjectId,
      purpose: input.purpose,
      policyVersion: input.policyVersion,
      status: 'ACTIVE',
      grantedBy: actorId,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      signature: input.signature ?? null,
    });
    return this.consents.save(consent);
  }

  /** Revoca el consentimiento y borra en cascada las plantillas del sujeto. */
  async revoke(subjectId: string): Promise<{ revoked: boolean; deletedTemplates: number }> {
    await this.assertSubject(subjectId);
    const deleted = await this.purgeTemplates(subjectId);
    await this.consents.update(
      { subjectId, status: 'ACTIVE' },
      { status: 'REVOKED', revokedAt: new Date() },
    );
    this.logger.log(`Consentimiento revocado (subject=${subjectId}); ${deleted} plantillas eliminadas`);
    return { revoked: true, deletedTemplates: deleted };
  }

  /** Elimina todos los Face_Templates de un sujeto (Vector_Store + metadatos). */
  async purgeTemplates(subjectId: string): Promise<number> {
    const rows = await this.templates.find({ where: { subjectId } });
    for (const row of rows) {
      await this.vision.deleteTemplate(row.vectorPointId); // fail-loud
    }
    if (rows.length > 0) await this.templates.delete({ subjectId });
    return rows.length;
  }

  private async assertSubject(subjectId: string): Promise<EnrolledSubject> {
    const subject = await this.subjects.findOne({ where: { id: subjectId } });
    if (!subject) throw new NotFoundException('enrolled_subject_not_found');
    return subject;
  }
}
