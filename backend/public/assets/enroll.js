/* ─────────────────────────────────────────────────────────────────────────
   Registro facial guiado por LIVENESS ACTIVO (reto-respuesta en vivo).

   Validación rigurosa por pose (no captura instantánea):
   - Cada acción exige PREPARACIÓN → (para giros) pasar por el CENTRO para
     "armar" → mantener la pose objetivo un TIEMPO MÍNIMO continuo (dwell) →
     captura del fotograma sostenido.
   - Parpadeo genuino: ojos confirmados ABIERTOS → CERRADOS (mínimo de tiempo)
     → ABIERTOS de nuevo. No se da por válido un frame estático.
   - Control de calidad biométrica: rostro único, encuadre suficiente, cabeza
     sin inclinación lateral excesiva (roll).
   - Pose (yaw): misma convención que el servidor (headpose.py): nariz vs.
     centro de ojos / distancia interocular. Umbrales del cliente MÁS estrictos
     que los del servidor para garantizar que el frame capturado revalida.
   - El frame se captura SIN espejar (orientación cruda de cámara); el espejo
     del preview es solo cosmético.

   El servidor REVALIDA todo (pose + anti-spoofing pasivo). El cliente no es la
   autoridad: es la guía precisa que produce frames válidos.
   ───────────────────────────────────────────────────────────────────────── */

import { api, ApiError, getToken, toast } from './api.js';

const TOKEN_KEY = 'admin_token';
const $ = (id) => document.getElementById(id);

/* ── Umbrales de pose (cliente ESTRICTO; servidor: center 0.12 / turn 0.18) ── */
const CENTER_ENTER = 0.08; // |yaw| <= → frontal
const CENTER_EXIT = 0.14; // histéresis de salida del frontal
const TURN_ENTER = 0.42; // |yaw| >= → giro claro (con signo correcto)
const TURN_EXIT = 0.30; // histéresis: por debajo el giro se considera roto
const NEUTRAL_MAX = 0.12; // para "armar" un giro hay que volver a ~neutro
const ROLL_MAX_DEG = 16; // inclinación lateral (roll) máxima admitida
const MIN_FACE_WIDTH = 0.16; // ancho de rostro / ancho de frame (encuadre)

/* ── Tiempos (independientes del frame-rate) ────────────────────────────── */
const PREP_MS = 800; // estabilización al cambiar de acción
const DWELL_TURN_MS = 1300; // mantener el giro
const DWELL_CENTER_MS = 1100; // mantener el frente
const ACTION_TIMEOUT_MS = 28_000; // por acción

/* ── Parpadeo ───────────────────────────────────────────────────────────── */
const BLINK_CLOSE = 0.55; // blendshape ojo cerrado
const BLINK_OPEN = 0.20; // blendshape ojo abierto
const BLINK_MIN_CLOSED_MS = 70; // el ojo debe permanecer cerrado un mínimo real

const RING_CIRC = 2 * Math.PI * 38;

// Índices de landmarks (MediaPipe FaceLandmarker, 478 pts con iris).
const LM_IRIS_L = 468;
const LM_IRIS_R = 473;
const LM_EYE_L = 33;
const LM_EYE_R = 263;
const LM_NOSE = 1;

const ACTION_UI = {
  LOOK_LEFT: { icon: '⬅️', title: 'Gira a la izquierda', hint: 'Lleva el mentón hacia tu hombro izquierdo' },
  LOOK_RIGHT: { icon: '➡️', title: 'Gira a la derecha', hint: 'Lleva el mentón hacia tu hombro derecho' },
  LOOK_CENTER: { icon: '⌖', title: 'Mira al frente', hint: 'Rostro recto, ojos a la cámara' },
  BLINK: { icon: '😉', title: 'Parpadea', hint: 'Cierra y abre los ojos con naturalidad' },
};

/* Frases de voz (más naturales que el rótulo en pantalla). */
const ACTION_SPEAK = {
  LOOK_LEFT: 'Gira lentamente la cabeza hacia la izquierda',
  LOOK_RIGHT: 'Gira lentamente la cabeza hacia la derecha',
  LOOK_CENTER: 'Mira de frente a la cámara',
  BLINK: 'Parpadea una vez, con naturalidad',
};
/* Confirmaciones sobrias al capturar (se alternan para no sonar robótico). */
const CAPTURE_SPEAK = ['Perfecto', 'Muy bien', 'Excelente', 'Listo'];

