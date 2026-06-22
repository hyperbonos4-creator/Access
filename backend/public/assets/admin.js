import { api, ApiError, getToken, setToken, toast, fileToBase64 } from './api.js';

const TOKEN_KEY = 'admin_token';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* Etiquetas legibles (los códigos técnicos quedan solo en logs/API). */
const T = {
  status: { ACTIVE: 'Activo', DISABLED: 'Inactivo', REVOKED: 'Revocado' },
  kind: { EMPLOYEE: 'Empleado', CONTRACTOR: 'Contratista', STAFF: 'Personal' },
  sec: { NORMAL: 'Normal (vida pasiva)', HIGH: 'Alta (exige reto)' },
  controller: {
    SIMULATED: 'Modo simulación', HTTP: 'Controlador HTTP/Relé', RELAY: 'Relé',
    HIKVISION_ISAPI: 'Controlador Hikvision', NONE: 'Sin controlador',
  },
  apkind: { PEDESTRIAN: 'Puerta peatonal' },
  decision: { GRANTED: 'Acceso concedido', DENIED: 'Acceso denegado' },
  reason: {
    MATCHED: 'Reconocido', UNKNOWN_SUBJECT: 'Persona no registrada',
    LIVENESS_FAILED: 'Prueba de vida fallida', CHALLENGE_REQUIRED: 'Requiere reto activo',
    NOT_AUTHORIZED: 'No autorizado', OUT_OF_SCHEDULE: 'Fuera de horario',
    NO_CONSENT: 'Sin consentimiento', MANUAL: 'Apertura manual',
  },
};
const tr = (map, v) => map[v] ?? v;

const state = {
  token: getToken(TOKEN_KEY),
  tab: 'cameras',
  cameras: [],
  points: [],
  subjects: [],
  enroll: { subjectId: null, base64: null, stream: null },
};

boot();

function boot() {
  bindGlobal();
  if (!state.token) show('modal-login');
  else init();
}

function bindGlobal() {
  $('btn-login').onclick = doLogin;
  $('login-pass').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  $('btn-logout').onclick = () => { setToken(TOKEN_KEY, ''); location.reload(); };
  document.querySelectorAll('.nav-item').forEach((b) => (b.onclick = () => switchTab(b.dataset.tab)));

  $('cam-create').onclick = createCamera;
  $('cam-mode-device').onclick = chooseDeviceCam;
  $('cam-mode-ip').onclick = () => showIpForm(false);
  $('cam-mode-nvr').onclick = () => showIpForm(true);
  $('cam-back-1').onclick = resetCamOnboard;
  $('cam-back-2').onclick = resetCamOnboard;
  $('cam-help-toggle').onclick = () => $('cam-help').classList.toggle('hidden');
  $('cam-go-enroll').onclick = () => switchTab('subjects');
  $('pt-create').onclick = createPoint;
  $('pt-level').onclick = (e) => { const b = e.target.closest('[data-lvl]'); if (b) setLevel(b.dataset.lvl); };
  $('pt-controller').onchange = updateRefField;
  $('pt-ref-help-toggle').onclick = () => $('pt-ref-help').classList.toggle('hidden');
  $('pt-match').oninput = () => { $('pt-match-val').textContent = $('pt-match').value + '%'; };
  $('pt-live').oninput = () => { $('pt-live-val').textContent = $('pt-live').value + '%'; };
  $('sub-create').onclick = createSubject;
  $('sub-refresh').onclick = loadSubjects;
  $('ev-refresh').onclick = loadEvents;
  $('sys-refresh').onclick = loadDiagnostics;

  // Enroll modal
  $('enroll-close').onclick = closeEnroll;
  $('enroll-ipcap').onclick = captureFromIp;
  $('enroll-cam').onclick = startWebcam;
  $('enroll-snap').onclick = snapWebcam;
  $('enroll-file').onchange = pickFile;
  $('enroll-submit').onclick = submitEnroll;
}

