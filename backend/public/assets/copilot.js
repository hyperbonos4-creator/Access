/* Copiloto interno — UI de chat agéntico para el panel de administración.
 *
 * Conecta con `POST /admin/copilot/chat` (bucle de function-calling). El backend
 * ejecuta las herramientas y devuelve la respuesta + la traza (qué llamó, con
 * qué args, qué devolvió). Aquí solo pintamos: nada de lógica de negocio ni
 * de tools vive en el navegador.
 *
 * Contrato del backend (ver copilot.controller/service):
 *   GET    /admin/copilot/conversations             -> [{ id, title, createdAt, updatedAt }]
 *   GET    /admin/copilot/conversations/:id/messages-> [{ id, role, content, toolTrace }]
 *   POST   /admin/copilot/chat { message, conversationId? }
 *          -> { conversationId, answer, toolTrace: [{ id, tool, args, result, ok }] }
 *   DELETE /admin/copilot/conversations/:id         -> { ok }
 */
import { api, ApiError, setToken, toast } from './api.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Icono + etiqueta legible por nombre de herramienta (la traza usa el nombre técnico). */
const TOOL_META = {
  panel: ['📊', 'Resumen'],
  listar_empleados: ['👤', 'Empleados'],
  listar_eventos: ['🎫', 'Accesos'],
  listar_puntos_acceso: ['🚪', 'Puntos de acceso'],
  listar_camaras: ['📷', 'Cámaras'],
  estado_puerta: ['🚪', 'Estado de puerta'],
  estado_sistema: ['🩺', 'Sistema'],
  novedades: ['🆕', 'Novedades'],
  resumen_operativo: ['🧭', 'Resumen operativo'],
  abrir_puerta: ['🔓', 'Abrió puerta'],
  rotar_credenciales: ['🔄', 'Rotó credenciales'],
};

const state = {
  token: '',
  ready: false,
  conversationId: null,
  conversations: [],
  sending: false,
};

/** Punto de entrada: lo llama admin.js al entrar en la pestaña Copiloto. */
export function initCopilot(token) {
  state.token = token;
  if (state.ready) { refreshConversations(); scrollBottom(); return; }
  state.ready = true;
  bind();
  refreshConversations();
  scrollBottom();
}

function bind() {
  $('cp-new').onclick = newConversation;
  $('cp-form').onsubmit = onSend;
  const ta = $('cp-input');
  ta.addEventListener('input', autosize);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('cp-form').requestSubmit(); }
  });
  document.querySelectorAll('.cp-sug').forEach((b) => (b.onclick = () => send(b.textContent.trim())));
}

