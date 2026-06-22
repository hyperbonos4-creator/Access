// Read-only pull collector.
// For each configured lab account it polls a read-only audit/IAM endpoint,
// normalizes the records, chains them, and ingests. Keeps a per-account cursor
// so reruns resume without duplicating. It NEVER issues a non-read request.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readOnlyFetch } from './readonly-http.mjs';
import { normalize } from './schema.mjs';
import { ingest, lastHash, getCursor, setCursor } from './store.mjs';

const CONFIG = process.env.OBS_CONFIG || path.resolve('config.json');

function applyTemplate(str, vars) {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
}

async function pollAccount(platform, account) {
  if (account.authorized !== true) {
    console.warn(`Skipping ${account.account_id}: not flagged authorized.`);
    return 0;
  }
  const stream = `${platform}:${account.account_id}`;
  const cursor = await getCursor(stream);
  const url = applyTemplate(account.audit_url, { since: cursor ?? account.bootstrap_since ?? '' });
  const headers = { Accept: 'application/json', ...(account.headers || {}) };

  const res = await readOnlyFetch(url, { method: 'GET', headers });
  if (res.status >= 400) {
    console.error(`${stream} -> HTTP ${res.status}`);
    return 0;
  }

  // Expect an array under a configurable path (default: top-level array or .events)
  const records = Array.isArray(res.json) ? res.json : (res.json?.[account.records_field || 'events'] || []);
  let count = 0;
  let newCursor = cursor;

  for (const raw of records) {
    const ev = normalize(
      { ...raw, account_id: account.account_id, authorized: true, lab_run: account.lab_run, platform },
      { platform, collector: 'audit-pull', prevHash: await lastHash() }
    );
    await ingest(ev);
    count++;
    newCursor = raw[account.cursor_field || 'id'] ?? newCursor;
  }
  if (newCursor && newCursor !== cursor) await setCursor(stream, newCursor);
  console.log(`${stream}: ingested ${count} event(s), cursor=${newCursor}`);
  return count;
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG, 'utf8'));
  let total = 0;
  for (const acct of cfg.accounts || []) {
    try { total += await pollAccount(cfg.platform, acct); }
    catch (e) { console.error(`Error on ${acct.account_id}: ${e.message}`); }
  }
  console.log(`Done. Total ingested: ${total}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