async function doLogin() {
  const email = $('login-email').value.trim();
  const password = $('login-pass').value;
  if (!email || !password) return toast('Ingrese credenciales', 'err');
  $('btn-login').disabled = true;
  try {
    const r = await api.post('/auth/login', { email, password });
    state.token = r.token;
    setToken(TOKEN_KEY, r.token);
    hide('modal-login');
    init();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'Error de login', 'err');
  } finally {
    $('btn-login').disabled = false;
  }
}

async function init() {
  try {
    const me = await api.get('/auth/me', state.token);
    $('who').textContent = `${me.name} · ${me.role}`;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { setToken(TOKEN_KEY, ''); return show('modal-login'); }
  }
  checkVision();
  switchTab('cameras');
}

async function checkVision() {
  try {
    const h = await api.get('/access/health', state.token);
    const el = $('vision-health');
    el.textContent = h.ok ? '🟢 Vision en línea' : '🟠 Vision degradado';
    el.className = 'pill ' + (h.ok ? 'ok' : 'warn');
  } catch {
    $('vision-health').textContent = '🔴 Vision sin responder';
    $('vision-health').className = 'pill danger';
  }
}

function switchTab(tab) {
  state.tab = tab;
  stopDoorPoll();
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
  $(`tab-${tab}`).classList.remove('hidden');
  if (tab === 'cameras') { resetCamOnboard(); loadCameras(); }
  if (tab === 'points') { setLevel(state.ptLevel || 'NORMAL'); updateRefField(); loadCameras().then(fillCamSelect); loadPoints(); startDoorPoll(); }
  if (tab === 'subjects') { loadPoints(); loadSubjects(); }
  if (tab === 'events') loadEvents();
  if (tab === 'system') loadDiagnostics();
}

function guard(e) {
  if (e instanceof ApiError && e.status === 401) { setToken(TOKEN_KEY, ''); show('modal-login'); return true; }
  toast(e instanceof ApiError ? e.message : 'Error de red', 'err');
  return false;
}

/* ── Cámaras ────────────────────────────────────────────────────────────── */
function resetCamOnboard() {
  $('cam-onboard').classList.remove('hidden');
  $('cam-ip-form').classList.add('hidden');
  $('cam-device-done').classList.add('hidden');
}
function showIpForm(isNvr) {
  $('cam-onboard').classList.add('hidden');
  $('cam-device-done').classList.add('hidden');
  $('cam-ip-form').classList.remove('hidden');
  $('cam-ip-title').textContent = isNvr ? 'Conectar grabador NVR' : 'Conectar cámara IP';
  $('cam-nvr-field').style.display = isNvr ? '' : 'none';
}
/**
 * "Usar la cámara de este dispositivo": no requiere cámara IP. El kiosko usa la
 * webcam (recognize-image). Aseguramos que exista un punto de acceso usable y
 * guiamos al usuario a registrar un rostro y abrir el kiosko.
 */
async function chooseDeviceCam() {
  try {
    const points = await api.get('/access/points', state.token);
    if (!points.length) {
      await api.post(
        '/access/points',
        { name: 'Puerta (cámara del dispositivo)', controllerKind: 'SIMULATED', matchThreshold: 0.45, livenessThreshold: 0.5 },
        state.token,
      );
      toast('Punto de acceso creado', 'ok');
    }
    $('cam-onboard').classList.add('hidden');
    $('cam-device-done').classList.remove('hidden');
  } catch (e) { guard(e); }
}

