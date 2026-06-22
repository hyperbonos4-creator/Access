// Hard guard: this client can ONLY issue read methods (GET/HEAD).
// Any attempt to mutate a resource throws before a request is ever sent.
// This keeps the toolkit strictly observational by construction.

import { request } from 'undici';

const READ_ONLY_METHODS = new Set(['GET', 'HEAD']);

export async function readOnlyFetch(url, { method = 'GET', headers = {}, timeoutMs = 15000 } = {}) {
  const m = String(method).toUpperCase();
  if (!READ_ONLY_METHODS.has(m)) {
    throw new Error(
      `readOnlyFetch refuses non-read method "${m}". This tool only observes; it never modifies resources.`
    );
  }
  const res = await request(url, {
    method: m,
    headers,
    bodyTimeout: timeoutMs,
    headersTimeout: timeoutMs,
  });
  const text = await res.body.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body kept as text */ }
  return { status: res.statusCode, headers: res.headers, json, text };
}