const REASONS = {
  challenge_invalid_or_expired: 'El reto expiró. Reintenta el registro.',
  sequence_mismatch: 'La secuencia no coincidió con el reto. Reintenta.',
  action_failed: 'El servidor no pudo revalidar una de las poses. Reintenta con mejor luz, de frente y sin gorra/gafas oscuras.',
  challenge_expired: 'El reto expiró. Reintenta el registro.',
  liveness_unavailable: 'El detector anti-suplantación no está disponible en el servidor.',
  spoof_suspected: 'Posible suplantación (foto/pantalla). Debe ser una persona real frente a la cámara.',
  missing_center_frame: 'No se capturó un frame frontal válido.',
  no_active_consent: 'Falta el consentimiento ACTIVE del empleado (regístralo en administración).',
  face_already_enrolled: 'Este rostro ya está registrado en otra identidad. Una persona solo puede tener una identidad.',
  NO_FACE: 'No se detectó un rostro nítido en el frame frontal.',
  MULTIPLE_FACES: 'Se detectó más de un rostro; debe haber solo uno.',
  LOW_QUALITY: 'Calidad/iluminación insuficiente; acércate y mejora la luz.',
  SPOOF_SUSPECTED: 'Posible suplantación detectada.',
  vision_service_unavailable: 'El servicio de visión no responde.',
};

const params = new URLSearchParams(location.search);
const state = {
  token: getToken(TOKEN_KEY),
  subjectId: params.get('subjectId') || '',
  name: params.get('name') || 'Empleado',
  source: null,
  ipPointId: '',
  stream: null,
  landmarker: null,
  running: false,
  raf: 0,
  challenge: null,
  stepIndex: 0,
  captured: [],
  actionDeadline: 0,
  lastTs: -1,
  // estado por acción
  phase: 'prep', // prep | arming | holding (poses) · prep | need_open | ready | closing (blink)
  phaseStart: 0,
  holdStart: 0,
  armed: false,
  blinkClosedStart: 0,
};

boot();

function boot() {
  $('who-name').textContent = state.name;
  if (!state.token) return fail('Sesión no válida. Inicia sesión en administración y abre el registro desde ahí.');
  if (!state.subjectId) return fail('Falta el identificador del empleado (subjectId).');

  $('src-webcam').onclick = () => selectSource('webcam');
  $('src-ip').onclick = () => selectSource('ip');
  $('btn-start').onclick = start;
  $('btn-retry').onclick = retry;
  $('ip-point').onchange = (e) => (state.ipPointId = e.target.value);

  renderSteps(['LOOK_LEFT', 'BLINK', 'LOOK_RIGHT', 'LOOK_CENTER'], -1, true);
  loadIpPoints();
  // Webcam preseleccionada: en móvil/PC es lo normal. El usuario solo pulsa Iniciar.
  selectSource('webcam');
  setCue('📷', 'Listo para registrar', 'Pulsa “Iniciar registro guiado” y permite la cámara');
  setFaceFlag('Listo para iniciar', '');
}

