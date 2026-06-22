import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { AxiosError } from 'axios';

import { TenantContext } from '../common/tenant/tenant-context.service';

/** Resultado de enrolamiento devuelto por el Vision_Service (`/enroll`). */
export interface VisionEnrollResult {
  ok: boolean;
  vectorPointId?: string | null;
  model?: string | null;
  dim?: number | null;
  quality?: number | null;
  reason?: string | null; // NO_FACE | MULTIPLE_FACES | LOW_QUALITY | SPOOF_SUSPECTED
}

/** Error de disponibilidad del Vision_Service (canal caído / timeout). */
export class VisionServiceUnavailableError extends Error {
  constructor(detail: string) {
    super(`vision_service_unavailable: ${detail}`);
    this.name = 'VisionServiceUnavailableError';
  }
}

/** Resultado de reconocimiento 1:N de un frame (`/recognize`). */
export interface VisionRecognizeResult {
  ok: boolean;
  /** false => no se detectó rostro en el frame. */
  face: boolean;
  /** subject_id reconocido, o "unknown". */
  label: string | null;
  /** similitud 1:N [0,1]. */
  score: number;
  /** liveness pasivo [0,1]; 0.0 si el modelo no está (fail-secure). */
  livenessScore: number;
  livenessMode: string;
  bbox: number[] | null;
  frameWidth: number | null;
  frameHeight: number | null;
}

/** Observación de una acción del reto, revalidada por el Vision. */
export interface VisionActionObservation {
  action: string;
  satisfied: boolean;
  yawRatio: number | null;
  hasFace: boolean;
  passiveScore: number | null;
}

/** Resultado de la revalidación de liveness activo (`/liveness/active`). */
export interface VisionActiveLivenessResult {
  ok: boolean;
  observed: VisionActionObservation[];
  passiveScore: number;
  passiveAvailable: boolean;
  reason: string | null;
  /** Liveness pasivo del frame frontal (LOOK_CENTER) — toma fiable para el gate. */
  centerPassiveScore: number;
  centerPassiveAvailable: boolean;
  identityMinSimilarity: number;
  identityAvailable: boolean;
}

/**
 * Cliente del microservicio `vision` (FastAPI + ONNX). Gestiona plantillas
 * (`/enroll`, `DELETE /templates/:id`), reconocimiento (`/recognize`) y
 * revalidación de liveness activo (`/liveness/active`). El espacio de nombres
 * del Vector_Store (`conjunto_id`) se fija al `SITE_ID` de la oficina.
 *
 * Canal autenticado por **secreto compartido** (`VISION_SERVICE_TOKEN`) en el
 * header `Authorization: Bearer ...`, tal y como lo verifica el Vision_Service
 * (`security.require_service_auth`). Es un servicio LOCAL: NO usa el rotador de
 * cuentas Cloudflare (eso es del asistente). fail-secure / fail-loud,
 * confidencialidad (nunca devuelve embeddings ni loguea el token).
 */
@Injectable()
export class VisionServiceClient {
  private readonly logger = new Logger(VisionServiceClient.name);
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  /** Timeout ampliado para el liveness activo (procesa varios frames en CPU). */
  private readonly activeLivenessTimeoutMs: number;
  /** Espacio de nombres del sitio (reemplaza el `conjuntoId` de URBAN). */
  readonly siteId: string;

  constructor(
    private readonly config: ConfigService,
    private readonly httpService: HttpService,
    private readonly tenant?: TenantContext,
  ) {
    this.baseUrl = (
      this.config.get<string>('VISION_SERVICE_URL') ?? 'http://localhost:8200'
    ).replace(/\/+$/, '');
    this.token = this.config.get<string>('VISION_SERVICE_TOKEN') ?? '';
    this.timeoutMs = this.config.get<number>('VISION_SERVICE_TIMEOUT_MS', 5000);
    this.activeLivenessTimeoutMs = this.config.get<number>(
      'VISION_ACTIVE_LIVENESS_TIMEOUT_MS',
      45000,
    );
    this.siteId = this.config.get<string>('SITE_ID') ?? 'office';
  }

  /** Cabeceras del canal de servicio (bearer compartido). Vacío en dev sin token. */
  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  /**
   * Espacio de nombres del Vector_Store para el tenant ACTUAL. En una sesión de
   * demo aísla la colección por sesión (`faces_demo_<id>`); fuera del demo usa
   * el `SITE_ID` base. Así el reconocimiento de un demo NUNCA cruza rostros de
   * otra persona.
   */
  private conjuntoId(): string {
    return this.tenant ? this.tenant.visionNamespace(this.siteId) : this.siteId;
  }

