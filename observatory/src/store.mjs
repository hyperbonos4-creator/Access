// Central store: indexes canonical events into OpenSearch for search/timeline,
// keeps a per-stream cursor, and exposes the raw events for evidence export.
// The raw/WORM tier (object store) is left as a deployment concern; here we
// write the analytic copy and the local append-only JSONL ledger.

import { Client } from '@opensearch-project/opensearch';
import { appendFile, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const OS_NODE = process.env.OS_NODE || 'http://127.0.0.1:9200';
const INDEX = process.env.OS_INDEX || 'observatory-events';
const LEDGER_DIR = process.env.OBS_LEDGER_DIR || path.resolve('data');
const LEDGER = path.join(LEDGER_DIR, 'events.jsonl');
const CURSORS = path.join(LEDGER_DIR, 'cursors.json');

export const client = new Client({ node: OS_NODE });

const mapping = {
  mappings: {
    properties: {
      event_id: { type: 'keyword' },
      event_time: { type: 'date' },
      collected_at: { type: 'date' },
      source: { properties: { platform: { type: 'keyword' }, collector: { type: 'keyword' }, source_event_id: { type: 'keyword' } } },
      category: { type: 'keyword' },
      action: { type: 'keyword' },
      outcome: { type: 'keyword' },
      actor: { properties: { account_id: { type: 'keyword' }, email_hash: { type: 'keyword' }, session_id: { type: 'keyword' } } },
      target: { properties: { type: { type: 'keyword' }, id: { type: 'keyword' } } },
      network: { properties: { ip: { type: 'ip' }, asn: { type: 'long' }, is_datacenter: { type: 'boolean' }, ja3: { type: 'keyword' } } },
      device: { properties: { ua_hash: { type: 'keyword' }, tz: { type: 'keyword' }, lang: { type: 'keyword' } } },
      billing: { properties: { instrument_fp: { type: 'keyword' }, bin: { type: 'keyword' } } },
      labels: { properties: { lab_run: { type: 'keyword' }, authorized: { type: 'boolean' } } },
      integrity: { properties: { hash: { type: 'keyword' }, prev_hash: { type: 'keyword' } } },
    },
  },
};

export async function initIndex() {
  const exists = await client.indices.exists({ index: INDEX });
  if (!exists.body) {
    await client.indices.create({ index: INDEX, body: mapping });
    console.log(`Created index ${INDEX}`);
  } else {
    console.log(`Index ${INDEX} already exists`);
  }
}

async function ensureDir() {
  if (!existsSync(LEDGER_DIR)) await mkdir(LEDGER_DIR, { recursive: true });
}

// Refuse to ingest anything not explicitly flagged as authorized lab data.
// OBS_SINK=ledger writes only the local JSONL ledger (offline mode, no OpenSearch);
// the default also indexes into OpenSearch for search/timeline.
export async function ingest(event) {
  if (event?.labels?.authorized !== true) {
    throw new Error(`Refusing to ingest event ${event?.event_id}: labels.authorized must be true.`);
  }
  await ensureDir();
  await appendFile(LEDGER, JSON.stringify(event) + '\n', 'utf8');
  if ((process.env.OBS_SINK || 'all') !== 'ledger') {
    await client.index({ index: INDEX, id: event.event_id, body: event, refresh: false });
  }
  return event.event_id;
}

export async function lastHash() {
  if (!existsSync(LEDGER)) return null;
  const lines = (await readFile(LEDGER, 'utf8')).trim().split('\n').filter(Boolean);
  if (!lines.length) return null;
  return JSON.parse(lines[lines.length - 1]).integrity?.hash ?? null;
}

export async function getCursor(stream) {
  if (!existsSync(CURSORS)) return null;
  const c = JSON.parse(await readFile(CURSORS, 'utf8'));
  return c[stream] ?? null;
}

export async function setCursor(stream, value) {
  await ensureDir();
  const c = existsSync(CURSORS) ? JSON.parse(await readFile(CURSORS, 'utf8')) : {};
  c[stream] = value;
  await writeFile(CURSORS, JSON.stringify(c, null, 2), 'utf8');
}

export async function readLedger() {
  if (!existsSync(LEDGER)) return [];
  return (await readFile(LEDGER, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

if (process.argv.includes('--init')) {
  initIndex().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
}