/* ── Puntos de acceso con cámara IP ─────────────────────────────────────── */
async function loadIpPoints() {
  try {
    const points = await api.get('/access/points', state.token);
    const sel = $('ip-point');
    sel.innerHTML = points.length
      ? points.map((p) => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')
      : '<option value="" disabled selected>sin puntos con cámara</option>';
    state.ipPointId = points[0]?.id || '';
    $('src-ip').disabled = points.length === 0;
  } catch {
    $('src-ip').disabled = true;
  }
}

function selectSource(src) {
  state.source = src;
  $('src-webcam').className = `btn sm ${src === 'webcam' ? '' : 'ghost'}`;
  $('src-ip').className = `btn sm ${src === 'ip' ? '' : 'ghost'}`;
  $('ip-point-wrap').classList.toggle('hidden', src !== 'ip');
  $('btn-start').disabled = false;
}

/* ── Arranque del flujo ─────────────────────────────────────────────────── */
async function start() {
  $('btn-start').disabled = true;
  initAudio();
  speak('Vamos a registrar tu rostro. Sigue las indicaciones por voz.'); // dentro del gesto: desbloquea voz en iPhone
  $('result-card').classList.add('hidden');
  setFaceFlag('Encendiendo cámara…', '');

  // 1) Cámara primero: feedback visual inmediato (clave en móvil).
  try {
    if (state.source === 'webcam') await startWebcam();
    else await startIpStream();
  } catch (e) {
    $('btn-start').disabled = false;
    return fail(e.message);
  }
  // 2) Motor de visión (puede tardar en cargar el wasm en móvil).
  setCue('⏳', 'Preparando…', 'Cargando el detector facial (unos segundos)');
  setFaceFlag('Cargando motor de visión…', '');
  try {
    await ensureLandmarker();
  } catch (e) {
    stopSource();
    $('btn-start').disabled = false;
    return fail(`No se pudo cargar el motor de detección facial: ${e.message}`);
  }
  try {
    state.challenge = await api.post(`/access/subjects/${state.subjectId}/liveness/challenge`, {}, state.token);
  } catch (e) {
    stopSource();
    $('btn-start').disabled = false;
    return fail(e instanceof ApiError ? e.message : 'No se pudo obtener el reto de liveness.');
  }

  state.captured = [];
  state.stepIndex = 0;
  renderSteps(state.challenge.actions, 0, false);
  state.running = true;
  state.lastTs = -1;
  beginAction(0);
  loop();
}

/* ── MediaPipe Face Landmarker (self-hosted) ────────────────────────────── */
async function ensureLandmarker() {
  if (state.landmarker) return;
  const mp = await import('../vendor/mediapipe/vision_bundle.mjs');
  const { FaceLandmarker, FilesetResolver } = mp;
  const wasmBase = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
  const modelPath = new URL('../vendor/mediapipe/face_landmarker.task', import.meta.url).href;
  const fileset = await FilesetResolver.forVisionTasks(wasmBase);
  const opts = {
    baseOptions: { modelAssetPath: modelPath, delegate: 'GPU' },
    runningMode: 'VIDEO',
    numFaces: 2, // detecta multi-rostro para poder rechazarlo
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
  };
  try {
    state.landmarker = await FaceLandmarker.createFromOptions(fileset, opts);
  } catch {
    opts.baseOptions.delegate = 'CPU';
    state.landmarker = await FaceLandmarker.createFromOptions(fileset, opts);
  }
}

/* ── Fuentes de cámara ──────────────────────────────────────────────────── */
async function startWebcam() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara.');
  const v = $('video');
  v.setAttribute('playsinline', ''); v.setAttribute('autoplay', ''); v.muted = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
  } catch (e1) {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    } catch (e2) {
      throw new Error(`No se pudo abrir la cámara (${e2.name || e2.message}). Revisa el permiso de cámara del navegador y que ninguna otra app la esté usando.`);
    }
  }
  state.stream = stream;
  v.srcObject = stream;
  v.classList.remove('hidden');
  v.classList.add('mirror');
  $('ipview').classList.add('hidden');
  try { await v.play(); } catch { /* visible + muted suele bastar */ }
  await new Promise((res) => {
    if (v.readyState >= 2) return res();
    v.onloadeddata = () => res();
    setTimeout(res, 1500); // no colgar si loadeddata no dispara en algún móvil
  });
}

async function startIpStream() {
  if (!state.ipPointId) throw new Error('Selecciona un punto de acceso con cámara IP.');
  let token;
  try {
    ({ token } = await api.get(`/access/points/${state.ipPointId}/stream-token`, state.token));
  } catch (e) {
    throw new Error(e instanceof ApiError ? e.message : 'No se pudo abrir el stream de la cámara IP.');
  }
  const img = $('ipview');
  img.classList.remove('hidden', 'mirror');
  $('video').classList.add('hidden');
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error('La cámara IP no envió imagen (timeout).')), 8000);
    img.onload = () => { clearTimeout(to); res(); };
    img.onerror = () => { clearTimeout(to); rej(new Error('La cámara IP no respondió.')); };
    img.src = `/api/v1/access/points/${state.ipPointId}/stream.mjpeg?token=${encodeURIComponent(token)}`;
  });
}

function currentSourceEl() {
  return state.source === 'webcam' ? $('video') : $('ipview');
}
function sourceDims(el) {
  return state.source === 'webcam'
    ? { w: el.videoWidth, h: el.videoHeight }
    : { w: el.naturalWidth, h: el.naturalHeight };
}