async function loadCameras() {
  try { state.cameras = await api.get('/cameras', state.token); renderCameras(); }
  catch (e) { guard(e); }
}
function renderCameras() {
  const host = $('cam-list');
  if (!state.cameras.length) return (host.innerHTML = '<div class="empty">Sin cámaras aún.</div>');
  host.innerHTML = state.cameras.map((c) => `
    <div class="item">
      <div class="spread">
        <div><h4>${esc(c.name)}</h4><div class="sub">${c.externalKey ? 'clave: ' + esc(c.externalKey) + ' · ' : ''}canal NVR: ${c.nvrChannel ?? 0} · <span class="tag">${esc(tr(T.status, c.status))}</span></div></div>
        <button class="btn danger sm" data-del="${c.id}">Eliminar</button>
      </div>
    </div>`).join('');
  host.querySelectorAll('[data-del]').forEach((b) => (b.onclick = () => delCamera(b.dataset.del)));
}
async function createCamera() {
  const body = {
    name: $('cam-name').value.trim(),
    rtspUrl: $('cam-rtsp').value.trim(),
    externalKey: $('cam-key').value.trim() || undefined,
    nvrChannel: Number($('cam-nvr').value) || 0,
  };
  if (!body.name || !body.rtspUrl) return toast('Nombre y RTSP son obligatorios', 'err');
  try {
    await api.post('/cameras', body, state.token);
    toast('Cámara creada', 'ok');
    ['cam-name', 'cam-rtsp', 'cam-key'].forEach((id) => ($(id).value = ''));
    resetCamOnboard();
    loadCameras();
  } catch (e) { guard(e); }
}
async function delCamera(id) {
  if (!confirm('¿Eliminar esta cámara?')) return;
  try { await api.del(`/cameras/${id}`, state.token); loadCameras(); } catch (e) { guard(e); }
}

/* ── Puntos de acceso ───────────────────────────────────────────────────── */
async function loadPoints() {
  try { state.points = await api.get('/access/points', state.token); if (state.tab === 'points') renderPoints(); }
  catch (e) { guard(e); }
}
function fillCamSelect() {
  const sel = $('pt-cam');
  sel.innerHTML = '<option value="">📱 Cámara de este dispositivo (webcam)</option>' +
    state.cameras.map((c) => `<option value="${c.id}">📷 ${esc(c.name)}</option>`).join('');
}

/* Niveles de seguridad: traducen "negocio" → umbrales e ingeniería. */
const PT_LEVELS = {
  LOW:    { sec: 'NORMAL', match: 40, live: 40, desc: ['Coincidencia facial mínima 40%', 'Verificación de vida 40%', 'Acceso rápido y permisivo'] },
  NORMAL: { sec: 'NORMAL', match: 50, live: 60, desc: ['Coincidencia facial mínima 50%', 'Verificación de vida 60%', 'Equilibrio recomendado'] },
  HIGH:   { sec: 'NORMAL', match: 62, live: 75, desc: ['Coincidencia facial mínima 62%', 'Verificación de vida 75%', 'Más estricto contra falsos positivos'] },
  MAX:    { sec: 'HIGH',   match: 72, live: 85, desc: ['Coincidencia facial mínima 72%', 'Verificación de vida 85%', 'Exige reto de vida activo (gira / parpadea)', 'Auditoría completa'] },
};
function setLevel(lvl) {
  const p = PT_LEVELS[lvl] || PT_LEVELS.NORMAL;
  state.ptLevel = lvl;
  document.querySelectorAll('#pt-level [data-lvl]').forEach((b) => b.classList.toggle('active', b.dataset.lvl === lvl));
  $('pt-match').value = p.match; $('pt-match-val').textContent = p.match + '%';
  $('pt-live').value = p.live; $('pt-live-val').textContent = p.live + '%';
  $('pt-consequences').innerHTML = '<b>Con este nivel:</b><ul>' + p.desc.map((d) => `<li>✓ ${d}</li>`).join('') + '</ul>';
}
function updateRefField() {
  const k = $('pt-controller').value;
  const needsRef = k === 'HTTP' || k === 'HIKVISION_ISAPI';
  $('pt-ref-field').classList.toggle('hidden', !needsRef);
}

