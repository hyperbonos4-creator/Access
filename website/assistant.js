/* ─────────────────────────────────────────────────────────────────────────
   Vix — Asistente de pre-venta de VisionYX (GLM vía Cloudflare Workers AI).
   Widget autocontenido: inyecta sus estilos y su DOM, y conversa con el
   endpoint público del backend. Marca VisionYX (cyan→violeta, Orbitron/Exo2).
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  var API = 'https://demo.visionyx.lat/api/v1/assistant/chat';
  var WA = 'https://wa.me/573042148205';
  var GREETING =
    '¡Hola! 👋 Soy Vix, el asistente de VisionYX. Convertimos operaciones físicas ' +
    'en software que trabaja solo. ¿Qué te gustaría resolver hoy?';
  // Preguntas de arranque para guiar (solo aparecen al abrir; el "asesor" vive
  // de forma fija y discreta en la cabecera, no como chip que estorba).
  var STARTERS = [
    '¿Qué es VisionYX?',
    'Probar el demo de Access',
    '¿Sirve para mi negocio?',
  ];

  var history = []; // [{role, content}]
  var busy = false;
  var opened = false;
  var startersShown = false;

  /* ── Estilos ──────────────────────────────────────────────────────── */
  var css =
    '#vix-root{--vx-cy:#22d3ee;--vx-bl:#3b82f6;--vx-vi:#a855f7;--vx-bg:#0b1326;--vx-pan:#0f1a30;--vx-txt:#eaf1fb;--vx-mut:#a6b6d4;--vx-bd:rgba(120,160,220,.16);font-family:"Exo 2",-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}' +
    '#vix-launch{position:fixed;right:22px;bottom:92px;z-index:70;display:flex;align-items:center;gap:9px;padding:12px 18px 12px 14px;border:0;border-radius:999px;cursor:pointer;color:#04121a;font-weight:700;font-size:.92rem;font-family:inherit;background:linear-gradient(120deg,var(--vx-cy),var(--vx-bl) 55%,var(--vx-vi));box-shadow:0 10px 30px rgba(99,102,241,.45);transition:transform .15s,box-shadow .2s}' +
    '#vix-launch:hover{transform:translateY(-2px);box-shadow:0 14px 36px rgba(99,102,241,.6)}' +
    '#vix-launch .vix-dot{width:8px;height:8px;border-radius:50%;background:#04121a;opacity:.5;animation:vixpulse 1.6s ease-in-out infinite}' +
    '@keyframes vixpulse{50%{opacity:1}}' +
    '#vix-panel{position:fixed;right:22px;bottom:22px;z-index:71;width:374px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 40px);display:none;flex-direction:column;overflow:hidden;border-radius:20px;border:1px solid var(--vx-bd);background:var(--vx-bg);box-shadow:0 24px 70px rgba(0,0,0,.6);opacity:0;transform:translateY(14px) scale(.98);transition:opacity .22s,transform .22s}' +
    '#vix-panel.open{display:flex;opacity:1;transform:none}' +
    '#vix-head{display:flex;align-items:center;gap:12px;padding:15px 16px;background:linear-gradient(120deg,rgba(34,211,238,.16),rgba(168,85,247,.18));border-bottom:1px solid var(--vx-bd)}' +
    '#vix-head .vix-av{width:40px;height:40px;border-radius:12px;flex:none;display:grid;place-items:center;background:linear-gradient(135deg,var(--vx-cy),var(--vx-vi));color:#04121a;font-family:"Orbitron",sans-serif;font-weight:800;font-size:1.1rem}' +
    '#vix-head h4{margin:0;font-family:"Orbitron",sans-serif;font-size:.98rem;color:var(--vx-txt);letter-spacing:.5px}' +
    '#vix-head p{margin:2px 0 0;font-size:.74rem;color:var(--vx-mut)}' +
    '#vix-head .vix-on{color:#28e0a0}' +
    '#vix-wa{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:.78rem;font-weight:700;color:#04121a;background:#28e0a0;border-radius:999px;padding:6px 12px;transition:transform .12s,filter .2s}' +
    '#vix-wa:hover{transform:translateY(-1px);filter:brightness(1.05)}' +
    '#vix-x{margin-left:10px;background:none;border:0;color:var(--vx-mut);font-size:1.4rem;cursor:pointer;line-height:1;padding:4px}' +
    '#vix-x:hover{color:var(--vx-txt)}' +
    '#vix-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;scrollbar-width:thin}' +
    '.vix-msg{max-width:84%;padding:11px 14px;border-radius:14px;font-size:.92rem;line-height:1.5;white-space:pre-wrap;word-wrap:break-word}' +
    '.vix-bot{align-self:flex-start;background:var(--vx-pan);border:1px solid var(--vx-bd);color:var(--vx-txt);border-bottom-left-radius:4px}' +
    '.vix-user{align-self:flex-end;background:linear-gradient(120deg,var(--vx-cy),var(--vx-bl));color:#04121a;font-weight:600;border-bottom-right-radius:4px}' +
    '.vix-msg a{color:var(--vx-cy);font-weight:700}' +
    '.vix-typing{align-self:flex-start;display:flex;gap:5px;padding:14px}' +
    '.vix-typing i{width:7px;height:7px;border-radius:50%;background:var(--vx-mut);animation:vixbounce 1.2s infinite}' +
    '.vix-typing i:nth-child(2){animation-delay:.15s}.vix-typing i:nth-child(3){animation-delay:.3s}' +
    '@keyframes vixbounce{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-5px);opacity:1}}' +
    '#vix-chips{display:flex;flex-wrap:wrap;gap:7px;padding:0 16px 10px}' +
    '.vix-chip{font-family:inherit;font-size:.8rem;color:var(--vx-cy);background:rgba(34,211,238,.08);border:1px solid var(--vx-bd);border-radius:999px;padding:7px 13px;cursor:pointer;transition:border-color .2s,background .2s}' +
    '.vix-chip:hover{border-color:var(--vx-cy);background:rgba(34,211,238,.16)}' +
    '#vix-foot{display:flex;gap:8px;padding:12px;border-top:1px solid var(--vx-bd);background:var(--vx-pan)}' +
    '#vix-in{flex:1;background:var(--vx-bg);border:1px solid var(--vx-bd);border-radius:12px;padding:11px 13px;color:var(--vx-txt);font-family:inherit;font-size:.92rem;resize:none;max-height:90px;outline:none}' +
    '#vix-in:focus{border-color:var(--vx-cy)}' +
    '#vix-send{flex:none;width:44px;border:0;border-radius:12px;cursor:pointer;color:#04121a;font-size:1.1rem;background:linear-gradient(120deg,var(--vx-cy),var(--vx-bl));transition:transform .12s,opacity .2s}' +
    '#vix-send:hover{transform:translateY(-1px)}#vix-send:disabled{opacity:.5;cursor:default}' +
    '#vix-foot .vix-wa{display:block;text-align:center}' +
    '@media (max-width:480px){#vix-panel{right:8px;bottom:8px;height:calc(100vh - 16px)}#vix-launch{right:14px;bottom:80px}}';

  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  /* ── DOM ──────────────────────────────────────────────────────────── */
  var root = document.createElement('div');
  root.id = 'vix-root';
  root.innerHTML =
    '<button id="vix-launch" aria-label="Abrir asistente"><span class="vix-dot"></span> Asistente VisionYX</button>' +
    '<section id="vix-panel" role="dialog" aria-label="Asistente VisionYX">' +
    '  <header id="vix-head">' +
    '    <div class="vix-av">V</div>' +
    '    <div><h4>Vix · VisionYX</h4><p><span class="vix-on">●</span> Asistente en línea</p></div>' +
    '    <a id="vix-wa" href="' + WA + '" target="_blank" rel="noopener" title="Hablar con un asesor por WhatsApp">✆ Asesor</a>' +
    '    <button id="vix-x" aria-label="Cerrar">×</button>' +
    '  </header>' +
    '  <div id="vix-body"></div>' +
    '  <div id="vix-chips"></div>' +
    '  <footer id="vix-foot">' +
    '    <textarea id="vix-in" rows="1" placeholder="Escribe tu mensaje…" maxlength="2000"></textarea>' +
    '    <button id="vix-send" aria-label="Enviar">➤</button>' +
    '  </footer>' +
    '</section>';
  document.body.appendChild(root);

  var $ = function (id) { return document.getElementById(id); };
  var body = $('vix-body'), chips = $('vix-chips'), input = $('vix-in'), sendBtn = $('vix-send');

  /* ── Render ───────────────────────────────────────────────────────── */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function linkify(s) {
    return esc(s)
      .replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>')
      .replace(/(\+?57\s?3\d{2}\s?\d{3}\s?\d{4})/g, '<a href="' + WA + '" target="_blank" rel="noopener">$1</a>');
  }
  function addMsg(text, who) {
    var d = document.createElement('div');
    d.className = 'vix-msg ' + (who === 'user' ? 'vix-user' : 'vix-bot');
    d.innerHTML = who === 'user' ? esc(text) : linkify(text);
    body.appendChild(d);
    body.scrollTop = body.scrollHeight;
    return d;
  }
  function showTyping() {
    var d = document.createElement('div');
    d.className = 'vix-typing'; d.id = 'vix-typing';
    d.innerHTML = '<i></i><i></i><i></i>';
    body.appendChild(d); body.scrollTop = body.scrollHeight;
  }
  function hideTyping() { var t = $('vix-typing'); if (t) t.remove(); }
  function renderChips(list) {
    chips.innerHTML = '';
    if (!list || !list.length) { chips.style.padding = '0'; return; }
    chips.style.padding = '0 16px 12px';
    list.slice(0, 4).forEach(function (c) {
      var b = document.createElement('button');
      b.className = 'vix-chip'; b.textContent = c;
      b.addEventListener('click', function () { if (!busy) send(c); });
      chips.appendChild(b);
    });
  }

  /* ── Enviar ───────────────────────────────────────────────────────── */
  function send(text) {
    text = (text || input.value).trim();
    if (!text || busy) return;
    busy = true; sendBtn.disabled = true;
    input.value = ''; input.style.height = 'auto';
    addMsg(text, 'user');
    history.push({ role: 'user', content: text });
    renderChips(null); // las sugerencias de arranque desaparecen al chatear
    showTyping();

    fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history.slice(-12) }),
    })
      .then(function (r) { return r.ok ? r.json() : r.json().then(function (b) { throw new Error(b.message || 'err'); }); })
      .then(function (data) {
        hideTyping();
        var reply = (data && data.reply) || 'Disculpa, no pude responder. Escríbenos por WhatsApp y te ayudamos.';
        addMsg(reply, 'bot');
        history.push({ role: 'assistant', content: reply });
      })
      .catch(function () {
        hideTyping();
        addMsg('Tuve un problema para responder. Puedes escribirnos por WhatsApp con el botón "Asesor" de arriba y te atendemos enseguida.', 'bot');
      })
      .finally(function () { busy = false; sendBtn.disabled = false; input.focus(); });
  }

  /* ── Apertura ─────────────────────────────────────────────────────── */
  function open() {
    if (opened) return;
    opened = true;
    $('vix-panel').classList.add('open');
    $('vix-launch').style.display = 'none';
    if (!history.length) {
      addMsg(GREETING, 'bot');
      if (!startersShown) { renderChips(STARTERS); startersShown = true; }
    }
    setTimeout(function () { input.focus(); }, 250);
  }
  function close() {
    opened = false;
    $('vix-panel').classList.remove('open');
    $('vix-launch').style.display = 'flex';
  }

  $('vix-launch').addEventListener('click', open);
  $('vix-x').addEventListener('click', close);
  sendBtn.addEventListener('click', function () { send(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(90, input.scrollHeight) + 'px';
  });
})();