/* ── Bucle de detección ─────────────────────────────────────────────────── */
function loop() {
  if (!state.running) return;
  state.raf = requestAnimationFrame(loop);

  const el = currentSourceEl();
  const { w, h } = sourceDims(el);
  if (!w || !h) return;

  const work = $('work');
  if (work.width !== w) { work.width = w; work.height = h; }
  work.getContext('2d').drawImage(el, 0, 0, w, h);

  let ts = performance.now();
  if (ts <= state.lastTs) ts = state.lastTs + 1;
  state.lastTs = ts;

  let result;
  try {
    result = state.landmarker.detectForVideo(work, ts);
  } catch {
    return;
  }

  const now = performance.now();
  const faces = result.faceLandmarks || [];
  if (faces.length === 0) {
    setFaceFlag('Acerca tu rostro a la cámara', 'bad');
    breakHold();
    return checkTimeout(now);
  }
  if (faces.length > 1) {
    setFaceFlag('Solo una persona en cuadro', 'bad');
    breakHold();
    return checkTimeout(now);
  }

  const m = metrics(faces[0], result.faceBlendshapes?.[0]?.categories || [], w, h);
  const action = state.challenge.actions[state.stepIndex];
  if (action === 'BLINK') evaluateBlink(m, now);
  else evaluatePose(action, m, now);
  checkTimeout(now);
}

function checkTimeout(now) {
  const left = state.actionDeadline - Date.now();
  if (left <= 0) {
    $('timer').classList.add('hidden');
    return abortAttempt('Se agotó el tiempo para esta acción. Reintenta el registro.');
  }
  const t = $('timer');
  t.classList.remove('hidden');
  t.textContent = `${Math.ceil(left / 1000)}s`;
}

/* ── Métricas (convención del servidor + calidad) ───────────────────────── */
function metrics(lm, blend, w, h) {
  const eyeL = lm[LM_IRIS_L] || lm[LM_EYE_L];
  const eyeR = lm[LM_IRIS_R] || lm[LM_EYE_R];
  const nose = lm[LM_NOSE];
  let yaw = null, roll = 0;
  if (eyeL && eyeR && nose) {
    const elx = eyeL.x * w, ely = eyeL.y * h;
    const erx = eyeR.x * w, ery = eyeR.y * h;
    const interocular = Math.hypot(erx - elx, ery - ely);
    if (interocular > 1e-6) {
      yaw = (nose.x * w - (elx + erx) / 2) / interocular;
      roll = (Math.atan2(ery - ely, erx - elx) * 180) / Math.PI;
    }
  }
  // Encuadre: ancho del rostro respecto al frame.
  let minX = 1, maxX = 0;
  for (const p of lm) { if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x; }
  const faceWidth = maxX - minX;

  let bl = 0, br = 0;
  for (const c of blend) {
    if (c.categoryName === 'eyeBlinkLeft') bl = c.score;
    else if (c.categoryName === 'eyeBlinkRight') br = c.score;
  }
  return { yaw, roll: Math.abs(roll), faceWidth, blinkMax: Math.max(bl, br), blinkMin: Math.min(bl, br) };
}

function qualityOk(m) {
  return m.faceWidth >= MIN_FACE_WIDTH && m.roll <= ROLL_MAX_DEG;
}
function qualityHint(m) {
  if (m.faceWidth < MIN_FACE_WIDTH) return 'Acércate un poco a la cámara';
  if (m.roll > ROLL_MAX_DEG) return 'Endereza la cabeza (sin inclinar)';
  return null;
}

/* ── Evaluación de poses (LOOK_LEFT / LOOK_RIGHT / LOOK_CENTER) ──────────── */
function evaluatePose(action, m, now) {
  // PREP: estabilización antes de exigir la pose.
  if (state.phase === 'prep') {
    setRing(0, '');
    setFaceFlag('Prepárate…', '');
    if (now - state.phaseStart >= PREP_MS) { state.phase = 'arming'; state.holdStart = 0; }
    return;
  }
  if (m.yaw == null) { setFaceFlag('Mantén el rostro visible', 'bad'); breakHold(); return; }

  const q = qualityHint(m);
  // ARMADO: para giros, exigir pasar por el centro (transición real).
  if (action !== 'LOOK_CENTER' && !state.armed) {
    setRing(0, '');
    if (Math.abs(m.yaw) <= NEUTRAL_MAX) { state.armed = true; setFaceFlag('Ahora gira', 'ok'); }
    else setFaceFlag('Vuelve al frente para empezar', '');
    return;
  }

  const strict = inTargetStrict(action, m.yaw);
  const loose = inTargetLoose(action, m.yaw);

  if (state.holdStart === 0) {
    // aún no sostiene: requiere entrada ESTRICTA + calidad
    if (strict && qualityOk(m)) {
      state.holdStart = now;
    } else {
      setRing(0, q ? 'bad' : '');
      setFaceFlag(q || cuePrompt(action), q ? 'bad' : '');
    }
    return;
  }

  // sosteniendo: tolera dips (banda de salida), pero exige calidad
  if (!loose || !qualityOk(m)) {
    state.holdStart = 0;
    setRing(0, '');
    setFaceFlag(q || 'Mantén la posición', q ? 'bad' : '');
    return;
  }
  const need = action === 'LOOK_CENTER' ? DWELL_CENTER_MS : DWELL_TURN_MS;
  const held = now - state.holdStart;
  setRing(held / need, held >= need ? 'ok' : '');
  setFaceFlag(`Mantén la posición… ${Math.max(0, Math.ceil((need - held) / 1000))}s`, 'ok');
  if (held >= need) captureCurrentFrame(action);
}

