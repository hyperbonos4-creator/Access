// Medidor de uso del Cerebro: registra consumo por día (UTC) en runtime/usage.json.
// Lo escriben tanto el indexador (host) como el servidor (contenedor); ambos
// montan la misma carpeta runtime/, así que comparten el archivo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = path.join(HERE, 'runtime');
const FILE = path.join(DIR, 'usage.json');

// Tope diario del plan gratis de Cloudflare Workers AI.
const FREE_NEURONS_DAY = 10000;
// Estimaciones (≈) para el medidor — calibradas a ojo, ajustables.
const NEURONS_PER_EMBED = 2;        // por fragmento embebido (bge-m3)
const NEURONS_PER_1K_CHAT = 8;      // por cada 1000 tokens de chat (in+out)

function todayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD en UTC
}

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return { days: {} }; }
}
function save(data) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    // Conserva solo los últimos 21 días.
    const keys = Object.keys(data.days).sort();
    while (keys.length > 21) delete data.days[keys.shift()];
    fs.writeFileSync(FILE, JSON.stringify(data));
  } catch { /* best-effort */ }
}

function blank() {
  return { chatCalls: 0, promptTokens: 0, completionTokens: 0, embedCalls: 0, embedItems: 0, exhausted: false, exhaustedAt: null };
}

/** Suma consumo al día de hoy. delta: {chatCalls, promptTokens, completionTokens, embedCalls, embedItems} */
export function record(delta) {
  const data = load();
  const k = todayKey();
  const d = (data.days[k] = { ...blank(), ...(data.days[k] || {}) });
  for (const key of ['chatCalls', 'promptTokens', 'completionTokens', 'embedCalls', 'embedItems']) {
    if (delta[key]) d[key] += delta[key];
  }
  save(data);
}

/** Marca que hoy se agotó la cuota (al detectar un 429). */
export function markExhausted() {
  const data = load();
  const k = todayKey();
  const d = (data.days[k] = { ...blank(), ...(data.days[k] || {}) });
  d.exhausted = true;
  d.exhaustedAt = new Date().toISOString();
  save(data);
}

function neuronsOf(d) {
  const chatTokens = (d.promptTokens || 0) + (d.completionTokens || 0);
  return Math.round((d.embedItems || 0) * NEURONS_PER_EMBED + (chatTokens / 1000) * NEURONS_PER_1K_CHAT);
}

/** Estado para el panel: hoy, reinicio y histórico. */
export function stats() {
  const data = load();
  const k = todayKey();
  const today = { ...blank(), ...(data.days[k] || {}) };
  const usedEst = neuronsOf(today);
  const now = new Date();
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
  const history = Object.keys(data.days).sort().slice(-7).map((day) => ({
    day,
    neurons: neuronsOf(data.days[day]),
    chatCalls: data.days[day].chatCalls || 0,
    tokens: (data.days[day].promptTokens || 0) + (data.days[day].completionTokens || 0),
    embedItems: data.days[day].embedItems || 0,
  }));
  return {
    freeNeuronsPerDay: FREE_NEURONS_DAY,
    today: {
      date: k,
      chatCalls: today.chatCalls,
      promptTokens: today.promptTokens,
      completionTokens: today.completionTokens,
      tokens: today.promptTokens + today.completionTokens,
      embedCalls: today.embedCalls,
      embedItems: today.embedItems,
      neuronsEst: usedEst,
      remainingEst: Math.max(0, FREE_NEURONS_DAY - usedEst),
      pctEst: Math.min(100, Math.round((usedEst / FREE_NEURONS_DAY) * 100)),
      exhausted: !!today.exhausted,
    },
    resetAt: reset.toISOString(),
    resetInMs: reset.getTime() - now.getTime(),
    history,
  };
}