function renderPoints() {
  const host = $('pt-list');
  if (!state.points.length) return (host.innerHTML = '<div class="empty">Aún no has creado un punto de acceso.</div>');
  const camName = (id) => (state.cameras.find((c) => c.id === id)?.name) || (id ? 'Cámara IP' : 'Cámara del dispositivo');
  host.innerHTML = state.points.map((p) => `
    <div class="item ptcard">
      <div class="spread">
        <div>
          <h4><span class="dot ok"></span> ${esc(p.name)}</h4>
          <div class="ptmeta">
            <span>📷 ${esc(camName(p.cameraId))}</span>
            <span>🧠 Facial + vida</span>
            <span>🎛 ${esc(tr(T.controller, p.controllerKind || 'NONE'))}</span>
            <span>🎯 ${Math.round(p.matchThreshold * 100)}%</span>
            <span>🫥 ${Math.round(p.livenessThreshold * 100)}%</span>
            ${p.securityLevel === 'HIGH' ? '<span class="tag">Reto activo</span>' : ''}
          </div>
          <div class="sub faint" data-doorinfo="${p.id}">Puerta en espera</div>
        </div>
        <span class="pill" data-doorstate="${p.id}">🔒 Cerrada</span>
      </div>
      <div class="item-actions">
        <button class="btn sm" data-dooropen="${p.id}">🚪 Probar apertura</button>
        <button class="btn ghost sm" data-evpoint="${p.id}">📋 Ver eventos</button>
        <a class="btn ghost sm" href="/kiosk/" target="_blank" rel="noopener">🖥 Abrir kiosko</a>
      </div>
    </div>`).join('');
  host.querySelectorAll('[data-dooropen]').forEach((b) => (b.onclick = () => testOpenDoor(b.dataset.dooropen)));
  host.querySelectorAll('[data-evpoint]').forEach((b) => (b.onclick = () => switchTab('events')));
}

const DOOR_TXT = { CLOSED: '🔒 Cerrada', OPENING: '🟢 Abriendo…', OPEN: '🚪 Abierta', CLOSING: '🔒 Cerrando…' };
async function testOpenDoor(id) {
  try {
    await api.post(`/access/points/${id}/door/test-open`, {}, state.token);
    toast('Apertura de prueba enviada', 'ok');
  } catch (e) { guard(e); }
}
function startDoorPoll() {
  stopDoorPoll();
  pollDoors();
  state.doorTimer = setInterval(pollDoors, 800);
}
function stopDoorPoll() {
  if (state.doorTimer) clearInterval(state.doorTimer);
  state.doorTimer = null;
}
async function pollDoors() {
  for (const p of state.points) {
    try {
      const d = await api.get(`/access/points/${p.id}/door-status`, state.token);
      const el = document.querySelector(`[data-doorstate="${p.id}"]`);
      if (el) {
        el.textContent = DOOR_TXT[d.state] || DOOR_TXT.CLOSED;
        el.className = 'pill ' + (d.state === 'OPEN' || d.state === 'OPENING' ? 'ok' : d.state === 'CLOSING' ? 'warn' : '');
      }
      const info = document.querySelector(`[data-doorinfo="${p.id}"]`);
      if (info) {
        if (d.state === 'OPEN') {
          info.textContent = `Abierta · re-bloqueo en ${Math.ceil((d.remainingMs || 0) / 1000)}s` + (d.lastOpenedBy ? ` · ${d.lastOpenedBy}` : '');
        } else if (d.lastOpenedAt) {
          info.textContent = `Última apertura: ${d.lastOpenedBy || '—'} · ${new Date(d.lastOpenedAt).toLocaleString()}`;
        } else {
          info.textContent = 'Puerta en espera';
        }
      }
    } catch { /* silencioso */ }
  }
}
async function createPoint() {
  const controller = $('pt-controller').value;
  const needsRef = controller === 'HTTP' || controller === 'HIKVISION_ISAPI';
  const body = {
    name: $('pt-name').value.trim(),
    kind: 'PEDESTRIAN',
    cameraId: $('pt-cam').value || undefined,
    securityLevel: (PT_LEVELS[state.ptLevel] || PT_LEVELS.NORMAL).sec,
    controllerKind: controller,
    controllerRef: needsRef ? ($('pt-ref').value.trim() || undefined) : undefined,
    matchThreshold: Number($('pt-match').value) / 100,
    livenessThreshold: Number($('pt-live').value) / 100,
  };
  if (!body.name) return toast('El nombre es obligatorio', 'err');
  try {
    await api.post('/access/points', body, state.token);
    toast('Punto de acceso creado', 'ok');
    $('pt-name').value = ''; $('pt-ref').value = '';
    loadPoints();
  } catch (e) { guard(e); }
}

