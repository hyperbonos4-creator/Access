/* ─────────────────────────────────────────────────────────────────────────
   Banner de sesión de demo efímera. Si el token actual pertenece a una sesión
   de demo (claim `ds`), muestra una franja con el tiempo restante y avisa que
   al expirar TODO se elimina del servidor. Inerte fuera del demo.
   ───────────────────────────────────────────────────────────────────────── */
(function () {
  var TOKENS = ['admin_token', 'kiosk_device_token'];
  var token = null;
  for (var i = 0; i < TOKENS.length; i++) {
    var v = localStorage.getItem(TOKENS[i]);
    if (v) { token = v; break; }
  }
  if (!token) return;

  var ds = null;
  try {
    var p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    ds = p && p.ds;
  } catch (e) { return; }
  if (!ds) return; // no es una sesión de demo

  var bar = document.createElement('div');
  bar.id = 'demo-banner';
  bar.style.cssText =
    'position:fixed;top:0;left:0;right:0;z-index:9999;display:flex;align-items:center;' +
    'justify-content:center;gap:10px;padding:7px 14px;font-family:inherit;font-size:13px;' +
    'font-weight:600;color:#04121a;background:linear-gradient(90deg,#22d3ee,#2f6bff);' +
    'box-shadow:0 2px 14px rgba(0,0,0,.3)';
  bar.innerHTML =
    '<span>🛡️ Sesión de demo privada</span>' +
    '<span style="font-family:monospace;background:rgba(4,18,26,.18);padding:2px 8px;border-radius:999px" id="demo-banner-clock">--:--</span>' +
    '<span style="opacity:.85;font-weight:500" id="demo-banner-msg">se autodestruye al expirar</span>';
  document.body.appendChild(bar);
  document.body.style.paddingTop = '34px';

  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000)), m = Math.floor(s / 60);
    s = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
  }

  var expiresAt = 0, timer = null;
  function tick() {
    var left = expiresAt - Date.now();
    var clock = document.getElementById('demo-banner-clock');
    if (clock) clock.textContent = fmt(left);
    if (left < 5 * 60000) bar.style.background = 'linear-gradient(90deg,#ff8a5b,#ff5470)';
    if (left <= 0) {
      clearInterval(timer);
      var msg = document.getElementById('demo-banner-msg');
      if (msg) msg.textContent = 'sesión expirada · datos eliminados del servidor';
    }
  }

  fetch('/api/v1/access/demo/session/' + encodeURIComponent(ds))
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (s) {
      if (!s || !s.expiresAt) return;
      expiresAt = new Date(s.expiresAt).getTime();
      tick();
      timer = setInterval(tick, 1000);
    })
    .catch(function () {});
})();
