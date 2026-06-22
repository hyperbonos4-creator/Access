import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { Camera } from '../cameras/entities/camera.entity';
import { DigestSession } from '../cameras/hikvision/digest-session';

import { AccessControlService } from './access-control.service';
import { AccessDecision, AccessReason } from './access-control.types';
import { AccessPoint } from './entities/access-point.entity';
import { EnrolledSubject } from './entities/enrolled-subject.entity';
import { VisionServiceClient } from './vision-service.client';
import { TenantContext } from '../common/tenant/tenant-context.service';

/** Perfil del empleado reconocido (para la "cédula" del kiosko). */
export interface KioskSubjectProfile {
  fullName: string;
  role: string | null;
  employeeCode: string | null;
}

/** Resultado de un intento de reconocimiento en el kiosko. */
export interface KioskRecognitionResult {
  face: boolean;
  decision: AccessDecision | null;
  reason: AccessReason | null;
  subjectId: string | null;
  subjectName: string | null;
  profile: KioskSubjectProfile | null;
  matchScore: number;
  livenessScore: number;
  livenessMode: string;
  spoofVerdict: 'REAL' | 'SPOOF' | null;
  doorActuated: boolean;
  accessEventId: string | null;
  bbox: number[] | null;
  frameWidth: number | null;
  frameHeight: number | null;
  matchThreshold: number;
  livenessThreshold: number;
  capturedAt: string;
  /** true si se reusó la última decisión por cooldown (no se reactuó la puerta). */
  throttled: boolean;
}

interface CooldownEntry {
  label: string | null;
  decision: AccessDecision;
  reason: AccessReason;
  subjectId: string | null;
  subjectName: string | null;
  profile: KioskSubjectProfile | null;
  doorActuated: boolean;
  accessEventId: string | null;
  at: number;
}

/**
 * `KioskRecognitionService` — terminal de puerta facial (kiosko).
 *
 * Captura un frame REAL de la cámara IP del Access_Point (snapshot ISAPI por
 * Digest), lo reconoce 1:N en el Vision_Service y aplica la MISMA política
 * fail-secure del dominio (`AccessControlService.evaluateFaceAndActuate`). El
 * Vision solo reconoce; la decisión y la actuación de puerta viven en el dominio.
 *
 * Anti-spam: un cooldown por Access_Point evita reabrir la puerta y reauditar en
 * cada poll del kiosko cuando la misma persona sigue frente a la cámara.
 */
@Injectable()
export class KioskRecognitionService {
  private readonly logger = new Logger(KioskRecognitionService.name);
  private static readonly COOLDOWN_MS = 10_000;
  // Dual-stream: el PREVIEW usa el substream (102, ligero y fluido) y el
  // RECONOCIMIENTO el stream principal (101, 4MP nítido para precisión). Así el
  // video en vivo no compite con el reconocimiento por ancho de banda.
  private static readonly PREVIEW_CHANNELS = [102, 103, 101];
  private static readonly RECOGNIZE_CHANNELS = [101, 102, 103];

  private readonly digestSessions = new Map<string, DigestSession>();
  private readonly lastByPoint = new Map<string, CooldownEntry>();

  constructor(
    @InjectRepository(AccessPoint)
    private readonly accessPoints: Repository<AccessPoint>,
    @InjectRepository(Camera)
    private readonly cameras: Repository<Camera>,
    @InjectRepository(EnrolledSubject)
    private readonly subjects: Repository<EnrolledSubject>,
    private readonly vision: VisionServiceClient,
    private readonly access: AccessControlService,
    private readonly tenant: TenantContext,
    private readonly config: ConfigService,
  ) {}

  /** Captura SOLO el snapshot de la cámara del punto (preview fluido, sin IA). */
  async captureSnapshot(accessPointId: string): Promise<Buffer> {
    const camera = await this.resolveCamera(accessPointId);
    const picture = await this.fetchPicture(
      camera,
      KioskRecognitionService.PREVIEW_CHANNELS,
      'preview',
    );
    if (!picture) throw new ServiceUnavailableException('camera_unreachable');
    return picture;
  }

