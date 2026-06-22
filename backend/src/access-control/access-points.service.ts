import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AccessPoint } from './entities/access-point.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import { SubjectAuthorization } from './entities/subject-authorization.entity';
import { TenantContext } from '../common/tenant/tenant-context.service';
import {
  AuthorizeSubjectDto,
  CreateAccessPointDto,
  UpdateAccessPointDto,
} from './dto/access-control.dto';

/** Vista pública de un Access_Point: sin `controllerRef` (secreto). */
export type AccessPointView = Omit<AccessPoint, 'controllerRef'>;

/**
 * `AccessPointsService` — gestión de puntos de acceso, umbrales y
 * autorizaciones. Ninguna lectura expone `controllerRef` (`toView` lo elimina).
 *
 * Producto de **puerta única**: por defecto (`AUTO_AUTHORIZE_ENROLLED=true`) un
 * empleado enrolado queda habilitado automáticamente en todas las puertas, sin
 * un paso manual de autorización. Se conserva el modelo de autorización (con
 * horario y auditoría) para escenarios multi-puerta y para revocar.
 */
@Injectable()
export class AccessPointsService {
  private readonly autoAuthorize: boolean;

  constructor(
    @InjectRepository(AccessPoint)
    private readonly accessPoints: Repository<AccessPoint>,
    @InjectRepository(SubjectAuthorization)
    private readonly authorizations: Repository<SubjectAuthorization>,
    @InjectRepository(EnrolledSubject)
    private readonly subjects: Repository<EnrolledSubject>,
    private readonly tenant: TenantContext,
    config: ConfigService,
  ) {
    this.autoAuthorize = config.get<string>('AUTO_AUTHORIZE_ENROLLED', 'true') !== 'false';
  }

  async create(dto: CreateAccessPointDto): Promise<AccessPointView> {
    const ap = this.accessPoints.create({
      name: dto.name,
      kind: dto.kind ?? 'PEDESTRIAN',
      cameraId: dto.cameraId ?? null,
      securityLevel: dto.securityLevel ?? 'NORMAL',
      matchThreshold: dto.matchThreshold ?? 0.5,
      livenessThreshold: dto.livenessThreshold ?? 0.7,
      controllerKind: dto.controllerKind ?? null,
      controllerRef: dto.controllerRef ?? null,
      status: 'ACTIVE',
      demoSessionId: this.tenant.demoSessionId(),
    });
    const saved = await this.accessPoints.save(ap);
    // Puerta nueva: habilita a los empleados ya enrolados (orden de alta libre).
    if (this.autoAuthorize) await this.authorizeAllActiveSubjectsAt(saved.id);
    return this.toView(saved);
  }

  async list(): Promise<AccessPointView[]> {
    const rows = await this.accessPoints.find({
      where: { demoSessionId: this.tenant.scopeValue() },
      order: { name: 'ASC' },
    });
    return rows.map((r) => this.toView(r));
  }

  async update(id: string, dto: UpdateAccessPointDto): Promise<AccessPointView> {
    const ap = await this.accessPoints.findOne({
      where: { id, demoSessionId: this.tenant.scopeValue() },
    });
    if (!ap) throw new NotFoundException('access_point_not_found');

    if (dto.name !== undefined) ap.name = dto.name;
    if (dto.securityLevel !== undefined) ap.securityLevel = dto.securityLevel;
    if (dto.matchThreshold !== undefined) ap.matchThreshold = dto.matchThreshold;
    if (dto.livenessThreshold !== undefined) ap.livenessThreshold = dto.livenessThreshold;
    if (dto.controllerKind !== undefined) ap.controllerKind = dto.controllerKind;
    if (dto.controllerRef !== undefined) ap.controllerRef = dto.controllerRef;
    if (dto.status !== undefined) ap.status = dto.status;

    return this.toView(await this.accessPoints.save(ap));
  }

  /** Autoriza (o re-autoriza) un sujeto en un punto, con horario opcional. */
  async authorize(dto: AuthorizeSubjectDto): Promise<SubjectAuthorization> {
    const existing = await this.authorizations.findOne({
      where: { subjectId: dto.subjectId, accessPointId: dto.accessPointId },
    });
    if (existing) {
      existing.schedule = (dto.schedule as never) ?? null;
      return this.authorizations.save(existing);
    }
    const auth = this.authorizations.create({
      subjectId: dto.subjectId,
      accessPointId: dto.accessPointId,
      schedule: (dto.schedule as never) ?? null,
    });
    return this.authorizations.save(auth);
  }

  /** Revoca la autorización de un sujeto en un punto. */
  async deauthorize(subjectId: string, accessPointId: string): Promise<void> {
    await this.authorizations.delete({ subjectId, accessPointId });
  }

  /**
   * Habilita a un empleado en TODAS las puertas (auto-autorización al enrolar).
   * Idempotente: no duplica autorizaciones existentes. No-op si la
   * auto-autorización está desactivada (`AUTO_AUTHORIZE_ENROLLED=false`).
   */
  async authorizeSubjectEverywhere(subjectId: string): Promise<void> {
    if (!this.autoAuthorize) return;
    const points = await this.accessPoints.find({
      where: { demoSessionId: this.tenant.scopeValue() },
    });
    for (const p of points) await this.ensureAuthorization(subjectId, p.id);
  }

  /** Habilita a todos los empleados ACTIVE en un punto recién creado. */
  private async authorizeAllActiveSubjectsAt(accessPointId: string): Promise<void> {
    const subs = await this.subjects.find({
      where: { status: 'ACTIVE', demoSessionId: this.tenant.scopeValue() },
    });
    for (const s of subs) await this.ensureAuthorization(s.id, accessPointId);
  }

  /** Crea la autorización (sin horario) si aún no existe. */
  private async ensureAuthorization(subjectId: string, accessPointId: string): Promise<void> {
    const exists = await this.authorizations.findOne({ where: { subjectId, accessPointId } });
    if (exists) return;
    await this.authorizations.save(
      this.authorizations.create({ subjectId, accessPointId, schedule: null }),
    );
  }

  private toView(ap: AccessPoint): AccessPointView {
    const { controllerRef: _omit, ...view } = ap;
    void _omit;
    return view;
  }
}
