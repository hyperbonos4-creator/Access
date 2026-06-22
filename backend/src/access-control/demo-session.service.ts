import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { In, LessThanOrEqual, Repository } from 'typeorm';
import { randomBytes, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcrypt';

import { User, UserRole } from '../auth/entities/user.entity';
import { TenantContext } from '../common/tenant/tenant-context.service';
import { VisionServiceClient } from './vision-service.client';
import { AccessEvent } from './entities/access-event.entity';
import { AccessPoint } from './entities/access-point.entity';
import { BiometricConsent } from './entities/biometric-consent.entity';
import { DemoSession } from './entities/demo-session.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import { FaceTemplate } from './entities/face-template.entity';
import { SubjectAuthorization } from './entities/subject-authorization.entity';

/** Credenciales y metadatos devueltos al visitante al aprovisionar un demo. */
export interface DemoSessionTicket {
  sessionId: string;
  email: string;
  password: string;
  displayName: string;
  pointId: string;
  expiresAt: string;
  ttlMinutes: number;
}

/**
 * `DemoSessionService` — multi-tenencia EFÍMERA del demo público.
 *
 * Aprovisiona una sesión aislada por visitante (usuario+clave únicos, su propio
 * punto de acceso, su propia colección de rostros en Qdrant) y la
 * **autodestruye** al expirar: un barrido periódico borra por completo del
 * servidor todo lo que la sesión creó (Postgres + Qdrant). Nadie ve los datos
 * (ni los rostros) de otra persona, y nada queda acumulado.
 */
@Injectable()
export class DemoSessionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DemoSessionService.name);
  private readonly enabled: boolean;
  private readonly ttlMinutes: number;
  private readonly maxActive: number;
  private readonly sweepMs: number;
  private readonly emailDomain: string;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    @InjectRepository(DemoSession)
    private readonly sessions: Repository<DemoSession>,
    @InjectRepository(User)
    private readonly users: Repository<User>,
    @InjectRepository(EnrolledSubject)
    private readonly subjects: Repository<EnrolledSubject>,
    @InjectRepository(AccessPoint)
    private readonly points: Repository<AccessPoint>,
    @InjectRepository(AccessEvent)
    private readonly events: Repository<AccessEvent>,
    @InjectRepository(FaceTemplate)
    private readonly templates: Repository<FaceTemplate>,
    @InjectRepository(SubjectAuthorization)
    private readonly authorizations: Repository<SubjectAuthorization>,
    @InjectRepository(BiometricConsent)
    private readonly consents: Repository<BiometricConsent>,
    private readonly vision: VisionServiceClient,
    private readonly tenant: TenantContext,
    config: ConfigService,
  ) {
    this.enabled = config.get<string>('DEMO_MODE', 'false') === 'true';
    this.ttlMinutes = Math.max(5, Number(config.get('DEMO_TTL_MINUTES', 60)));
    this.maxActive = Math.max(1, Number(config.get('DEMO_MAX_ACTIVE_SESSIONS', 40)));
    this.sweepMs = Math.max(15, Number(config.get('DEMO_SWEEP_SECONDS', 60))) * 1000;
    this.emailDomain = config.get<string>('DEMO_EMAIL_DOMAIN', 'demo.visionyx.lat');
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    // Barrido inicial (captura sesiones expiradas mientras el backend estuvo
    // caído) + barrido periódico de autodestrucción.
    void this.sweepExpired().catch((e) => this.logger.warn(`Barrido inicial: ${e.message}`));
    this.sweepTimer = setInterval(() => {
      void this.sweepExpired().catch((e) => this.logger.warn(`Barrido: ${e.message}`));
    }, this.sweepMs);
    this.logger.log(
      `Demo efímero ACTIVO · TTL=${this.ttlMinutes}min · máx ${this.maxActive} sesiones · barrido cada ${this.sweepMs / 1000}s`,
    );
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** Aprovisiona una sesión de demo aislada y devuelve sus credenciales únicas. */
  async provision(): Promise<DemoSessionTicket> {
    if (!this.enabled) throw new ServiceUnavailableException('demo_disabled');

    const active = await this.sessions.count({
      where: { status: 'ACTIVE' },
    });
    if (active >= this.maxActive) {
      throw new ServiceUnavailableException({
        code: 'demo_capacity',
        message:
          'El demo está al máximo de sesiones activas en este momento. Intenta de nuevo en unos minutos.',
      });
    }

    const sessionId = randomUUID();
    const slug = sessionId.slice(0, 4) + randomBytes(2).toString('hex');
    const email = `demo-${slug}@${this.emailDomain}`.toLowerCase();
    const displayName = `Invitado ${slug.slice(0, 4).toUpperCase()}`;
    const password = this.friendlyPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const expiresAt = new Date(Date.now() + this.ttlMinutes * 60_000);

    // 1) Registro de la sesión (ancla del aislamiento y de la purga).
    const session = await this.sessions.save(
      this.sessions.create({ id: sessionId, email, displayName, status: 'ACTIVE', expiresAt }),
    );

    // 2) Usuario ADMIN propio de la sesión (credenciales únicas).
    await this.users.save(
      this.users.create({
        email,
        passwordHash,
        firstName: 'Invitado',
        lastName: 'Demo',
        role: UserRole.ADMIN,
        isActive: true,
        demoSessionId: sessionId,
      }),
    );

    // 3) Punto de acceso por defecto (puerta del kiosko) aislado a la sesión.
    const point = await this.points.save(
      this.points.create({
        name: 'Puerta principal (demo)',
        kind: 'PEDESTRIAN',
        cameraId: null,
        securityLevel: 'NORMAL',
        matchThreshold: 0.5,
        livenessThreshold: 0.7,
        controllerKind: 'SIMULATED',
        controllerRef: null,
        status: 'ACTIVE',
        demoSessionId: sessionId,
      }),
    );

    session.accessPointId = point.id;
    await this.sessions.save(session);

    this.logger.log(`Demo aprovisionado: ${email} (sesión ${sessionId}, expira ${expiresAt.toISOString()})`);
    return {
      sessionId,
      email,
      password,
      displayName,
      pointId: point.id,
      expiresAt: expiresAt.toISOString(),
      ttlMinutes: this.ttlMinutes,
    };
  }

  /** Estado público de una sesión (para el contador de la UI). No expone datos. */
  async status(sessionId: string): Promise<{
    status: string;
    expiresAt: string | null;
    remainingMs: number;
  } | null> {
    const s = await this.sessions.findOne({ where: { id: sessionId } });
    if (!s) return null;
    const remainingMs = s.expiresAt ? Math.max(0, s.expiresAt.getTime() - Date.now()) : 0;
    return { status: s.status, expiresAt: s.expiresAt?.toISOString() ?? null, remainingMs };
  }

  /** Barrido de autodestrucción: purga TODO lo de las sesiones ya expiradas. */
  async sweepExpired(): Promise<number> {
    const due = await this.sessions.find({
      where: { status: 'ACTIVE', expiresAt: LessThanOrEqual(new Date()) },
      take: 50,
    });
    let purged = 0;
    for (const s of due) {
      try {
        await this.purge(s);
        purged += 1;
      } catch (e) {
        this.logger.error(`No se pudo purgar la sesión ${s.id}: ${(e as Error).message}`);
      }
    }
    if (purged) this.logger.log(`Autodestrucción: ${purged} sesión(es) de demo eliminadas.`);
    return purged;
  }

  /**
   * Elimina por completo del servidor todo lo creado por una sesión: rostros en
   * Qdrant (colección entera) y todas las filas en Postgres. Se ejecuta con el
   * scope de tenant fijado para que el borrado en Qdrant apunte a la colección
   * correcta (`faces_demo_<id>`).
   */
  async purge(session: DemoSession): Promise<void> {
    await this.tenant.run(session.id, async () => {
      // 1) Vector_Store: elimina la colección completa de la sesión.
      await this.vision.dropCollection();

      // 2) Postgres: borra en orden seguro (hijos → padres).
      const subjectIds = (
        await this.subjects.find({ where: { demoSessionId: session.id }, select: { id: true } })
      ).map((r) => r.id);
      const pointIds = (
        await this.points.find({ where: { demoSessionId: session.id }, select: { id: true } })
      ).map((r) => r.id);

      if (subjectIds.length) {
        await this.authorizations.delete({ subjectId: In(subjectIds) });
        await this.consents.delete({ subjectId: In(subjectIds) });
        await this.templates.delete({ subjectId: In(subjectIds) });
      }
      if (pointIds.length) {
        await this.authorizations.delete({ accessPointId: In(pointIds) });
      }
      await this.events.delete({ demoSessionId: session.id });
      await this.subjects.delete({ demoSessionId: session.id });
      await this.points.delete({ demoSessionId: session.id });
      await this.users.delete({ demoSessionId: session.id });
    });

    session.status = 'PURGED';
    session.purgedAt = new Date();
    session.accessPointId = null;
    await this.sessions.save(session);
  }

  /** Contraseña legible y fácil de teclear en móvil (sin caracteres ambiguos). */
  private friendlyPassword(): string {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sin O/0/I/1/L
    const bytes = randomBytes(8);
    let body = '';
    for (let i = 0; i < 8; i += 1) body += alphabet[bytes[i] % alphabet.length];
    return `Vyx-${body}`;
  }
}