/* ── Empleados ──────────────────────────────────────────────────────────── */
async function loadSubjects() {
  try { state.subjects = await api.get('/access/subjects', state.token); renderSubjects(); }
  catch (e) { guard(e); }
}
function initials(n) {
  return String(n || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase() || '?';
}
function renderSubjects() {
  const host = $('sub-list');
  if (!state.subjects.length) return (host.innerHTML = '<div class="empty">Aún no has incorporado ninguna identidad.</div>');
  host.innerHTML = state.subjects.map((s) => {
    const access = !!s.hasBiometrics; // puerta única: autorizado automáticamente al enrolar
    const done = (s.hasConsent ? 1 : 0) + (s.hasBiometrics ? 1 : 0) + (access ? 1 : 0);
    const pct = Math.round((done / 3) * 100);
    const chk = (ok, label, extra = '') => `<li class="${ok ? 'done' : ''}">${ok ? '✓' : '○'} ${label}${extra}</li>`;
    const last = s.lastAccessAt ? `Último acceso: ${new Date(s.lastAccessAt).toLocaleString()}` : 'Sin accesos registrados';
    let cta;
    if (!s.hasConsent) cta = `<button class="btn sm" data-consent="${s.id}">1 · Registrar consentimiento</button>`;
    else if (!s.hasBiometrics) cta = `<button class="btn sm" data-guided="${s.id}" data-name="${esc(s.fullName)}">2 · Registrar rostro (guiado)</button>`;
    else cta = `<span class="pill ok">✓ Identidad completa</span>`;
    return `
    <div class="item idcard">
      <div class="idhead">
        <div class="avatar">${esc(initials(s.fullName))}</div>
        <div style="flex:1;min-width:0">
          <h4>${esc(s.fullName)}</h4>
          <div class="sub">${esc(tr(T.kind, s.kind))}${s.employeeCode ? ' · #' + esc(s.employeeCode) : ''}</div>
        </div>
        <span class="pill ${s.status === 'ACTIVE' ? 'ok' : 'warn'}">${s.status === 'ACTIVE' ? '🟢 Activa' : '⚪ Inactiva'}</span>
      </div>
      <div class="prog"><div class="prog__bar"><i style="width:${pct}%"></i></div><span>Perfil ${pct}%</span></div>
      <ul class="checklist">
        ${chk(s.hasConsent, 'Consentimiento')}
        ${chk(s.hasBiometrics, 'Rostro registrado')}
        ${chk(access, 'Accesos asignados', access ? '' : ' <span class="faint">(automáticos al registrar el rostro)</span>')}
      </ul>
      <div class="sub faint">${last}</div>
      <div class="item-actions">
        ${cta}
        <details class="bio-menu"><summary>Gestionar biometría</summary>
          <div class="bio-menu__body">
            <button class="btn ghost sm" data-guided="${s.id}" data-name="${esc(s.fullName)}">✨ Registro guiado (recomendado)</button>
            <button class="btn ghost sm" data-enroll="${s.id}" data-name="${esc(s.fullName)}">📷 Foto simple</button>
            <button class="btn ghost sm" data-consent="${s.id}">📝 Registrar consentimiento</button>
            <button class="btn danger sm" data-erase="${s.id}">Eliminar biometría</button>
          </div>
        </details>
        <button class="btn ghost sm" data-toggle="${s.id}" data-status="${s.status}">${s.status === 'ACTIVE' ? 'Desactivar' : 'Activar'}</button>
      </div>
    </div>`;
  }).join('');
  host.querySelectorAll('[data-consent]').forEach((b) => (b.onclick = () => grantConsent(b.dataset.consent)));
  host.querySelectorAll('[data-guided]').forEach((b) => (b.onclick = () => openGuided(b.dataset.guided, b.dataset.name)));
  host.querySelectorAll('[data-enroll]').forEach((b) => (b.onclick = () => openEnroll(b.dataset.enroll, b.dataset.name)));
  host.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = () => toggleSubject(b.dataset.toggle, b.dataset.status)));
  host.querySelectorAll('[data-erase]').forEach((b) => (b.onclick = () => eraseBio(b.dataset.erase)));
}
async function createSubject() {
  const body = {
    fullName: $('sub-name').value.trim(),
    kind: $('sub-kind').value,
    employeeCode: $('sub-code').value.trim() || undefined,
  };
  if (!body.fullName) return toast('El nombre es obligatorio', 'err');
  try {
    await api.post('/access/subjects', body, state.token);
    toast('Identidad incorporada', 'ok');
    $('sub-name').value = ''; $('sub-code').value = '';
    loadSubjects();
  } catch (e) { guard(e); }
}
async function grantConsent(id) {
  if (!confirm('Registrar consentimiento biométrico ACTIVE para este empleado?')) return;
  try {
    await api.post(`/access/subjects/${id}/consent`, { purpose: 'Control de acceso facial — oficina', policyVersion: '1.0' }, state.token);
    toast('Consentimiento registrado', 'ok');
    loadSubjects();
  } catch (e) { guard(e); }
}
async function toggleSubject(id, status) {
  const next = status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE';
  try { await api.patch(`/access/subjects/${id}`, { status: next }, state.token); loadSubjects(); } catch (e) { guard(e); }
}
async function eraseBio(id) {
  if (!confirm('Borrar TODA la biometría del empleado (irreversible)?')) return;
  try { const r = await api.del(`/access/subjects/${id}/biometrics`, state.token); toast(`Biometría borrada (${r.deletedTemplates} plantillas)`, 'ok'); loadSubjects(); }
  catch (e) { guard(e); }
}

