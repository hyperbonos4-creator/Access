import { createHash, randomBytes } from 'crypto';

/**
 * HTTP Digest Access Authentication (RFC 2617 / 7616, qop=auth) — lo que exige
 * el ISAPI de Hikvision/ONVIF. Node no lo resuelve solo: primera petición →
 * 401 con `WWW-Authenticate: Digest ...` → se computa la respuesta y se
 * reintenta con `Authorization: Digest`. Funciones PURAS (sin red).
 *
 * Portado verbatim de URBAN (cameras/ingestion/hikvision).
 */

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop: string | null;
  opaque: string | null;
  algorithm: string | null;
}

const md5 = (s: string): string => createHash('md5').update(s).digest('hex');

function attr(header: string, key: string): string | null {
  const quoted = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i').exec(header);
  if (quoted) return quoted[1];
  const bare = new RegExp(`${key}\\s*=\\s*([^,\\s]+)`, 'i').exec(header);
  return bare ? bare[1] : null;
}

export function parseDigestChallenge(header: string): DigestChallenge | null {
  if (!header || !/^\s*digest/i.test(header)) return null;
  const realm = attr(header, 'realm');
  const nonce = attr(header, 'nonce');
  if (!realm || !nonce) return null;
  return {
    realm,
    nonce,
    qop: attr(header, 'qop'),
    opaque: attr(header, 'opaque'),
    algorithm: attr(header, 'algorithm'),
  };
}

export function buildDigestAuthHeader(params: {
  username: string;
  password: string;
  method: string;
  uri: string;
  challenge: DigestChallenge;
  nc?: string;
  cnonce?: string;
}): string {
  const { username, password, method, uri, challenge } = params;
  const nc = params.nc ?? '00000001';
  const cnonce = params.cnonce ?? randomBytes(8).toString('hex');

  const ha1 = md5(`${username}:${challenge.realm}:${password}`);
  const ha2 = md5(`${method}:${uri}`);

  const qop = challenge.qop
    ? challenge.qop
        .split(',')
        .map((q) => q.trim())
        .includes('auth')
      ? 'auth'
      : null
    : null;

  const response = qop
    ? md5(`${ha1}:${challenge.nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${challenge.nonce}:${ha2}`);

  const parts = [
    `username="${username}"`,
    `realm="${challenge.realm}"`,
    `nonce="${challenge.nonce}"`,
    `uri="${uri}"`,
    `response="${response}"`,
  ];
  if (qop) parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${cnonce}"`);
  if (challenge.opaque) parts.push(`opaque="${challenge.opaque}"`);
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);

  return `Digest ${parts.join(', ')}`;
}