  /** Genera un Face_Template a partir de una imagen base64. */
  async enroll(subjectId: string, imageB64: string): Promise<VisionEnrollResult> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/enroll`,
          {
            conjunto_id: this.conjuntoId(),
            subject_id: subjectId,
            image_b64: imageB64,
          },
          {
            headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
            timeout: this.timeoutMs,
          },
        ),
      );

      const body = response.data;
      return {
        ok: Boolean(body.ok),
        vectorPointId: body.vector_point_id ?? null,
        model: body.model ?? null,
        dim: body.dim ?? null,
        quality: body.quality ?? null,
        reason: body.reason ?? null,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      throw new VisionServiceUnavailableError(
        `enroll status ${axiosError?.response?.status || 'unknown'}: ${axiosError.message}`,
      );
    }
  }

  /**
   * Reconoce 1:N un frame de la cámara del Access_Point (kiosko/terminal).
   * Devuelve el veredicto de identidad + liveness; la decisión fail-secure la
   * toma el dominio (`AccessControlService.decide`). Ningún embedding viaja.
   */
  async recognize(
    imageB64: string,
    opts: { externalCameraKey?: string | null; matchThreshold?: number } = {},
  ): Promise<VisionRecognizeResult> {
    try {
      const payload: any = {
        conjunto_id: this.conjuntoId(),
        image_b64: imageB64,
      };

      if (opts.externalCameraKey) {
        payload.external_camera_key = opts.externalCameraKey;
      }
      if (opts.matchThreshold != null) {
        payload.match_threshold = opts.matchThreshold;
      }

      const response = await firstValueFrom(
        this.httpService.post(`${this.baseUrl}/recognize`, payload, {
          headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
          timeout: this.timeoutMs,
        }),
      );

      const body = response.data;
      return {
        ok: Boolean(body.ok),
        face: Boolean(body.face),
        label: body.label ?? null,
        score: Number(body.score ?? 0),
        livenessScore: Number(body.liveness_score ?? 0),
        livenessMode: body.liveness_mode ?? 'PASSIVE',
        bbox: Array.isArray(body.bbox) ? body.bbox : null,
        frameWidth: body.frame_width != null ? Number(body.frame_width) : null,
        frameHeight: body.frame_height != null ? Number(body.frame_height) : null,
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      throw new VisionServiceUnavailableError(
        `recognize status ${axiosError?.response?.status || 'unknown'}: ${axiosError.message}`,
      );
    }
  }

  /** Borra una plantilla concreta del Vector_Store (revocación / supresión). */
  async deleteTemplate(pointId: string): Promise<number> {
    try {
      const url = `${this.baseUrl}/templates/${encodeURIComponent(pointId)}?conjunto_id=${encodeURIComponent(this.conjuntoId())}`;

      const response = await firstValueFrom(
        this.httpService.delete(url, {
          headers: this.authHeaders(),
          timeout: this.timeoutMs,
        }),
      );

      return response.data?.deleted ?? 0;
    } catch (error) {
      const axiosError = error as AxiosError;
      throw new VisionServiceUnavailableError(
        `deleteTemplate status ${axiosError?.response?.status || 'unknown'}: ${axiosError.message}`,
      );
    }
  }

  /**
   * Elimina por completo la colección Qdrant del tenant actual (autodestrucción
   * de una sesión de demo). Idempotente: 404 => ya no existe. Best-effort.
   */
  async dropCollection(): Promise<boolean> {
    const url = `${this.baseUrl}/collections/${encodeURIComponent(this.conjuntoId())}`;
    try {
      const response = await firstValueFrom(
        this.httpService.delete(url, {
          headers: this.authHeaders(),
          timeout: this.timeoutMs,
        }),
      );
      return response.status === 200 || response.status === 204;
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError?.response?.status === 404) {
        return true; // Ya no existe, consideramos éxito
      }
      this.logger.warn(`dropCollection falló: ${axiosError.message}`);
      return false;
    }
  }

  /**
   * Revalida server-side un reto de liveness ACTIVO: un frame clave por acción.
   * El Vision estima pose (yaw) y liveness pasivo por frame y reporta; el
   * Backend decide. Devuelve observaciones + score pasivo del conjunto.
   */
  async activeLiveness(
    framesB64: string[],
    actions: string[],
  ): Promise<VisionActiveLivenessResult> {
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/liveness/active`,
          {
            conjunto_id: this.conjuntoId(),
            frames_b64: framesB64,
            actions,
          },
          {
            headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
            timeout: this.activeLivenessTimeoutMs,
          },
        ),
      );

      const body = response.data;
      const observed = Array.isArray(body.observed) ? body.observed : [];

      return {
        ok: Boolean(body.ok),
        observed: observed.map((o: any) => ({
          action: String(o.action),
          satisfied: Boolean(o.satisfied),
          yawRatio: o.yaw_ratio != null ? Number(o.yaw_ratio) : null,
          hasFace: Boolean(o.has_face),
          passiveScore: o.passive_score != null ? Number(o.passive_score) : null,
        })),
        passiveScore: Number(body.passive_score ?? 0),
        passiveAvailable: Boolean(body.passive_available),
        reason: body.reason ?? null,
        centerPassiveScore: Number(body.center_passive_score ?? 0),
        centerPassiveAvailable: Boolean(body.center_passive_available),
        identityMinSimilarity: Number(body.identity_min_similarity ?? 1),
        identityAvailable: Boolean(body.identity_available),
      };
    } catch (error) {
      const axiosError = error as AxiosError;
      throw new VisionServiceUnavailableError(
        `liveness/active status ${axiosError?.response?.status || 'unknown'}: ${axiosError.message}`,
      );
    }
  }

  /** Salud del Vision_Service. */
  async health(): Promise<{ ok: boolean; detail: Record<string, unknown> | null }> {
    try {
      const response = await firstValueFrom(
        this.httpService.get(`${this.baseUrl}/health`, {
          timeout: this.timeoutMs,
        }),
      );
      return {
        ok: response.status === 200 && response.data?.status === 'ok',
        detail: response.data,
      };
    } catch (err) {
      const axiosError = err as AxiosError;
      this.logger.warn(`Vision_Service no responde: ${axiosError.message}`);
      return { ok: false, detail: null };
    }
  }
}
