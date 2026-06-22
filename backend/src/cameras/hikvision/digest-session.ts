import * as http from 'http';

import { buildDigestAuthHeader, DigestChallenge, parseDigestChallenge } from './digest-auth';

/**
 * Sesión Digest persistente para snapshots ISAPI de alta frecuencia (preview
 * del kiosko). Cachea el `challenge` y reutiliza el nonce incrementando `nc`
 * → una sola petición por frame en régimen normal; re-negocia solo si el nonce
 * caduca (self-healing). Portado verbatim de URBAN.
 */
export class DigestSession {
  private challenge: DigestChallenge | null = null;
  private nc = 0;
  /** Cola interna: serializa las peticiones de ESTA sesión para no corromper el
   *  nonce-count (`nc`) cuando llegan llamadas concurrentes (p. ej. preview +
   *  reconocimiento). Sin esto, dos GET solapados compartían `nc` → 401 →
   *  re-negociación → el preview se congelaba. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly username: string,
    private readonly password: string,
  ) {}

  get(path: string, timeoutMs = 4_000): Promise<Buffer | null> {
    const run = this.queue.then(
      () => this.doGet(path, timeoutMs),
      () => this.doGet(path, timeoutMs),
    );
    // El siguiente espera pase lo que pase (éxito o error), sin propagar rechazo.
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async doGet(path: string, timeoutMs: number): Promise<Buffer | null> {
    if (this.challenge) {
      const r = await this.once(path, this.authHeader(path), timeoutMs);
      if (r.status === 200 && r.body.length) return r.body;
      if (r.status !== 401) return null;
      this.challenge = null;
    }
    const first = await this.once(path, null, timeoutMs);
    if (first.status === 200) return first.body.length ? first.body : null;
    if (first.status !== 401) return null;
    const ch = parseDigestChallenge(Array.isArray(first.www) ? first.www[0] : first.www ?? '');
    if (!ch) return null;
    this.challenge = ch;
    this.nc = 0;
    const r2 = await this.once(path, this.authHeader(path), timeoutMs);
    return r2.status === 200 && r2.body.length ? r2.body : null;
  }

  private authHeader(path: string): string {
    this.nc += 1;
    const nc = this.nc.toString(16).padStart(8, '0');
    return buildDigestAuthHeader({
      username: this.username,
      password: this.password,
      method: 'GET',
      uri: path,
      challenge: this.challenge as DigestChallenge,
      nc,
    });
  }

  private once(
    path: string,
    authHeader: string | null,
    timeoutMs: number,
  ): Promise<{ status: number; body: Buffer; www?: string | string[] }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (authHeader) headers.Authorization = authHeader;
      const req = http.request(
        { host: this.host, port: this.port, path, method: 'GET', headers, timeout: timeoutMs },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body: Buffer.concat(chunks),
              www: res.headers['www-authenticate'],
            }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('isapi_picture_timeout')));
      req.on('error', reject);
      req.end();
    });
  }
}