function autosize() {
  const ta = $('cp-input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 140) + 'px';
}

/** Arranca una conversación nueva (limpia el panel, sin llamar al backend). */
function newConversation() {
  state.conversationId = null;
  renderConversations();
  renderEmpty();
  $('cp-input').focus();
  scrollBottom();
}

/* ── Conversaciones (sidebar) ────────────────────────────────────────────── */
async function refreshConversations() {
  try {
    state.conversations = await api.get('/admin/copilot/conversations', state.token);
    renderConversations();
  } catch (e) {
    if (!isAuth(e)) toast('No se pudieron cargar las conversaciones', 'err');
  }
}

function renderConversations() {
  const host = $('cp-conv-list');
  if (!state.conversations.length) {
    host.innerHTML = '<div class="cp-empty-list">Aún no hay conversaciones.</div>';
    return;
  }
  host.innerHTML = state.conversations
    .map((c) => {
      const active = c.id === state.conversationId ? ' active' : '';
      return `<div class="cp-conv${active}" data-id="${c.id}">
        <div class="cp-conv__t">${esc(c.title)}</div>
        <div class="cp-conv__d">${fmtDate(c.updatedAt || c.createdAt)}</div>
        <button class="cp-conv__del" data-del="${c.id}" title="Borrar">🗑</button>
      </div>`;
    })
    .join('');
  host.querySelectorAll('.cp-conv').forEach((el) => (el.onclick = () => openConversation(el.dataset.id)));
  host.querySelectorAll('.cp-conv__del').forEach((b) =>
    (b.onclick = (e) => { e.stopPropagation(); deleteConversation(b.dataset.del); }),
  );
}

async function openConversation(id) {
  state.conversationId = id;
  renderConversations();
  $('cp-messages').innerHTML = '<div class="cp-empty"><p>Cargando conversación…</p></div>';
  try {
    const msgs = await api.get(`/admin/copilot/conversations/${id}/messages`, state.token);
    if (!msgs.length) { renderEmpty(); return; }
    $('cp-messages').innerHTML = '';
    for (const m of msgs) {
      if (m.role === 'user') appendMessage('user', m.content);
      else if (m.role === 'assistant') appendMessage('assistant', m.content, m.toolTrace);
    }
    scrollBottom();
  } catch (e) {
    if (!isAuth(e)) toast('No se pudo abrir la conversación', 'err');
    renderEmpty();
  }
}

async function deleteConversation(id) {
  try {
    await api.del(`/admin/copilot/conversations/${id}`, state.token);
    state.conversations = state.conversations.filter((c) => c.id !== id);
    if (state.conversationId === id) { state.conversationId = null; renderEmpty(); }
    renderConversations();
    toast('Conversación borrada', 'ok');
  } catch (e) {
    if (!isAuth(e)) toast('No se pudo borrar', 'err');
  }
}

/* ── Enviar mensaje (bucle agéntico) ─────────────────────────────────────── */
async function onSend(e) {
  e.preventDefault();
  const text = $('cp-input').value.trim();
  if (!text || state.sending) return;
  send(text);
}

async function send(text) {
  if (state.sending) return;
  state.sending = true;
  $('cp-send').disabled = true;

  // Limpia el estado vacío y pinta el mensaje del usuario.
  if (!$('cp-messages').querySelector('.cp-msg')) $('cp-messages').innerHTML = '';
  appendMessage('user', text);
  scrollBottom();
  $('cp-input').value = '';
  autosize();
  const typing = appendTyping();

  try {
    const res = await api.post('/admin/copilot/chat', { message: text, conversationId: state.conversationId }, state.token);
    typing.remove();

    // Si era conversación nueva, anclamos el id y recargamos el sidebar (título).
    if (!state.conversationId) {
      state.conversationId = res.conversationId;
      await refreshConversations();
    } else {
      // Refresca el orden (la conversación activa sube al top por updatedAt).
      refreshConversations();
    }
    appendMessage('assistant', res.answer || '…', res.toolTrace);
    scrollBottom();
  } catch (e) {
    typing.remove();
    if (isAuth(e)) return;
    const msg = e instanceof ApiError && e.status === 429
      ? 'Demasiadas consultas. Espera unos segundos e inténtalo de nuevo.'
      : (e instanceof ApiError ? e.message : 'El copiloto no respondió. Revisa la conexión.');
    appendMessage('assistant', `⚠️ ${msg}`);
    toast(msg, 'err');
    scrollBottom();
  } finally {
    state.sending = false;
    $('cp-send').disabled = false;
    $('cp-input').focus();
  }
}

/* ── Render de mensajes ──────────────────────────────────────────────────── */
function appendMessage(role, content, toolTrace) {
  const host = $('cp-messages');
  const wrap = document.createElement('div');
  wrap.className = `cp-msg ${role}`;
  wrap.innerHTML = `
    <div class="cp-msg__ava">${role === 'user' ? '🧑‍💼' : '<img src="assets/vx-bot.svg" alt="VisionYX" style="width:1.4em;height:1.4em">'} </div>
    <div class="cp-msg__bubble">${esc(content)}</div>`;
  host.appendChild(wrap);
  if (role === 'assistant' && Array.isArray(toolTrace) && toolTrace.length) {
    host.appendChild(renderTrace(toolTrace));
  }
  return wrap;
}

/** Traza de herramientas de un turno del asistente. Chip discreto colapsado:
 *  muestra solo icono + nombre + estado; el detalle (args/resultado) queda
 *  plegado para que el admin lo abra solo si quiere, sin saturar el chat. */
function renderTrace(trace) {
  const el = document.createElement('div');
  el.className = 'cp-trace';
  el.innerHTML = trace
    .map((t) => {
      const [ico, label] = TOOL_META[t.tool] || ['🛠', t.tool];
      const okCls = t.ok ? 'ok' : 'err';
      const okTxt = t.ok ? '✓' : '✗';
      const detail = `<pre>args: ${esc(fmtJson(t.args))}\n\nresultado:\n${esc(t.result)}</pre>`;
      return `<div class="cp-tool">
        <span class="cp-tool__ico">${ico}</span>
        <span class="cp-tool__name">${esc(label)}</span>
        <span class="cp-tool__status ${okCls}">${okTxt}</span>
        <details><summary>detalle</summary>${detail}</details>
      </div>`;
    })
    .join('');
  return el;
}

function appendTyping() {
  const host = $('cp-messages');
  const wrap = document.createElement('div');
  wrap.className = 'cp-msg assistant';
  wrap.innerHTML = `<div class="cp-msg__ava"><img src="assets/vx-bot.svg" alt="VisionYX" style="width:1.4em;height:1.4em"></div><div class="cp-msg__bubble cp-typing"><span></span><span></span><span></span></div>`;
  host.appendChild(wrap);
  scrollBottom();
  return wrap;
}

function renderEmpty() {
  $('cp-messages').innerHTML = `
    <div class="cp-empty">
      <div class="cp-empty__ico">🤖</div>
      <p>Pregúntame por el estado del sistema: empleados, accesos, cámaras, puntos de acceso o la salud de los servicios.</p>
      <div class="cp-suggest">
        <button class="btn ghost sm cp-sug">¿Cuántos empleados hay registrados?</button>
        <button class="btn ghost sm cp-sug">¿Cuántas entradas hubo hoy?</button>
        <button class="btn ghost sm cp-sug">¿El sistema está saludable?</button>
      </div>
    </div>`;
  document.querySelectorAll('.cp-sug').forEach((b) => (b.onclick = () => send(b.textContent.trim())));
  scrollBottom();
}

/* ── Utilidades ──────────────────────────────────────────────────────────── */
function scrollBottom() {
  const host = $('cp-messages');
  host.scrollTop = host.scrollHeight;
}
function fmtDate(d) {
  if (!d) return '';
  const date = new Date(d);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay
    ? `Hoy · ${date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}
function fmtJson(v) {
  try { return JSON.stringify(v ?? {}); } catch { return String(v); }
}
/** True si fue 401; en ese caso expulsa la sesión (igual que el resto del panel). */
function isAuth(e) {
  if (e instanceof ApiError && e.status === 401) {
    setToken('admin_token', '');
    location.reload();
    return true;
  }
  return false;
}