/* ── Enrolamiento (modal) ───────────────────────────────────────────────── */
/** Garantiza el consentimiento biométrico antes de capturar (demo: se registra
 *  automáticamente si falta; en producción puede exigirse el paso explícito). */
function ensureConsent(id) {
  const s = state.subjects.find((x) => x.id === id);
  if (s && s.hasConsent) return;
  api.post(
    `/access/subjects/${id}/consent`,
    { purpose: 'Control de acceso facial — registro', policyVersion: '1.0' },
    state.token,
  ).then(() => loadSubjects()).catch(() => {});
}

/** Registro guiado por liveness activo (gira/parpadea en vivo). */
function openGuided(id, name) {
  ensureConsent(id); // en segundo plano: para no perder el gesto que abre la ventana
  const url = `enroll.html?subjectId=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}`;
  window.open(url, '_blank', 'noopener');
}

function openEnroll(id, name) {
  ensureConsent(id);
  state.enroll = { subjectId: id, base64: null, stream: null };
  $('enroll-title').textContent = `Enrolar rostro — ${name}`;
  $('enroll-shot').classList.add('hidden');
  $('enroll-video').classList.add('hidden');
  $('enroll-placeholder').classList.remove('hidden');
  $('enroll-submit').disabled = true;
  $('enroll-snap').disabled = true;
  // Puntos de acceso disponibles para capturar de su cámara IP.
  const sel = $('enroll-point');
  sel.innerHTML = state.points.length
    ? state.points.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')
    : '<option value="" disabled selected>cree un punto con cámara</option>';
  $('enroll-ipcap').disabled = state.points.length === 0;
  show('modal-enroll');
}
function closeEnroll() {
  stopWebcam();
  hide('modal-enroll');
}

