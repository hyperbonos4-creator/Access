import { api, ApiError, getToken, setToken, toast } from './api.js';

const TOKEN_KEY = 'kiosk_device_token';
const POINT_KEY = 'kiosk_point_id';
const POLL_KEY = 'kiosk_poll_ms';
// Modo webcam: usa la cámara del navegador y el endpoint /recognize-image.
// Útil para equipos sin cámara IP y para el demo público (host demo.*).
const WEBCAM =
  new URLSearchParams(location.search).get('source') === 'webcam' ||
  location.hostname.startsWith('demo.');

const REASON_TEXT = {
  MATCHED: 'Identidad verificada',
  UNKNOWN_SUBJECT: 'Rostro no reconocido',
  LIVENESS_FAILED: 'Prueba de vida fallida (posible foto)',
  CHALLENGE_REQUIRED: 'Requiere reto de vida activo',
  NOT_AUTHORIZED: 'Sin autorización en este punto',
  OUT_OF_SCHEDULE: 'Fuera del horario permitido',
  NO_CONSENT: 'Sin consentimiento biométrico',
  MANUAL: 'Apertura manual del operador',
};

const $ = (id) => document.getElementById(id);

const state = {
  token: getToken(TOKEN_KEY),
  pointId: localStorage.getItem(POINT_KEY) || '',
  pollMs: Number(localStorage.getItem(POLL_KEY) || 1500),
  points: [],
  timer: null,
  busy: false,
  polling: false,
  failCount: 0,
  lastEventId: null,
  idleResetAt: 0,
  webcamStream: null,
  webcamVideo: null,
  spokenKey: null, // evita repetir el anuncio de voz en cada tick del polling
};

const MAX_BACKOFF_MS = 15000;

/* ── Arranque ───────────────────────────────────────────────────────────── */
consumeAutoLoginToken();
bindEvents();
if (!state.token) {
  show('modal-login');
} else {
  init();
}

/* Auto-login del demo: si la URL trae `#t=<jwt>` (y opcionalmente `&p=<pointId>`),
   adopta la sesión sin pedir login y limpia el hash. El token viaja en el
   fragmento (#), que el navegador NO envía al servidor. */
function consumeAutoLoginToken() {
  if (!location.hash || location.hash.length < 2) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const t = params.get('t');
  const p = params.get('p');
  if (t) {
    setToken(TOKEN_KEY, t);
    state.token = t;
  }
  if (p) {
    state.pointId = p;
    localStorage.setItem(POINT_KEY, p);
  }
  history.replaceState(null, '', location.pathname + location.search);
}

function bindEvents() {
  $('btn-login').onclick = doLogin;
  $('login-pass').addEventListener('keydown', (e) => e.key === 'Enter' && doLogin());
  $('btn-settings').onclick = () => openSettings();
  $('btn-close-settings').onclick = () => hide('modal-settings');
  $('btn-save-settings').onclick = saveSettings;
  $('btn-logout').onclick = logout;
  $('btn-manual').onclick = manualOpen;
  // Desbloqueo de audio/voz: los navegadores exigen un gesto del usuario.
  // El kiosko puede autoarrancar (token guardado), así que escuchamos el
  // primer toque/click en cualquier parte una sola vez.
  window.addEventListener('pointerdown', primeAudio, { once: true });
}

/* ── Sesión ─────────────────────────────────────────────────────────────── */
async function doLogin() {
  const email = $('login-email').value.trim();
  const password = $('login-pass').value;
  if (!email || !password) return toast('Ingrese correo y contraseña', 'err');
  $('btn-login').disabled = true;
  primeAudio(); // gesto del usuario: desbloquea voz (clave en iPhone)
  try {
    const r = await api.post('/access/kiosk/session', { email, password });
    state.token = r.token;
    setToken(TOKEN_KEY, r.token);
    hide('modal-login');
    toast(`Terminal activada · ${r.name}`, 'ok');
    await init();
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'No se pudo iniciar sesión', 'err');
  } finally {
    $('btn-login').disabled = false;
  }
}

function logout() {
  stopPolling();
  stopDoorPoll();
  if (state.webcamStream) { state.webcamStream.getTracks().forEach((t) => t.stop()); state.webcamStream = null; }
  setToken(TOKEN_KEY, '');
  state.token = '';
  hide('modal-settings');
  show('modal-login');
}