  private async resolveCamera(accessPointId: string): Promise<Camera> {
    const ap = await this.accessPoints.findOne({
      where: { id: accessPointId, status: 'ACTIVE' },
    });
    if (!ap) throw new NotFoundException('access_point_not_found');
    if (!ap.cameraId) throw new NotFoundException('access_point_without_camera');
    const camera = await this.cameras.findOne({ where: { id: ap.cameraId } });
    if (!camera) throw new NotFoundException('camera_not_found');
    return camera;
  }

  /** Reconoce a quien se asoma a la cámara del Access_Point y decide el acceso. */
  async recognizeAtPoint(accessPointId: string): Promise<KioskRecognitionResult> {
    const ap = await this.accessPoints.findOne({
      where: { id: accessPointId, status: 'ACTIVE', demoSessionId: this.tenant.scopeValue() },
    });
    if (!ap) throw new NotFoundException('access_point_not_found');
    if (!ap.cameraId) throw new NotFoundException('access_point_without_camera');

    const camera = await this.cameras.findOne({ where: { id: ap.cameraId } });
    if (!camera) throw new NotFoundException('camera_not_found');

    const picture = await this.fetchPicture(
      camera,
      KioskRecognitionService.RECOGNIZE_CHANNELS,
      'recognize',
    );
    if (!picture) throw new ServiceUnavailableException('camera_unreachable');

    return this.decideFromImage(ap, accessPointId, picture.toString('base64'), camera.externalKey);
  }

  /**
   * Reconoce desde una imagen provista por el cliente (webcam del navegador).
   * Misma política fail-secure que `recognizeAtPoint`, pero el frame no proviene
   * de una cámara IP. Habilita el kiosko en equipos sin cámara ISAPI/RTSP.
   */
  async recognizeImageAtPoint(
    accessPointId: string,
    imageB64Raw: string,
  ): Promise<KioskRecognitionResult> {
    if (!imageB64Raw || typeof imageB64Raw !== 'string') {
      throw new BadRequestException('image_required');
    }
    const ap = await this.accessPoints.findOne({
      where: { id: accessPointId, status: 'ACTIVE', demoSessionId: this.tenant.scopeValue() },
    });
    if (!ap) throw new NotFoundException('access_point_not_found');

    let externalCameraKey: string | null = null;
    if (ap.cameraId) {
      const camera = await this.cameras.findOne({ where: { id: ap.cameraId } });
      externalCameraKey = camera?.externalKey ?? null;
    }
    // Acepta data URL (`data:image/...;base64,XXXX`) o base64 puro.
    const imageB64 = imageB64Raw.includes(',') ? imageB64Raw.split(',').pop()! : imageB64Raw;
    return this.decideFromImage(ap, accessPointId, imageB64, externalCameraKey);
  }

