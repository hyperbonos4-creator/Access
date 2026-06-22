// Synthetic identity lab — 100% offline, no real accounts, no external services.
//
// Generates fictitious identities and the events we WOULD observe in the wild,
// so we can validate which signals reveal coordination/automation. Two cohorts:
//   - "independent": unique IP/device/payment/timezone, human-like jitter.
//   - "coordinated": share some signals (IP, device, payment fp, same target
//     project) and act with low-jitter, near-synchronized timing.
//
// Everything is fed through the SAME normalize() + ingest() pipeline used by the
// real collectors, so the detection logic is exercised exactly as in production.
//
// Usage:
//   OBS_SINK=ledger node sim/simulator.mjs sim/scenarios.example.json

import { readFile } from 'node:fs/promises';
import { normalize } from '../src/schema.mjs';
import { ingest, lastHash } from '../src/store.mjs';

// --- deterministic PRNG so runs are reproducible (seedable) ----------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ACTIONS = ['login.success', 'project.open', 'token.issue', 'project.deploy', 'member.add'];

function pick(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }
function jitter(rng, base, spread) { return base + (rng() - 0.5) * 2 * spread; }

// Build the fictitious identity pool for a cohort.
function buildIdentities(cohort, rng) {
  const ids = [];
  // Shared attributes for coordinated cohorts (the "tells" we want to detect).
  const sharedIp = `198.51.100.${1 + Math.floor(rng() * 50)}`;        // TEST-NET-2 (RFC 5737)
  const sharedUa = `LabClient/${cohort.shared_device_version || '1.0'} (headless)`;
  const sharedPay = `pay-fp-${cohort.name}`;
  const sharedTz = 'Etc/UTC';

  for (let i = 0; i < cohort.size; i++) {
    const shared = cohort.coordinated;
    ids.push({
      account_id: `${cohort.name}-id-${String(i).padStart(2, '0')}`,
      ip: shared ? sharedIp : `203.0.113.${1 + Math.floor(rng() * 250)}`, // TEST-NET-3
      is_datacenter: shared ? true : rng() < 0.2,
      ua: shared ? sharedUa : `Mozilla/5.0 Profile-${i}-${Math.floor(rng() * 1e6)}`,
      payment_instrument: shared ? sharedPay : `pay-${cohort.name}-${i}-${Math.floor(rng() * 1e6)}`,
      tz: shared ? sharedTz : pick(rng, ['America/Bogota', 'America/Lima', 'Europe/Madrid', 'America/Mexico_City']),
      lang: shared ? 'en' : pick(rng, ['es', 'es-CO', 'en', 'pt']),
      email: `${cohort.name}-id-${i}@lab.invalid`,
    });
  }
  return ids;
}

async function emit(raw, platform) {
  const ev = normalize(
    { ...raw, authorized: true, platform },
    { platform, collector: 'sim', prevHash: await lastHash() }
  );
  await ingest(ev);
  return ev;
}

async function runCohort(cohort, scenario, rng) {
  const ids = buildIdentities(cohort, rng);
  // Coordinated cohorts converge on a single shared target resource.
  const sharedTarget = `proj-shared-${scenario.shared_project || 'A'}`;
  let emitted = 0;

  // Simulated wall-clock start; advance per event to build a timeline.
  let baseT = new Date(scenario.start_time || '2026-06-22T08:00:00Z').getTime();

  for (let round = 0; round < cohort.rounds; round++) {
    for (const id of ids) {
      const target = cohort.coordinated
        ? sharedTarget
        : `proj-${cohort.name}-${id.account_id}`;

      // Timing model: coordinated => tiny jitter (automation tell);
      // independent => wide, human-like jitter.
      const stepMs = cohort.coordinated
        ? jitter(rng, cohort.interval_ms || 2000, cohort.jitter_ms ?? 50)
        : jitter(rng, cohort.interval_ms || 60000, cohort.jitter_ms ?? 40000);

      const eventTime = new Date(baseT).toISOString();
      await emit({
        event_time: eventTime,
        action: pick(rng, ACTIONS),
        outcome: rng() < 0.95 ? 'success' : 'failure',
        category: 'iam',
        account_id: id.account_id,
        email: id.email,
        ip: id.ip,
        is_datacenter: id.is_datacenter,
        ua: id.ua,
        tz: id.tz,
        lang: id.lang,
        payment_instrument: id.payment_instrument,
        target: { type: 'project', id: target },
        lab_run: scenario.lab_run,
      }, scenario.platform);
      emitted++;
      baseT += Math.max(1, stepMs);
    }
  }
  console.log(`cohort "${cohort.name}" (${cohort.coordinated ? 'coordinated' : 'independent'}): ${emitted} events`);
  return emitted;
}

async function main() {
  const cfgPath = process.argv[2] || 'sim/scenarios.example.json';
  const scenario = JSON.parse(await readFile(cfgPath, 'utf8'));
  const rng = mulberry32(scenario.seed ?? 1337);
  let total = 0;
  for (const cohort of scenario.cohorts) total += await runCohort(cohort, scenario, rng);
  console.log(`\nSimulation done. ${total} synthetic events ingested (lab_run=${scenario.lab_run}).`);
  console.log('Next: node src/correlate.mjs  &&  node src/anomaly.mjs');
}

main().catch((e) => { console.error(e); process.exit(1); });