/** Captura un frame de la cámara IP del punto seleccionado (la misma que reconoce). */
async function captureFromIp() {
  const ptId = $('enroll-point').value;
  if (!ptId) return toast('Seleccione un punto de acceso con cámara', 'err');
  const btn = $('enroll-ipcap');
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = 'Capturando…';
  try {
    const res = await fetch(`/api/v1/access/points/${ptId}/snapshot`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    if (!res.ok) throw new Error(res.status === 503 ? 'cámara no responde' : `HTTP ${res.status}`);
    const blob = await res.blob();
    state.enroll.base64 = await fileToBase64(blob);
    const img = $('enroll-shot');
    img.src = `data:image/jpeg;base64,${state.enroll.base64}`;
    img.classList.remove('hidden');
    $('enroll-video').classList.add('hidden');
    $('enroll-placeholder').classList.add('hidden');
    stopWebcam();
    $('enroll-submit').disabled = false;
    toast('Frame capturado de la cámara de la puerta', 'ok');
  } catch (e) {
    toast(`No se pudo capturar de la cámara IP: ${e.message}`, 'err');
  } finally {
    btn.disabled = false;
    btn.textContent = prev;
  }
}

async function startWebcam() {
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('sin soporte de cámara');
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: 1280 } });
    state.enroll.stream = stream;
    const v = $('enroll-video');
    v.srcObject = stream;
    v.classList.remove('hidden');
    $('enroll-shot').classList.add('hidden');
    $('enroll-placeholder').classList.add('hidden');
    $('enroll-snap').disabled = false;
  } catch (e) {
    toast(`Webcam del navegador no disponible (${e.name || e.message}). Usa “Capturar” de la cámara IP o sube una foto.`, 'err');
  }
}
function stopWebcam() {
  if (state.enroll.stream) { state.enroll.stream.getTracks().forEach((t) => t.stop()); state.enroll.stream = null; }
}
function snapWebcam() {
  const v = $('enroll-video');
  const canvas = document.createElement('canvas');
  canvas.width = v.videoWidth; canvas.height = v.videoHeight;
  canvas.getContext('2d').drawImage(v, 0, 0);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
  state.enroll.base64 = dataUrl.split(',')[1];
  const img = $('enroll-shot');
  img.src = dataUrl; img.classList.remove('hidden');
  v.classList.add('hidden');
  $('enroll-placeholder').classList.add('hidden');
  stopWebcam();
  $('enroll-submit').disabled = false;
}
async function pickFile(e) {
  const file = e.target.files?.[0];
  if (!file) return;
  state.enroll.base64 = await fileToBase64(file);
  const img = $('enroll-shot');
  img.src = `data:${file.type || 'image/jpeg'};base64,${state.enroll.base64}`;
  img.classList.remove('hidden');
  $('enroll-video').classList.add('hidden');
  $('enroll-placeholder').classList.add('hidden');
  stopWebcam();
  $('enroll-submit').disabled = false;
}
async function submitEnroll() {
  if (!state.enroll.base64) return;
  $('enroll-submit').disabled = true;
  try {
    await api.post(`/access/subjects/${state.enroll.subjectId}/enroll`, { imageB64: state.enroll.base64 }, state.token);
    toast('Rostro enrolado correctamente', 'ok');
    closeEnroll();
    loadSubjects();
  } catch (e) {
    let msg = e instanceof ApiError ? e.message : 'Error';
    const reasons = {
      no_active_consent: 'Falta registrar el Consentimiento del empleado (botón “Consentimiento”).',
      NO_FACE: 'No se detectó un rostro en la imagen.',
      MULTIPLE_FACES: 'Hay más de un rostro en la imagen; debe haber solo uno.',
      LOW_QUALITY: 'Calidad/iluminación insuficiente; acércate y mejora la luz.',
      SPOOF_SUSPECTED: 'Posible suplantación (foto/pantalla) detectada.',
      vision_service_unavailable: 'El servicio de visión no responde.',
    };
    if (reasons[msg]) msg = reasons[msg];
    else if (e instanceof ApiError && e.body?.reason && reasons[e.body.reason]) msg = reasons[e.body.reason];
    toast(msg, 'err');
    $('enroll-submit').disabled = false;
  }
}

