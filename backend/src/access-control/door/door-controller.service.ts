import * as http from 'http';
import * as https from 'https';

import { Injectable, Logger } from '@nestjs/common';

import {
  buildDigestAuthHeader,
  parseDigestChallenge,
} from '../../cameras/hikvision/digest-auth';
import { AccessPoint } from '../entities/access-point.entity';
import { DoorActuationResult, DoorControllerPort } from './door-controller.port';

/**
 * Implementación del `DoorControllerPort`. Despacha según `controllerKind` del
 * Access_Point. El `controllerRef` (secreto) NUNCA se loguea.
 *
 *   - `HTTP` / `RELAY`      → relé de red por webhook HTTP(S) (ESP32, Shelly,
 *                             Tasmota, Home Assistant…). `controllerRef` es la
 *                             URL; opcional prefijo de método: `"POST https://…"`.
 *                             Para la puerta de oficina con maglock + ESP32, el
 *                             backend solo emite el PULSO de apertura aquí; el
 *                             RE-BLOQUEO al cerrar (con sensor) vive en el
 *                             firmware del ESP32 (fail-secure local).
 *                             Ej. ESP32: `http://192.168.1.50/open?token=...`.
 *   - `HIKVISION_ISAPI`     → salida de relé de un terminal/controlador Hikvision
 *                             vía ISAPI. `controllerRef` = URL completa del
 *                             trigger con credenciales.
 *   - `SIMULATED`           → demo: marca la apertura como exitosa SIN hardware.
 *   - `NONE`/null           → sin actuador (registro lógico, `actuated:false`).
 *
 * **Fail-secure:** ante cualquier fallo se devuelve `{ actuated:false }`.
 */
@Injectable()
export class DoorControllerService implements DoorControllerPort {
  private readonly logger = new Logger(DoorControllerService.name);
  private static readonly TIMEOUT_MS = 5_000;

  async open(accessPoint: AccessPoint): Promise<DoorActuationResult> {
    const kind = (accessPoint.controllerKind ?? 'NONE').toUpperCase();

    if (kind === 'SIMULATED') {
      this.logger.log(`Apertura SIMULADA en access_point ${accessPoint.id} (sin hardware).`);
      return { actuated: true, detail: 'simulated' };
    }
    if (kind === 'NONE' || !accessPoint.controllerRef) {
      return { actuated: false, detail: 'no_controller_configured' };
    }

    try {
      let actuated = false;
      switch (kind) {
        case 'HTTP':
        case 'RELAY':
          actuated = await this.openHttpRelay(accessPoint.controllerRef);
          break;
        case 'HIKVISION_ISAPI':
          actuated = await this.openHikvisionIsapi(accessPoint.controllerRef);
          break;
        default:
          this.logger.warn(`controllerKind no soportado: ${kind}`);
          return { actuated: false, detail: 'unsupported_controller' };
      }
      return { actuated, detail: actuated ? undefined : 'controller_declined' };
    } catch (err) {
      this.logger.error(
        `Fallo actuando ${kind} en access_point ${accessPoint.id}: ${(err as Error).message}`,
      );
      return { actuated: false, detail: 'actuation_error' };
    }
  }

  /** Relé de red por HTTP(S). `ref` = URL, opcionalmente con método: `"POST url"`. */
  private async openHttpRelay(ref: string): Promise<boolean> {
    let method = 'GET';
    let url = ref.trim();
    const sp = url.indexOf(' ');
    if (sp > 0 && /^[A-Z]+$/i.test(url.slice(0, sp))) {
      method = url.slice(0, sp).toUpperCase();
      url = url.slice(sp + 1).trim();
    }
    const { status } = await this.request(method, url);
    return status >= 200 && status < 300;
  }

  /** Salida de relé Hikvision por ISAPI (Digest). PUT del trigger con XML. */
  private async openHikvisionIsapi(ref: string): Promise<boolean> {
    const u = new URL(ref);
    const username = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    const body = '<IOPortData><outputState>high</outputState></IOPortData>';

    const first = await this.request('PUT', ref, body, 'application/xml');
    if (first.status >= 200 && first.status < 300) return true;
    if (first.status !== 401) return false;

    const challenge = parseDigestChallenge(first.wwwAuthenticate ?? '');
    if (!challenge) return false;
    const authHeader = buildDigestAuthHeader({
      username,
      password,
      method: 'PUT',
      uri: u.pathname,
      challenge,
    });
    const second = await this.request('PUT', ref, body, 'application/xml', authHeader);
    return second.status >= 200 && second.status < 300;
  }

  /** GET/POST/PUT genérico con timeout. Devuelve status + www-authenticate. */
  private request(
    method: string,
    urlStr: string,
    body?: string,
    contentType?: string,
    authHeader?: string,
  ): Promise<{ status: number; wwwAuthenticate?: string }> {
    return new Promise((resolve, reject) => {
      let u: URL;
      try {
        u = new URL(urlStr);
      } catch {
        reject(new Error('invalid_controller_url'));
        return;
      }
      const lib = u.protocol === 'https:' ? https : http;
      const headers: Record<string, string> = {};
      if (body) {
        headers['Content-Type'] = contentType ?? 'text/plain';
        headers['Content-Length'] = String(Buffer.byteLength(body));
      }
      if (authHeader) headers.Authorization = authHeader;

      const req = lib.request(
        {
          protocol: u.protocol,
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
          timeout: DoorControllerService.TIMEOUT_MS,
        },
        (res) => {
          res.on('data', () => undefined);
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              wwwAuthenticate: Array.isArray(res.headers['www-authenticate'])
                ? res.headers['www-authenticate'][0]
                : (res.headers['www-authenticate'] as string | undefined),
            }),
          );
        },
      );
      req.on('timeout', () => req.destroy(new Error('door_controller_timeout')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }
}