  /**
   * Núcleo de reconocimiento + decisión fail-secure a partir de un frame en
   * base64 (proceda de la cámara IP o de la webcam del navegador).
   */
  private async decideFromImage(
    ap: AccessPoint,
    accessPointId: string,
    imageB64: string,
    externalCameraKey: string | null,
  ): Promise<KioskRecognitionResult> {
    const capturedAt = new Date().toISOString();
    const matchThreshold = Number(ap.matchThreshold);
    const livenessThreshold = Number(ap.livenessThreshold);

    const recognition = await this.vision.recognize(imageB64, {
      externalCameraKey,
      matchThreshold,
    });

    if (!recognition.face) {
      return this.noFace(capturedAt, matchThreshold, livenessThreshold);
    }

    const spoofVerdict: 'REAL' | 'SPOOF' =
      recognition.livenessScore >= livenessThreshold ? 'REAL' : 'SPOOF';
    const liveSignals = {
      face: true as const,
      matchScore: recognition.score,
      livenessScore: recognition.livenessScore,
      livenessMode: recognition.livenessMode,
      spoofVerdict,
      bbox: recognition.bbox,
      frameWidth: recognition.frameWidth,
      frameHeight: recognition.frameHeight,
      matchThreshold,
      livenessThreshold,
      capturedAt,
    };

    // Cooldown: misma persona reciente → no reactuar ni reauditar.
    const last = this.lastByPoint.get(accessPointId);
    if (
      last &&
      last.label === recognition.label &&
      Date.now() - last.at < KioskRecognitionService.COOLDOWN_MS
    ) {
      return {
        ...liveSignals,
        decision: last.decision,
        reason: last.reason,
        subjectId: last.subjectId,
        subjectName: last.subjectName,
        profile: last.profile,
        doorActuated: last.doorActuated,
        accessEventId: last.accessEventId,
        throttled: true,
      };
    }

    const { event, outcome } = await this.access.evaluateFaceAndActuate({
      ap,
      label: recognition.label,
      matchScore: recognition.score,
      livenessScore: recognition.livenessScore,
      livenessMode: recognition.livenessMode,
      snapshotUrl: null,
      recordedAt: new Date(),
    });

    const profile = outcome.subjectId ? await this.resolveProfile(outcome.subjectId) : null;
    const subjectName = profile?.fullName ?? null;

    this.lastByPoint.set(accessPointId, {
      label: recognition.label,
      decision: outcome.decision,
      reason: outcome.reason,
      subjectId: outcome.subjectId,
      subjectName,
      profile,
      doorActuated: event.doorActuated,
      accessEventId: event.id,
      at: Date.now(),
    });

    return {
      ...liveSignals,
      decision: outcome.decision,
      reason: outcome.reason,
      subjectId: outcome.subjectId,
      subjectName,
      profile,
      doorActuated: event.doorActuated,
      accessEventId: event.id,
      throttled: false,
    };
  }

  /**
   * Diagnóstico de cámaras: por cada Access_Point activo con cámara, intenta un
   * snapshot y reporta si responde + cuándo. Para el panel "Sistema".
   */
  async diagnoseCameras(): Promise<
    Array<{
      accessPointId: string;
      name: string;
      cameraName: string | null;
      controllerKind: string | null;
      hasCamera: boolean;
      ok: boolean;
      lastFrameAt: string | null;
    }>
  > {
    const pts = await this.accessPoints.find({ where: { status: 'ACTIVE' }, order: { name: 'ASC' } });
    const out = [];
    for (const ap of pts) {
      if (!ap.cameraId) {
        out.push({
          accessPointId: ap.id, name: ap.name, cameraName: null,
          controllerKind: ap.controllerKind ?? 'NONE', hasCamera: false, ok: false, lastFrameAt: null,
        });
        continue;
      }
      const cam = await this.cameras.findOne({ where: { id: ap.cameraId } });
      let ok = false;
      if (cam) {
        try {
          ok = !!(await this.fetchPicture(cam, KioskRecognitionService.PREVIEW_CHANNELS, 'preview'));
        } catch {
          ok = false;
        }
      }
      out.push({
        accessPointId: ap.id, name: ap.name, cameraName: cam?.name ?? null,
        controllerKind: ap.controllerKind ?? 'NONE', hasCamera: true, ok,
        lastFrameAt: ok ? new Date().toISOString() : null,
      });
    }
    return out;
  }

