// Canonical event schema + integrity helpers.
// Every collector maps its raw payload into this shape before ingestion.
// Design goals: provider-agnostic, PII-pseudonymized, append-only, tamper-evident.

import { createHash, createHmac, randomUUID } from 'node:crypto';

export const CATEGORIES = ['iam', 'auth', 'project', 'token', 'billing', 'network'];
export const OUTCOMES = ['success', 'failure', 'unknown'];

// Pseudonymize PII so correlation works on equality of hashes,
// without ever storing the cleartext (email, payment instrument, etc.).
const PII_SALT = process.env.OBS_PII_SALT || '';
export function pseudonymize(value) {
  if (value === undefined || value === null || value === '') return null;
  return 'sha256:' + createHash('sha256').update(PII_SALT + String(value).trim().toLowerCase()).digest('hex');
}

// Normalize a raw record into a canonical event.
// `prevHash` chains events into a ledger for chain-of-custody.
export function normalize(raw, { platform, collector, prevHash = null } = {}) {
  const eventTime = raw.event_time || raw.timestamp || new Date().toISOString();

  const ev = {
    event_id: randomUUID(),
    event_time: new Date(eventTime).toISOString(),
    collected_at: new Date().toISOString(),
    source: {
      platform: platform || raw.platform || 'unknown',
      collector: collector || 'unknown',
      source_event_id: String(raw.id ?? raw.event_id ?? raw.source_event_id ?? randomUUID()),
    },
    category: CATEGORIES.includes(raw.category) ? raw.category : 'iam',
    action: raw.action || 'unknown',
    outcome: OUTCOMES.includes(raw.outcome) ? raw.outcome : 'unknown',
    actor: {
      account_id: raw.account_id ?? raw.actor?.account_id ?? null,
      email_hash: pseudonymize(raw.email ?? raw.actor?.email),
      session_id: raw.session_id ?? raw.actor?.session_id ?? null,
    },
    target: {
      type: raw.target?.type ?? raw.target_type ?? null,
      id: raw.target?.id ?? raw.target_id ?? null,
    },
    network: {
      ip: raw.ip ?? raw.network?.ip ?? null,
      asn: raw.asn ?? raw.network?.asn ?? null,
      is_datacenter: Boolean(raw.is_datacenter ?? raw.network?.is_datacenter ?? false),
      ja3: raw.ja3 ?? raw.network?.ja3 ?? null,
    },
    device: {
      ua_hash: pseudonymize(raw.ua ?? raw.device?.ua),
      tz: raw.tz ?? raw.device?.tz ?? null,
      lang: raw.lang ?? raw.device?.lang ?? null,
    },
    billing: {
      instrument_fp: pseudonymize(raw.payment_instrument ?? raw.billing?.instrument),
      bin: raw.bin ?? raw.billing?.bin ?? null,
    },
    labels: {
      lab_run: raw.lab_run ?? raw.labels?.lab_run ?? null,
      // Hard requirement: only authorized lab accounts are ingested.
      authorized: raw.authorized ?? raw.labels?.authorized ?? false,
    },
    raw_ref: raw.raw_ref ?? null,
  };

  // Tamper-evident hash chain: integrity = H(prev_hash + canonical_payload).
  const payload = JSON.stringify({ ...ev, integrity: undefined });
  const hash = 'sha256:' + createHash('sha256').update((prevHash || '') + payload).digest('hex');
  ev.integrity = { hash, prev_hash: prevHash };
  return ev;
}

// Recompute the chain to verify nothing was altered after the fact.
export function verifyChain(events) {
  let prev = null;
  for (const ev of events) {
    const { integrity, ...rest } = ev;
    const payload = JSON.stringify({ ...rest, integrity: undefined });
    const expected = 'sha256:' + createHash('sha256').update((prev || '') + payload).digest('hex');
    if (integrity?.hash !== expected) {
      return { ok: false, broken_at: ev.event_id, expected, found: integrity?.hash };
    }
    prev = integrity.hash;
  }
  return { ok: true, count: events.length };
}

// HMAC verification for inbound webhooks (signature in header).
export function verifyHmac(rawBody, signature, secret) {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  // constant-time-ish compare
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}