function cuePrompt(action) {
  return action === 'LOOK_CENTER' ? 'Mira al frente' : action === 'LOOK_LEFT' ? 'Gira a la izquierda' : 'Gira a la derecha';
}
function inTargetStrict(action, yaw) {
  if (action === 'LOOK_CENTER') return Math.abs(yaw) <= CENTER_ENTER;
  if (action === 'LOOK_RIGHT') return yaw <= -TURN_ENTER; // mentón a la derecha del usuario
  if (action === 'LOOK_LEFT') return yaw >= TURN_ENTER; // mentón a la izquierda del usuario
  return false;
}
function inTargetLoose(action, yaw) {
  if (action === 'LOOK_CENTER') return Math.abs(yaw) <= CENTER_EXIT;
  if (action === 'LOOK_RIGHT') return yaw <= -TURN_EXIT;
  if (action === 'LOOK_LEFT') return yaw >= TURN_EXIT;
  return false;
}

/* ── Evaluación de parpadeo (abierto → cerrado → abierto) ────────────────── */
function evaluateBlink(m, now) {
  if (state.phase === 'prep') {
    setRing(0.1, '');
    setFaceFlag('Prepárate…', '');
    if (now - state.phaseStart >= PREP_MS) state.phase = 'need_open';
    return;
  }
  if (!qualityOk(m)) { setFaceFlag(qualityHint(m) || 'Acomódate frente a la cámara', 'bad'); return; }

  if (state.phase === 'need_open') {
    // confirma ojos abiertos como línea base
    setRing(0.15, '');
    setFaceFlag('Mírame con los ojos abiertos', '');
    if (m.blinkMax < BLINK_OPEN) state.phase = 'ready';
    return;
  }
  if (state.phase === 'ready') {
    setFaceFlag('Ahora parpadea', '');
    if (m.blinkMax >= BLINK_CLOSE) { state.phase = 'closing'; state.blinkClosedStart = now; setRing(0.55, ''); }
    else setRing(0.25, '');
    return;
  }
  if (state.phase === 'closing') {
    setRing(0.7, '');
    if (m.blinkMin <= BLINK_OPEN) {
      // ojos reabiertos: ¿el cierre duró lo suficiente?
      if (now - state.blinkClosedStart >= BLINK_MIN_CLOSED_MS) {
        setRing(1, 'ok');
        captureCurrentFrame('BLINK');
      } else {
        state.phase = 'ready'; // demasiado corto: pide de nuevo
      }
    }
  }
}

/* ── Captura y avance ───────────────────────────────────────────────────── */
const CAPTURE_MAX_SIDE = 720; // acota el frame enviado (acelera la visión en CPU)

function captureCurrentFrame(action) {
  const work = $('work');
  const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(work.width, work.height));
  let imageB64;
  if (scale < 1) {
    const out = document.createElement('canvas');
    out.width = Math.round(work.width * scale);
    out.height = Math.round(work.height * scale);
    out.getContext('2d').drawImage(work, 0, 0, out.width, out.height);
    imageB64 = out.toDataURL('image/jpeg', 0.92).split(',')[1];
  } else {
    imageB64 = work.toDataURL('image/jpeg', 0.92).split(',')[1];
  }
  state.captured.push({ action, imageB64 });
  captureBeep();
  speak(CAPTURE_SPEAK[(state.stepIndex) % CAPTURE_SPEAK.length]);

  const stage = $('stage');
  stage.classList.remove('flash');
  void stage.offsetWidth;
  stage.classList.add('flash');

  markStep(state.stepIndex, 'done');
  state.stepIndex += 1;
  if (state.stepIndex >= state.challenge.actions.length) finishAndSubmit();
  else beginAction(state.stepIndex);
}