  /** Captura un snapshot de la cámara de la vista familiar (preview/substream). */
  async captureFamilySnapshot(): Promise<Buffer> {
    const envId = (this.config.get<string>('FAMILY_ACCESS_POINT_ID') || '').trim();
    let ap: AccessPoint | null = null;
    if (envId) {
      ap = await this.accessPoints.findOne({ where: { id: envId, status: 'ACTIVE' } });
    }
    if (!ap) {
      const candidates = await this.accessPoints.find({ where: { status: 'ACTIVE' }, order: { name: 'ASC' } });
      ap = candidates.find((p) => !!p.cameraId) ?? null;
    }
    if (!ap || !ap.cameraId) throw new NotFoundException('family_camera_not_configured');
    const camera = await this.cameras.findOne({ where: { id: ap.cameraId } });
    if (!camera) throw new NotFoundException('camera_not_found');
    const picture = await this.fetchPicture(camera, KioskRecognitionService.PREVIEW_CHANNELS, 'preview');
    if (!picture) throw new ServiceUnavailableException('camera_unreachable');
    return picture;
  }

  /** Resuelve el perfil del empleado para la "cédula" del kiosko. */
  private async resolveProfile(subjectId: string): Promise<KioskSubjectProfile | null> {
    const subject = await this.subjects.findOne({
      where: { id: subjectId, demoSessionId: this.tenant.scopeValue() },
    });
    if (!subject) return null;
    return {
      fullName: subject.fullName,
      role: subject.kind ?? null,
      employeeCode: subject.employeeCode ?? null,
    };
  }

  private noFace(
    capturedAt: string,
    matchThreshold: number,
    livenessThreshold: number,
  ): KioskRecognitionResult {
    return {
      face: false,
      decision: null,
      reason: null,
      subjectId: null,
      subjectName: null,
      profile: null,
      matchScore: 0,
      livenessScore: 0,
      livenessMode: 'PASSIVE',
      spoofVerdict: null,
      doorActuated: false,
      accessEventId: null,
      bbox: null,
      frameWidth: null,
      frameHeight: null,
      matchThreshold,
      livenessThreshold,
      capturedAt,
      throttled: false,
    };
  }

  /**
   * Captura un snapshot ISAPI probando los canales indicados en orden hasta que
   * uno devuelva imagen. Deriva host/credenciales del `rtspUrl` (nunca viajan al
   * cliente). Para una cámara con NVR usa `nvrChannel*100 + ch`.
   */
  private async fetchPicture(
    camera: Camera,
    channels: number[],
    purpose: 'preview' | 'recognize' = 'preview',
  ): Promise<Buffer | null> {
    const conn = this.parseRtsp(camera.rtspUrl);
    if (!conn) return null;
    const port = this.config.get<number>('CAMERA_ISAPI_PORT', 80);
    // Sesión SEPARADA por propósito: el preview (continuo) y el reconocimiento
    // no comparten nonce → no se pisan ni provocan re-negociación/freeze.
    const sessionKey = `${conn.host}:${port}:${purpose}`;
    let session = this.digestSessions.get(sessionKey);
    if (!session) {
      session = new DigestSession(conn.host, port, conn.username, conn.password);
      this.digestSessions.set(sessionKey, session);
    }
    const base = camera.nvrChannel && camera.nvrChannel > 0 ? camera.nvrChannel * 100 : 100;
    for (const ch of channels) {
      const pictureChannel = camera.nvrChannel && camera.nvrChannel > 0 ? base + (ch % 100) : ch;
      try {
        const buf = await session.get(`/ISAPI/Streaming/channels/${pictureChannel}/picture`, 4_000);
        if (buf) return buf;
      } catch (err) {
        this.logger.debug(
          `Snapshot ch${pictureChannel} de ${conn.host} falló: ${(err as Error).message}`,
        );
      }
    }
    return null;
  }

  private parseRtsp(
    rtspUrl: string,
  ): { host: string; username: string; password: string } | null {
    try {
      const u = new URL(rtspUrl);
      if (!u.hostname) return null;
      return {
        host: u.hostname,
        username: decodeURIComponent(u.username || ''),
        password: decodeURIComponent(u.password || ''),
      };
    } catch {
      return null;
    }
  }
}
