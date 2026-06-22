import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { ConsentService } from './consent.service';
import { AccessPointsService } from './access-points.service';
import { AccessEvent } from './entities/access-event.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import { FaceTemplate } from './entities/face-template.entity';
import { VisionServiceClient } from './vision-service.client';
import { TenantContext } from '../common/tenant/tenant-context.service';

export interface CreateSubjectInput {
  fullName: string;
  kind?: string; // EMPLOYEE | CONTRACTOR | STAFF
  employeeCode?: string | null;
}

export interface UpdateSubjectInput {
  fullName?: string;
  employeeCode?: string | null;
  status?: string; // ACTIVE | DISABLED
}

/**
 * `EnrollmentService` — alta/baja de empleados y enrolamiento facial.
 *
 * Reglas:
 * - El enrolamiento exige un Biometric_Consent `ACTIVE` previo: sin
 *   consentimiento NO se envía la imagen al Vision_Service.
 * - Solo se persisten metadatos + `vectorPointId`; el embedding nunca toca
 *   Postgres.
 * - Un rechazo de calidad del Vision (`NO_FACE`/`MULTIPLE_FACES`/`LOW_QUALITY`/
 *   `SPOOF_SUSPECTED`) se traduce en 400 sin crear plantilla.
 */
@Injectable()
export class EnrollmentService {
  private readonly logger = new Logger(EnrollmentService.name);
  private readonly dedupCheck: boolean;
  private readonly dedupThreshold: number;

  constructor(
    @InjectRepository(EnrolledSubject)
    private readonly subjects: Repository<EnrolledSubject>,
    @InjectRepository(FaceTemplate)
    private readonly templates: Repository<FaceTemplate>,
    @InjectRepository(AccessEvent)
    private readonly accessEvents: Repository<AccessEvent>,
    private readonly consents: ConsentService,
    private readonly vision: VisionServiceClient,
    private readonly accessPoints: AccessPointsService,
    private readonly tenant: TenantContext,
    config: ConfigService,
  ) {
    // Anti-duplicados: impide que un mismo rostro se registre en 2+ identidades.
    this.dedupCheck = config.get<string>('ENROLL_DEDUP_CHECK', 'true') !== 'false';
    this.dedupThreshold = config.get<number>('ENROLL_DEDUP_THRESHOLD', 0.6);
  }

  async createSubject(input: CreateSubjectInput): Promise<EnrolledSubject> {
    const subject = this.subjects.create({
      fullName: input.fullName,
      kind: input.kind ?? 'EMPLOYEE',
      employeeCode: input.employeeCode ?? null,
      status: 'ACTIVE',
      demoSessionId: this.tenant.demoSessionId(),
    });
    return this.subjects.save(subject);
  }