function beginAction(i) {
  const action = state.challenge.actions[i];
  const ui = ACTION_UI[action];
  setCue(ui.icon, ui.title, ui.hint);
  speak(ACTION_SPEAK[action] || ui.title);
  setRing(0, '');
  state.phase = 'prep';
  state.phaseStart = performance.now();
  state.holdStart = 0;
  state.armed = false;
  state.blinkClosedStart = 0;
  state.actionDeadline = Date.now() + ACTION_TIMEOUT_MS;
  markStep(i, 'active');
}

function breakHold() {
  state.holdStart = 0;
  setRing(0, '');
}

/* ── Envío al backend ───────────────────────────────────────────────────── */
async function finishAndSubmit() {
  state.running = false;
  cancelAnimationFrame(state.raf);
  $('timer').classList.add('hidden');
  setCue('⏳', 'Verificando…', 'Revalidando prueba de vida y enrolando el rostro');
  setFaceFlag('Procesando', '');
  setRing(1, 'ok');
  try {
    const res = await api.post(
      `/access/subjects/${state.subjectId}/liveness/enroll`,
      { challengeId: state.challenge.challengeId, frames: state.captured },
      state.token,
    );
    stopSource();
    res.ok ? showSuccess(res) : showFailure(res);
  } catch (e) {
    stopSource();
    const msg = e instanceof ApiError ? (e.body?.message || e.message) : e.message;
    fail(msg || 'Error al enrolar.');
  }
}

function showSuccess(res) {
  successChime();
  speak('Registro exitoso. Ahora puedes probarlo en el kiosko.');
  setCue('✅', 'Registro completado', 'Rostro enrolado con prueba de vida verificada');
  $('result-card').classList.remove('hidden');
  $('result').className = 'result ok';
  $('result-title').textContent = '✔ Registro facial exitoso';
  $('result-detail').textContent = '¡Tu rostro quedó registrado! Ahora pruébalo en el kiosko de la puerta.';
  showScore(res.passiveScore);
  const acts = $('result-actions');
  if (acts) {
    acts.innerHTML =
      '<div class="next-steps"><b>Para probar el reconocimiento:</b>' +
      '<ol><li>Abre el <b>Kiosko de puerta</b> (botón de abajo).</li>' +
      '<li>Inicia sesión con las credenciales de demostración.</li>' +
      '<li>Acércate a la cámara: el sistema te reconocerá y abrirá la puerta.</li></ol>' +
      '<div class="creds-mini">Usuario: <code>demo@visionyx.lat</code><br>Clave: <code>VisionyxDemo2026!</code></div>' +
      '<a class="btn big-btn" href="/kiosk/" target="_blank" rel="noopener" style="margin-top:12px">🚪 Abrir kiosko para probar →</a></div>';
    acts.classList.remove('hidden');
  }
  $('btn-start').classList.add('hidden');
  $('btn-retry').classList.remove('hidden');
  $('btn-retry').textContent = 'Registrar otra captura';
  toast('Rostro enrolado correctamente', 'ok');
}

function showFailure(res) {
  errorBeep();
  const acts = $('result-actions');
  if (acts) { acts.innerHTML = ''; acts.classList.add('hidden'); }
  const reason = res.reason || (res.stage === 'sequence' ? 'action_failed' : 'liveness_unavailable');
  const text = REASONS[reason] || `No se pudo completar (${reason}).`;
  setCue('⚠️', 'No se pudo registrar', 'Revisa el detalle y reintenta');
  $('result-card').classList.remove('hidden');
  $('result').className = 'result err';
  $('result-title').textContent = '✕ Registro no completado';
  $('result-detail').textContent = text + (res.stage ? ` (etapa: ${res.stage})` : '');
  if (res.passiveScore != null) showScore(res.passiveScore);
  else $('result-scores').classList.add('hidden');
  $('btn-start').classList.add('hidden');
  $('btn-retry').classList.remove('hidden');
  $('btn-retry').textContent = 'Reintentar';
}