/* ── Eventos ────────────────────────────────────────────────────────────── */
async function loadEvents() {
  try {
    const evs = await api.get('/access/events?limit=50', state.token);
    const host = $('ev-list');
    if (!evs.length) return (host.innerHTML = '<div class="empty">Sin eventos registrados.</div>');
    host.innerHTML = evs.map((e) => {
      const ok = e.decision === 'GRANTED';
      return `<div class="item"><div class="spread">
        <div><h4>${ok ? '✔' : '✕'} ${esc(tr(T.decision, e.decision))} <span class="muted" style="font-weight:400">· ${esc(tr(T.reason, e.reason))}</span></h4>
        <div class="sub">${new Date(e.recordedAt).toLocaleString()} · coincidencia ${e.matchScore != null ? Math.round(e.matchScore * 100) + '%' : '—'} · vida ${e.livenessScore != null ? Math.round(e.livenessScore * 100) + '%' : '—'}</div></div>
        <span class="pill ${ok ? 'ok' : 'danger'}">${e.doorActuated ? '🔓 abierta' : '🔒 cerrada'}</span>
      </div></div>`;
    }).join('');
  } catch (e) { guard(e); }
}

/* ── Diagnóstico del sistema ────────────────────────────────────────────── */
async function loadDiagnostics() {
  const host = $('sys-list');
  host.innerHTML = '<div class="empty">Consultando estado…</div>';
  const row = (label, ok, detail) => `
    <div class="item"><div class="spread">
      <div><h4>${label}</h4><div class="sub">${detail || ''}</div></div>
      <span class="pill ${ok ? 'ok' : 'danger'}">${ok ? '🟢 Operativo' : '🔴 Falla'}</span>
    </div></div>`;
  try {
    const d = await api.get('/access/diagnostics', state.token);
    const comps = d.vision?.detail?.components || [];
    const qdrant = comps.find((c) => c.name === 'qdrant');
    let html = '';
    html += row('Reconocimiento facial (Visión)', !!d.vision?.ok, 'Identificación + prueba de vida');
    html += row('Base de datos', !!d.database?.ok, 'Empleados, permisos y bitácora');
    if (qdrant) html += row('Índice biométrico (Qdrant)', !!qdrant.ok, 'Almacén de rostros');
    for (const c of d.cameras || []) {
      const det = c.hasCamera
        ? (c.cameraName ? esc(c.cameraName) : '') + (c.lastFrameAt ? ` · último cuadro ${new Date(c.lastFrameAt).toLocaleTimeString()}` : ' · sin señal')
        : 'Sin cámara asignada';
      html += row(`Cámara · ${esc(c.name)}`, c.ok, det);
      html += row(`Controlador de puerta · ${esc(c.name)}`, true, tr(T.controller, c.controllerKind || 'NONE'));
    }
    host.innerHTML = html || '<div class="empty">Sin componentes.</div>';
  } catch (e) {
    if (!guard(e)) host.innerHTML = '<div class="empty">No se pudo consultar el estado.</div>';
  }
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