  listSubjects(): Promise<EnrolledSubject[]> {
    return this.subjects.find({
      where: { demoSessionId: this.tenant.scopeValue() },
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Lista de empleados con su estado operativo para la consola: biometría
   * registrada, consentimiento vigente y último acceso concedido. Pensado para
   * que el administrador vea de un vistazo "quién puede entrar".
   */
  async listSubjectsDetailed(): Promise<
    Array<
      EnrolledSubject & {
        hasBiometrics: boolean;
        templateCount: number;
        hasConsent: boolean;
        lastAccessAt: Date | null;
      }
    >
  > {
    const subjects = await this.subjects.find({
      where: { demoSessionId: this.tenant.scopeValue() },
      order: { createdAt: 'DESC' },
    });
    return Promise.all(
      subjects.map(async (s) => {
        const [templateCount, hasConsent, lastEvent] = await Promise.all([
          this.templates.count({ where: { subjectId: s.id } }),
          this.consents.hasActiveConsent(s.id),
          this.accessEvents.findOne({
            where: { subjectId: s.id, decision: 'GRANTED' },
            order: { recordedAt: 'DESC' },
          }),
        ]);
        return {
          ...s,
          hasBiometrics: templateCount > 0,
          templateCount,
          hasConsent,
          lastAccessAt: lastEvent?.recordedAt ?? null,
        };
      }),
    );
  }

  async getSubject(subjectId: string): Promise<EnrolledSubject> {
    const subject = await this.subjects.findOne({
      where: { id: subjectId, demoSessionId: this.tenant.scopeValue() },
    });
    if (!subject) throw new NotFoundException('enrolled_subject_not_found');
    return subject;
  }

  async updateSubject(subjectId: string, input: UpdateSubjectInput): Promise<EnrolledSubject> {
    const subject = await this.getSubject(subjectId);
    if (input.fullName !== undefined) subject.fullName = input.fullName;
    if (input.employeeCode !== undefined) subject.employeeCode = input.employeeCode;
    if (input.status !== undefined) subject.status = input.status;
    return this.subjects.save(subject);
  }

  // ── Enrolamiento ─────────────────────────────────────────────────────
  async enroll(subjectId: string, imageB64: string): Promise<FaceTemplate> {
    await this.getSubject(subjectId);

    const consented = await this.consents.hasActiveConsent(subjectId);
    if (!consented) throw new ForbiddenException('no_active_consent');

    // Anti-duplicados: un mismo rostro no puede pertenecer a dos identidades.
    // Si el rostro ya coincide con OTRO sujeto por encima del umbral, se rechaza
    // (evita que el kiosko "dude" entre identidades clonadas).
    if (this.dedupCheck) {
      try {
        const rec = await this.vision.recognize(imageB64, { matchThreshold: this.dedupThreshold });
        if (
          rec.face &&
          rec.label &&
          rec.label !== 'unknown' &&
          rec.label !== subjectId &&
          rec.score >= this.dedupThreshold
        ) {
          const other = await this.subjects.findOne({ where: { id: rec.label } });
          this.logger.warn(
            `Enrolamiento RECHAZADO por duplicado: rostro de subject=${subjectId} coincide con ${rec.label} (score=${rec.score})`,
          );
          throw new ConflictException({
            code: 'face_already_enrolled',
            reason: 'face_already_enrolled',
            message: other
              ? `Este rostro ya está registrado como "${other.fullName}". Una persona solo puede tener una identidad.`
              : 'Este rostro ya está registrado en otra identidad.',
          });
        }
      } catch (e) {
        if (e instanceof ConflictException) throw e;
        // Si el chequeo falla por otra causa (vision caído), no bloquea el alta.
        this.logger.warn(`Chequeo anti-duplicados omitido: ${(e as Error).message}`);
      }
    }

    const result = await this.vision.enroll(subjectId, imageB64);
    if (!result.ok || !result.vectorPointId) {
      throw new BadRequestException({
        code: 'enrollment_rejected',
        reason: result.reason ?? 'UNKNOWN',
      });
    }

    const template = this.templates.create({
      subjectId,
      vectorPointId: result.vectorPointId,
      model: result.model ?? 'ARCFACE',
      dim: result.dim ?? 512,
      quality: result.quality ?? null,
    });
    const saved = await this.templates.save(template);
    this.logger.log(`Plantilla enrolada (subject=${subjectId}, point=${saved.vectorPointId})`);

    // Puerta única: un empleado enrolado queda habilitado automáticamente en las
    // puertas (sin paso manual). Configurable con AUTO_AUTHORIZE_ENROLLED=false.
    await this.accessPoints.authorizeSubjectEverywhere(subjectId);
    return saved;
  }

  listTemplates(subjectId: string): Promise<FaceTemplate[]> {
    return this.templates.find({ where: { subjectId } });
  }

  /** Borra una plantilla concreta (vector + metadatos), validando pertenencia. */
  async deleteTemplate(subjectId: string, templateId: string): Promise<void> {
    const template = await this.templates.findOne({ where: { id: templateId, subjectId } });
    if (!template) throw new NotFoundException('face_template_not_found');
    await this.vision.deleteTemplate(template.vectorPointId);
    await this.templates.delete({ id: templateId });
  }

  /** Derecho de supresión: borra toda la biometría del sujeto y lo deshabilita. */
  async eraseBiometrics(subjectId: string): Promise<{ deletedTemplates: number }> {
    await this.getSubject(subjectId);
    const { deletedTemplates } = await this.consents.revoke(subjectId);
    await this.subjects.update({ id: subjectId }, { status: 'DISABLED' });
    return { deletedTemplates };
  }
}
