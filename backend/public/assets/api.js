/* Cliente de API compartido (kiosko + admin). Same-origin: el backend sirve
   el kiosko en /kiosk y la API en /api/v1. */
const API_BASE = '/api/v1';

export function getToken(key) {
  return localStorage.getItem(key) || '';
}
export function setToken(key, value) {
  if (value) localStorage.setItem(key, value);
  else localStorage.removeItem(key);
}

export class ApiError extends Error {
  constructor(status, body) {
    super((body && (body.message || body.error)) || `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

async function request(method, path, { token, body, raw } = {}) {
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

export const api = {
  get: (p, t) => request('GET', p, { token: t }),
  post: (p, b, t) => request('POST', p, { token: t, body: b }),
  patch: (p, b, t) => request('PATCH', p, { token: t, body: b }),
  del: (p, t) => request('DELETE', p, { token: t }),
};

/* ── Toasts ─────────────────────────────────────────────────────────────── */
export function toast(message, kind = '') {
  let host = document.getElementById('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts';
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .3s, transform .3s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    setTimeout(() => el.remove(), 300);
  }, 3800);
}

/** Convierte un File de imagen a base64 SIN el prefijo data:. */
export function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