/* ── Inicialización ─────────────────────────────────────────────────────── */
async function init() {
  try {
    state.points = await api.get('/access/points', state.token);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return logout();
    setConn('down', 'Backend no disponible');
    return toast('No se pudieron cargar los puntos de acceso', 'err');
  }
  const valid = state.points.find((p) => p.id === state.pointId);
  if (!valid) {
    if (state.points.length === 1) {
      state.pointId = state.points[0].id;
      localStorage.setItem(POINT_KEY, state.pointId);
    } else {
      openSettings();
      return;
    }
  }
  startPoint();
}

function startPoint() {
  const point = state.points.find((p) => p.id === state.pointId);
  if (!point) return openSettings();
  $('point-name').textContent = point.name;
  attachStream();
  startPolling();
  startDoorPoll();
}

/* ── Stream MJPEG (cámara IP) o webcam del navegador ────────────────────── */
async function attachStream() {
  if (WEBCAM) return attachWebcam();
  const img = $('preview');
  try {
    const { token } = await api.get(`/access/points/${state.pointId}/stream-token`, state.token);
    img.onload = () => {
      img.classList.add('ready');
      $('video-empty').classList.add('hidden');
      setConn('live', 'En línea');
    };
    img.onerror = () => setConn('down', 'Cámara sin señal');
    img.src = `/api/v1/access/points/${state.pointId}/stream.mjpeg?token=${encodeURIComponent(token)}`;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return logout();
    setConn('down', 'Sin stream');
  }
}

/* ── Webcam del navegador (modo ?source=webcam) ─────────────────────────── */
async function attachWebcam() {
  const img = $('preview');
  if (img) img.style.display = 'none';
  let video = document.getElementById('webcam');
  if (!video) {
    video = document.createElement('video');
    video.id = 'webcam';
    video.autoplay = true; video.playsInline = true; video.muted = true;
    video.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block';
    (img ? img.parentElement : document.querySelector('.video-wrap')).prepend(video);
  }
  try {
    state.webcamStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: 1280, height: 720 }, audio: false,
    });
    video.srcObject = state.webcamStream;
    await video.play().catch(() => {});
    state.webcamVideo = video;
    $('video-empty').classList.add('hidden');
    setConn('live', 'Webcam en línea');
  } catch (e) {
    setConn('down', 'Sin acceso a la webcam');
  }
}

function grabWebcamFrame() {
  const v = state.webcamVideo;
  if (!v || !v.videoWidth) return null;
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', 0.82);
}

/* ── Polling de reconocimiento (con backoff cuando la cámara no responde) ── */
function startPolling() {
  stopPolling();
  setScanning(true);
  state.failCount = 0;
  state.polling = true;
  scheduleTick(0);
}
function scheduleTick(delay) {
  if (!state.polling) return;
  state.timer = setTimeout(tick, delay);
}
function stopPolling() {
  state.polling = false;
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
}

/* ── Estado de la puerta en vivo (CERRADA/ABRIENDO/ABIERTA/CERRANDO) ─────── */
let doorTimer = null;
const DOOR_TXT = {
  CLOSED: '🔒 Puerta cerrada',
  OPENING: '🟢 Abriendo…',
  OPEN: '🚪 Puerta abierta',
  CLOSING: '🔒 Cerrando…',
};
function startDoorPoll() {
  stopDoorPoll();
  pollDoor();
  doorTimer = setInterval(pollDoor, 700);
}
function stopDoorPoll() {
  if (doorTimer) clearInterval(doorTimer);
  doorTimer = null;
}
async function pollDoor() {
  if (!state.pointId) return;
  try {
    renderDoor(await api.get(`/access/points/${state.pointId}/door-status`, state.token));
  } catch { /* silencioso: el estado de puerta no debe tumbar el kiosko */ }
}
function renderDoor(d) {
  const vis = $('door-visual');
  const live = $('door-live');
  vis.className = 'door-visual state-' + String(d.state || 'CLOSED').toLowerCase();
  live.classList.toggle('is-open', d.state === 'OPEN' || d.state === 'OPENING');
  live.classList.toggle('is-closing', d.state === 'CLOSING');
  $('door-state').textContent = DOOR_TXT[d.state] || DOOR_TXT.CLOSED;
  const bar = $('door-countbar');
  if (d.state === 'OPEN') {
    const secs = Math.ceil((d.remainingMs || 0) / 1000);
    $('door-sub').textContent =
      `Re-bloqueo automático en ${secs}s` + (d.lastOpenedBy ? ` · ${d.lastOpenedBy}` : '');
    bar.style.width = Math.max(0, Math.min(100, (d.remainingMs / (d.holdMs || 1)) * 100)) + '%';
  } else if (d.state === 'OPENING') {
    $('door-sub').textContent = d.lastOpenedBy ? `Apertura: ${d.lastOpenedBy}` : 'Liberando cerradura';
    bar.style.width = '100%';
  } else if (d.state === 'CLOSING') {
    $('door-sub').textContent = 'Re-bloqueando (fail-secure)';
    bar.style.width = '0%';
  } else {
    $('door-sub').textContent = d.lastOpenedBy ? `Última apertura: ${d.lastOpenedBy}` : 'En espera';
    bar.style.width = '0%';
  }
}