function showScore(passive) {
  if (passive == null) return $('result-scores').classList.add('hidden');
  $('result-scores').classList.remove('hidden');
  $('score-passive').textContent = `${Math.round(passive * 100)}%`;
}

/* ── Aborto / reintento / error ─────────────────────────────────────────── */
function abortAttempt(message) {
  if (!state.running) return;
  state.running = false;
  cancelAnimationFrame(state.raf);
  $('timer').classList.add('hidden');
  stopSource();
  fail(message);
}

function retry() {
  $('btn-retry').classList.add('hidden');
  $('result-card').classList.add('hidden');
  const acts = $('result-actions');
  if (acts) { acts.innerHTML = ''; acts.classList.add('hidden'); }
  $('btn-start').classList.remove('hidden');
  $('btn-start').disabled = false;
  setCue('⌖', 'Listo para reintentar', 'Pulsa “Iniciar registro guiado”');
  setFaceFlag('Listo para iniciar', '');
  setRing(0, '');
  renderSteps(state.challenge?.actions || ['LOOK_LEFT', 'BLINK', 'LOOK_RIGHT', 'LOOK_CENTER'], -1, false);
}

function fail(message) {
  $('result-card').classList.remove('hidden');
  $('result').className = 'result err';
  $('result-title').textContent = '✕ No se pudo iniciar';
  $('result-detail').textContent = message;
  $('result-scores').classList.add('hidden');
  setCue('⚠️', 'Atención', message);
  setFaceFlag('Detenido', 'bad');
  $('btn-retry').classList.remove('hidden');
  $('btn-start').classList.add('hidden');
}

function stopSource() {
  if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
  const img = $('ipview');
  if (img.src) img.removeAttribute('src');
}

/* ── UI helpers ─────────────────────────────────────────────────────────── */
function setCue(icon, title, hint) {
  $('cue-icon').textContent = icon;
  $('cue-title').textContent = title;
  $('cue-hint').textContent = hint;
}
function setFaceFlag(text, kind) {
  const el = $('face-flag');
  el.textContent = text;
  el.className = `face-flag ${kind || ''}`;
}
function setRing(progress, kind) {
  const p = Math.max(0, Math.min(1, progress));
  $('ring').style.strokeDashoffset = String(RING_CIRC * (1 - p));
  $('guide').className = `guide ${kind || ''}`;
}
function renderSteps(actions, activeIdx, placeholder) {
  $('steps').innerHTML = actions
    .map((a, i) => {
      const ui = ACTION_UI[a] || { icon: '•', title: a };
      const cls = placeholder ? '' : i < activeIdx ? 'done' : i === activeIdx ? 'active' : '';
      const stateIcon = placeholder ? '' : i < activeIdx ? '✓' : '';
      return `<div class="step ${cls}" data-step="${i}">
        <span class="badge">${ui.icon}</span>
        <span class="label">${escapeHtml(ui.title)}</span>
        <span class="state">${stateIcon}</span>
      </div>`;
    })
    .join('');
}
function markStep(i, kind) {
  const host = $('steps');
  const el = host.querySelector(`[data-step="${i}"]`);
  if (!el) return;
  if (kind === 'active') {
    host.querySelectorAll('.step').forEach((s) => s.classList.remove('active'));
    el.classList.add('active');
  } else if (kind === 'done') {
    el.classList.remove('active');
    el.classList.add('done');
    el.querySelector('.state').textContent = '✓';
  }
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// Libera la cámara/stream al cerrar o navegar fuera de la página.
window.addEventListener('beforeunload', () => {
  state.running = false;
  cancelAnimationFrame(state.raf);
  stopSource();
});
window.addEventListener('pagehide', stopSource);

/* ── Audio (pitidos) y voz (anuncios) ───────────────────────────────────── */
let audioCtx = null;
function initAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* sin audio */ }
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
function captureBeep() { tone(988, 120, 0.25, 0); tone(1319, 160, 0.25, 120); } // ding-ding (capturado)
function successChime() { tone(784, 130, 0.25, 0); tone(1047, 130, 0.25, 130); tone(1319, 220, 0.25, 260); }
function errorBeep() { tone(220, 240, 0.25, 0); }
function speak(text) {
  try {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.resume();
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    if (_voice) u.voice = _voice;
    u.rate = 1.0; u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch { /* sin voz */ }
}

/* Selección de voz en español (iOS/Android cargan las voces de forma asíncrona). */
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