async function tick() {
  if (!state.polling) return;
  if (state.busy) return scheduleTick(state.pollMs);
  state.busy = true;
  let delay = state.pollMs;
  try {
    let r;
    if (WEBCAM) {
      const frame = grabWebcamFrame();
      if (!frame) { state.busy = false; return scheduleTick(state.pollMs); }
      r = await api.post(`/access/points/${state.pointId}/recognize-image`, { imageB64: frame }, state.token);
    } else {
      r = await api.post(`/access/points/${state.pointId}/recognize`, {}, state.token);
    }
    if (state.failCount > 0) setConn('live', WEBCAM ? 'Webcam en línea' : 'En línea');
    state.failCount = 0;
    render(r);
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) { state.busy = false; return logout(); }
    state.failCount += 1;
    // Avisa una sola vez y reduce la frecuencia: 3s, 6s, 12s… hasta 15s.
    if (state.failCount === 1) setConn('down', 'Cámara no responde');
    delay = Math.min(state.pollMs * 2 ** state.failCount, MAX_BACKOFF_MS);
  } finally {
    state.busy = false;
  }
  scheduleTick(delay);
}

/* ── Render del veredicto ───────────────────────────────────────────────── */
function render(r) {
  setConn('live', 'En línea');
  $('captured-at').textContent = r.capturedAt ? new Date(r.capturedAt).toLocaleTimeString() : '';
  drawBox(r);
  updateMeters(r);
  updateSpoof(r);

  if (!r.face) {
    // Mantén un veredicto reciente unos segundos antes de volver a "idle".
    if (Date.now() > state.idleResetAt) setIdle();
    return;
  }

  setScanning(false);
  const granted = r.decision === 'GRANTED';
  state.idleResetAt = Date.now() + 4000;

  if (r.subjectName || granted) showIdentity(r);
  else hideIdentity();

  if (granted) {
    setVerdict('granted', '✔', 'ACCESO CONCEDIDO', r.subjectName ? `Bienvenido, ${r.subjectName}` : 'Identidad verificada');
    $('btn-manual').classList.add('hidden');
    announce('granted', r.subjectName);
  } else {
    setVerdict('denied', '✕', 'ACCESO DENEGADO', REASON_TEXT[r.reason] || 'No autorizado');
    state.lastEventId = r.accessEventId;
    $('btn-manual').classList.toggle('hidden', !r.accessEventId);
    announce('denied', null, r.reason);
  }
  $('reason-pill').textContent = r.reason ? (REASON_TEXT[r.reason] || r.reason) : '';
}

function updateMeters(r) {
  const pct = (v) => `${Math.round((v || 0) * 100)}%`;
  $('match-val').textContent = pct(r.matchScore);
  $('live-val').textContent = pct(r.livenessScore);
  $('match-th').textContent = `umbral ${pct(r.matchThreshold)}`;
  $('live-th').textContent = `umbral ${pct(r.livenessThreshold)}`;
  const m = $('match-meter'); const l = $('live-meter');
  m.querySelector('i').style.width = pct(r.matchScore);
  l.querySelector('i').style.width = pct(r.livenessScore);
  m.className = 'meter ' + (r.matchScore >= r.matchThreshold ? 'ok' : 'bad');
  l.className = 'meter ' + (r.livenessScore >= r.livenessThreshold ? 'ok' : 'bad');
}

function updateSpoof(r) {
  const el = $('live-spoof');
  if (r.spoofVerdict === 'REAL') { el.textContent = '🟢 Persona real'; el.className = 'pill ok'; }
  else if (r.spoofVerdict === 'SPOOF') { el.textContent = '🔴 Posible suplantación'; el.className = 'pill danger'; }
  else { el.textContent = 'Liveness —'; el.className = 'pill'; }
}

function showIdentity(r) {
  $('identity').classList.remove('hidden');
  const name = r.subjectName || 'Empleado';
  $('subject-name').textContent = name;
  $('avatar').textContent = name.split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase() || '·';
  $('subject-role').textContent = r.profile?.role || '—';
  $('subject-code').textContent = r.profile?.employeeCode ? `#${r.profile.employeeCode}` : '';
}
function hideIdentity() { $('identity').classList.add('hidden'); }

function setIdle() {
  setScanning(true);
  setVerdict('idle', '⌖', 'Acérquese a la cámara', 'El sistema reconocerá su rostro automáticamente');
  hideIdentity();
  $('btn-manual').classList.add('hidden');
  $('reason-pill').textContent = '';
  state.spokenKey = null; // permite volver a anunciar el próximo veredicto
}

function setVerdict(stateName, icon, title, sub) {
  const v = $('verdict');
  v.className = `verdict-card card state-${stateName}`;
  $('verdict-icon').textContent = icon;
  $('verdict-title').textContent = title;
  $('verdict-sub').textContent = sub;
}

function setScanning(on) {
  $('verdict').classList.toggle('state-scanning', on && $('verdict').classList.contains('state-idle'));
  document.querySelector('.video-wrap').classList.toggle('scanning', on);
}

/* ── Overlay del bounding box ───────────────────────────────────────────── */
function drawBox(r) {
  const canvas = $('overlay');
  const wrap = canvas.parentElement;
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!r.face || !r.bbox || !r.frameWidth || !r.frameHeight) return;

  // Mapear coords del frame analizado al área visible (object-fit: cover).
  const scale = Math.max(canvas.width / r.frameWidth, canvas.height / r.frameHeight);
  const offX = (canvas.width - r.frameWidth * scale) / 2;
  const offY = (canvas.height - r.frameHeight * scale) / 2;
  const [x, y, w, h] = r.bbox;
  const rx = x * scale + offX, ry = y * scale + offY, rw = w * scale, rh = h * scale;

  const color = r.decision === 'GRANTED' ? '#28e0a0' : r.decision === 'DENIED' ? '#ff5470' : '#22d3ee';
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.shadowColor = color;
  ctx.shadowBlur = 14;
  roundRect(ctx, rx, ry, rw, rh, 12);
  ctx.stroke();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ── Apertura manual ────────────────────────────────────────────────────── */
async function manualOpen() {
  if (!state.lastEventId) return;
  $('btn-manual').disabled = true;
  try {
    await api.post(`/access/events/${state.lastEventId}/manual-open`, {}, state.token);
    toast('Apertura manual registrada', 'ok');
    setVerdict('granted', '✔', 'APERTURA MANUAL', 'Autorizada por el operador');
    $('btn-manual').classList.add('hidden');
  } catch (e) {
    toast(e instanceof ApiError ? e.message : 'No se pudo abrir', 'err');
  } finally {
    $('btn-manual').disabled = false;
  }
}

/* ── Ajustes ────────────────────────────────────────────────────────────── */
function openSettings() {
  const sel = $('sel-point');
  sel.innerHTML = '';
  if (!state.points.length) {
    const o = document.createElement('option');
    o.textContent = 'No hay puntos — créelos en la consola de administración';
    o.disabled = true; o.selected = true;
    sel.appendChild(o);
  } else {
    for (const p of state.points) {
      const o = document.createElement('option');
      o.value = p.id; o.textContent = `${p.name} (${p.kind})`;
      if (p.id === state.pointId) o.selected = true;
      sel.appendChild(o);
    }
  }
  $('poll-ms').value = state.pollMs;
  show('modal-settings');
}

function saveSettings() {
  const sel = $('sel-point');
  if (sel.value) {
    state.pointId = sel.value;
    localStorage.setItem(POINT_KEY, state.pointId);
  }
  state.pollMs = Math.max(600, Number($('poll-ms').value) || 1500);
  localStorage.setItem(POLL_KEY, String(state.pollMs));
  hide('modal-settings');
  startPoint();
}

/* ── Helpers UI ─────────────────────────────────────────────────────────── */
function setConn(kind, label) {
  const el = $('conn');
  el.className = 'pill ' + kind;
  el.innerHTML = `<span class="dot"></span> ${label}`;
}
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

/* ── Audio (chime) y voz (anuncios) ─────────────────────────────────────── */
let audioCtx = null;
let _voicePrimed = false;
function primeAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sin audio */ }
  // Desbloqueo de la SÍNTESIS DE VOZ: hay que "calentarla" DENTRO de un gesto
  // del usuario (clic/toque), o el navegador la silencia. Una locución a
  // volumen 0 dentro del gesto la habilita para los anuncios posteriores.
  try {
    if ('speechSynthesis' in window && !_voicePrimed) {
      window.speechSynthesis.resume();
      const warm = new SpeechSynthesisUtterance(' ');
      warm.volume = 0; warm.lang = 'es-ES';
      window.speechSynthesis.speak(warm);
      pickVoice();
      _voicePrimed = true;
    }
  } catch { /* sin voz */ }
}
function tone(freq, durMs, vol, delayMs) {
  if (!audioCtx) return;
  const t0 = audioCtx.currentTime + (delayMs || 0) / 1000;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, t0);
  gain.gain.setValueAtTime(vol, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start(t0); osc.stop(t0 + durMs / 1000);
}
function grantChime() { tone(659, 130, 0.22, 0); tone(880, 130, 0.22, 130); tone(1175, 240, 0.22, 260); }
function denyBuzz() { tone(196, 280, 0.22, 0); }

/* Frases habladas para los motivos de denegación (más naturales que el rótulo). */
const REASON_SPEAK = {
  UNKNOWN_SUBJECT: 'Rostro no reconocido.',
  LIVENESS_FAILED: 'Prueba de vida fallida.',
  CHALLENGE_REQUIRED: 'Se requiere prueba de vida.',
  NOT_AUTHORIZED: 'No tiene autorización en este punto.',
  OUT_OF_SCHEDULE: 'Fuera del horario permitido.',
  NO_CONSENT: 'Sin consentimiento biométrico.',
};

/* Anuncia el veredicto SOLO cuando cambia (no en cada tick del polling). */
function announce(kind, name, reason) {
  const key = kind === 'granted' ? `granted:${name || ''}` : `denied:${reason || ''}`;
  if (state.spokenKey === key) return;
  state.spokenKey = key;
  if (kind === 'granted') {
    grantChime();
    speak(name ? `Acceso concedido. Bienvenido, ${name}.` : 'Acceso concedido. Bienvenido.');
  } else {
    denyBuzz();
    speak('Acceso denegado. ' + (REASON_SPEAK[reason] || ''));
  }
}

let _lastUtter = null;
function speak(text) {
  try {
    if (!('speechSynthesis' in window) || !text) return;
    if (!_voice) pickVoice();
    const synth = window.speechSynthesis;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    if (_voice) u.voice = _voice;
    u.rate = 1.0; u.pitch = 1; u.volume = 1;
    _lastUtter = u; // mantener referencia: evita que el GC corte la locución
    synth.resume();
    // Cortar lo que esté sonando y dar un respiro: evita la carrera
    // cancel()->speak() de Chrome que descarta la nueva locución.
    if (synth.speaking || synth.pending) synth.cancel();
    setTimeout(() => { try { synth.resume(); synth.speak(u); } catch { /* noop */ } }, 60);
  } catch { /* sin voz */ }
}

/* Selección de voz en español (iOS/Android cargan las voces async). */
let _voice = null;
function pickVoice() {
  try {
    const vs = window.speechSynthesis.getVoices() || [];
    _voice = vs.find((v) => /^es(-|_)/i.test(v.lang)) || vs.find((v) => (v.lang || '').toLowerCase().startsWith('es')) || null;
  } catch { /* noop */ }
}
if ('speechSynthesis' in window) {
  pickVoice();
  window.speechSynthesis.onvoiceschanged = pickVoice;
}
