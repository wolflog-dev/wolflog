/* Wolflog : carte de chaleur affichée sur le site lui-même (« Ouvrir sur le site » dans Clics & défilement), pour les pages
   protégées par une connexion. Chargé par la page /_wolflog/heatmap du site : Wolflog.Client.Blazor la sert
   (app.UseWolflogHeatmapPreview()), ailleurs une page statique suffit :
   <!doctype html><meta charset="utf-8"><title>Carte de chaleur</title><script src="https://wolflog.exemple.fr/wolflog-heatmap.js" defer></script>
   Les pages s'affichent avec la session de la personne (même origine que le site) et en lecture seule : aucun clic ne les
   atteint. Les clics sont lus auprès de Wolflog avec le jeton du lien (quelques heures). Rien n'est mesuré pendant l'aperçu. */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__wolflogHeatmap) return;
  window.__wolflogHeatmap = true;

  var api = new URL('api/heatmap/', script.src).href;
  var RES = 0.5, RADIUS = 22;
  var DEVICES = [['desktop', 'Ordinateur'], ['tablet', 'Tablette'], ['mobile', 'Mobile'], ['', 'Tous']];
  // Rampe séquentielle chaude, comme dans Wolflog : jaune (peu) → orange → rouge → bordeaux (beaucoup).
  var STOPS = [[0, [250, 178, 25]], [0.35, [235, 104, 52]], [0.7, [208, 59, 59]], [1, [122, 29, 29]]];
  var PALETTE = new Uint8ClampedArray(256 * 3);
  for (var i = 0; i < 256; i++) {
    var t = i / 255, k = 0;
    while (k < STOPS.length - 2 && t > STOPS[k + 1][0]) k++;
    var f = (t - STOPS[k][0]) / (STOPS[k + 1][0] - STOPS[k][0]);
    for (var j = 0; j < 3; j++) PALETTE[i * 3 + j] = STOPS[k][1][j] + (STOPS[k + 1][1][j] - STOPS[k][1][j]) * f;
  }

  // Jeton : lu dans l'adresse puis retiré de la barre d'adresse (gardé pour un rechargement de l'onglet).
  var params = new URLSearchParams(location.search);
  var token = params.get('t');
  try {
    if (token) sessionStorage.setItem('wolflog.heatmap', token);
    else token = sessionStorage.getItem('wolflog.heatmap');
  } catch (e) { /* stockage indisponible : le jeton reste en mémoire */ }
  var state = {
    path: params.get('path') || '',
    device: DEVICES.some(function (d) { return d[0] === params.get('device'); }) ? params.get('device') : 'desktop',
    mode: params.get('mode') === 'scroll' ? 'scroll' : 'clicks',
    page: true,
  };
  var pages = [], report = null, docHeight = 0, scale = 1, loadedSrc = null, heightTimer = null;
  var MAX_HEIGHT = 20000;

  var CSS = [
    ':root{color-scheme:dark}',
    'html,body{margin:0;height:100%;background:#0b1120;color:#e5e9f2;font:13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.wlh{display:grid;grid-template-rows:auto minmax(0,1fr);height:100%}',
    '.wlh-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px 14px;padding:10px 16px;background:rgba(15,23,42,.94);',
    'border-bottom:1px solid rgba(255,255,255,.08);box-shadow:0 10px 30px -18px rgba(0,0,0,.8)}',
    '.wlh-brand{display:inline-flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.01em}',
    '.wlh-brand i{width:18px;height:18px;border-radius:6px;background:linear-gradient(135deg,#3b82f6,#06b6d4)}',
    '.wlh-seg{display:inline-flex;padding:2px;border-radius:9px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08)}',
    '.wlh-seg button{border:0;background:none;color:#a7b0c2;font:inherit;font-weight:550;padding:5px 11px;border-radius:7px;cursor:pointer;',
    'transition:background-color .2s,color .2s}',
    '.wlh-seg button:hover{color:#fff}',
    '.wlh-seg button.on{background:rgba(59,130,246,.24);color:#fff}',
    '.wlh-page{max-width:min(420px,100%);height:30px;padding:0 8px;border-radius:8px;border:1px solid rgba(255,255,255,.14);',
    'background:#111a2e;color:#e5e9f2;font:inherit}',
    '.wlh-muted{color:#a7b0c2}',
    '.wlh-stats{color:#a7b0c2;font-variant-numeric:tabular-nums}',
    '.wlh-stats b{color:#fff;font-weight:650}',
    '.wlh-spacer{flex:1}',
    '.wlh-check{display:inline-flex;align-items:center;gap:6px;color:#a7b0c2;cursor:pointer}',
    '.wlh-main{overflow:auto;padding:16px}',
    '.wlh-viewport{position:relative;margin:0 auto;overflow:hidden;border-radius:10px;background:#fff;',
    'box-shadow:0 24px 60px -24px rgba(0,0,0,.75),0 0 0 1px rgba(255,255,255,.06)}',
    '.wlh-stage{position:absolute;top:0;left:0;transform-origin:0 0;background:#fff}',
    '.wlh-stage iframe{position:absolute;inset:0;border:0;pointer-events:none;background:#fff;transition:opacity .3s}',
    '.wlh-stage canvas{position:absolute;inset:0;pointer-events:none}',
    '.wlh-labels{position:absolute;inset:0;pointer-events:none}',
    '.wlh-reach{position:absolute;left:10px;transform:translateY(-50%);padding:3px 10px;border-radius:999px;background:rgba(15,23,42,.92);',
    'color:#fff;font:600 11px system-ui,sans-serif;white-space:nowrap;border:1px solid rgba(255,255,255,.18)}',
    '.wlh-reach::after{content:"";position:absolute;left:100%;top:50%;width:3000px;border-top:1px dashed rgba(255,255,255,.75)}',
    '.wlh-reach.fold{background:linear-gradient(120deg,#3b82f6,#06b6d4);border-color:transparent}',
    '.wlh-reach.fold::after{display:none}',
    '.wlh-notice{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:calc(100% - 32px);padding:8px 14px;border-radius:999px;',
    'background:rgba(15,23,42,.96);border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 30px -12px rgba(0,0,0,.7);font-weight:500;',
    'transition:opacity .25s}',
    '.wlh-notice.bad{border-color:rgba(239,68,68,.65)}',
    '.wlh-notice[hidden]{display:block;opacity:0;pointer-events:none}',
  ].join('');

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function fmt(n) { return Number(n || 0).toLocaleString('fr-FR'); }
  function plural(n, word) { return fmt(n) + ' ' + word + (n > 1 ? 's' : ''); }

  // ---------------------------------------------------------------- interface
  var style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  document.title = 'Carte de chaleur · Wolflog';
  var root = el('div', 'wlh');
  var bar = el('header', 'wlh-bar');
  var brand = el('span', 'wlh-brand');
  brand.appendChild(el('i'));
  brand.appendChild(document.createTextNode('Wolflog'));
  var select = el('select', 'wlh-page');
  select.setAttribute('aria-label', 'Page');
  var modes = el('div', 'wlh-seg');
  var devices = el('div', 'wlh-seg');
  var stats = el('span', 'wlh-stats');
  var range = el('span', 'wlh-muted');
  var check = el('label', 'wlh-check');
  var showPage = el('input');
  showPage.type = 'checkbox';
  showPage.checked = true;
  check.appendChild(showPage);
  check.appendChild(document.createTextNode('Page'));
  [['clicks', 'Clics'], ['scroll', 'Défilement']].forEach(function (m) { modes.appendChild(segButton(m[0], m[1], 'mode')); });
  DEVICES.forEach(function (d) { devices.appendChild(segButton(d[0], d[1], 'device')); });
  [brand, select, modes, devices, stats, el('span', 'wlh-spacer'), range, check].forEach(function (x) { bar.appendChild(x); });

  var main = el('main', 'wlh-main');
  var viewport = el('div', 'wlh-viewport');
  var stage = el('div', 'wlh-stage');
  var frame = el('iframe');
  frame.name = 'wolflog-preview'; // le script navigateur du site n'y mesure rien
  frame.title = 'Page du site';
  frame.tabIndex = -1;
  var canvas = el('canvas');
  var labels = el('div', 'wlh-labels');
  stage.appendChild(frame);
  stage.appendChild(canvas);
  viewport.appendChild(stage);
  viewport.appendChild(labels);
  main.appendChild(viewport);
  var notice = el('div', 'wlh-notice', 'Chargement…');
  notice.setAttribute('role', 'status');
  root.appendChild(bar);
  root.appendChild(main);
  document.body.replaceChildren(root, notice);

  function segButton(value, label, key) {
    var b = el('button', null, label);
    b.type = 'button';
    b.dataset.value = value;
    b.addEventListener('click', function () {
      if (state[key] === value) return;
      state[key] = value;
      remember();
      if (key === 'device') loadPages(); else render();
    });
    return b;
  }

  function tell(text, bad) {
    notice.textContent = text || '';
    notice.className = 'wlh-notice' + (bad ? ' bad' : '');
    notice.hidden = !text;
  }

  /** Adresse de l'onglet à jour (sans le jeton) : un rechargement retrouve la même vue. */
  function remember() {
    var q = new URLSearchParams();
    if (state.path) q.set('path', state.path);
    q.set('device', state.device);
    q.set('mode', state.mode);
    history.replaceState(null, '', location.pathname + '?' + q);
    [].forEach.call(modes.children, function (b) { b.classList.toggle('on', b.dataset.value === state.mode); });
    [].forEach.call(devices.children, function (b) { b.classList.toggle('on', b.dataset.value === state.device); });
  }

  select.addEventListener('change', function () {
    state.path = select.value;
    remember();
    loadReport();
  });
  showPage.addEventListener('change', function () {
    state.page = showPage.checked;
    render();
  });
  addEventListener('resize', function () { render(); });

  // ---------------------------------------------------------------- données
  function get(path) {
    if (!token) return Promise.reject({ status: 401 });
    return fetch(api + path, { headers: { Authorization: 'Bearer ' + token }, credentials: 'omit', cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw { status: r.status };
      return r.json();
    });
  }

  /** Période de la carte, celle choisie dans Wolflog : « 7 derniers jours », ou les dates d'une période fixe. */
  function period(info) {
    var hours = Math.round((new Date(info.to) - new Date(info.from)) / 3600000);
    var at = function (d) { return new Date(d).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); };
    if (!info.live) return at(info.from) + ' → ' + at(info.to);
    if (hours <= 1) return 'dernière heure';
    return hours < 48 ? hours + ' dernières heures' : Math.round(hours / 24) + ' derniers jours';
  }

  function fail(err) {
    tell(err && err.status === 401
      ? 'Lien expiré ou invalide : rouvrez la carte depuis Wolflog (Clics & défilement › Ouvrir sur le site).'
      : 'Wolflog ne répond pas (' + new URL(api).origin + ').', true);
  }

  function loadPages() {
    get('pages?device=' + encodeURIComponent(state.device)).then(function (info) {
      pages = info.pages || [];
      range.textContent = period(info);
      if (!state.path && pages.length) state.path = pages[0].path;
      select.replaceChildren();
      var list = pages.slice();
      if (state.path && !list.some(function (p) { return p.path === state.path; })) list.unshift({ path: state.path, clicks: 0 });
      list.forEach(function (p) { select.appendChild(new Option(p.path + ' · ' + plural(p.clicks, 'clic'), p.path)); });
      select.value = state.path;
      remember();
      if (!state.path) { tell('Aucun clic mesuré sur cette période pour cet appareil.'); return; }
      loadReport();
    }, fail);
  }

  function loadReport() {
    var path = state.path;
    get('clickmap?path=' + encodeURIComponent(path) + '&device=' + encodeURIComponent(state.device)).then(function (r) {
      if (path !== state.path) return;
      report = r;
      navigate();
      render();
    }, fail);
  }

  // ---------------------------------------------------------------- page du site
  function navigate() {
    var src = encodeURI(state.path) + '?wolflog-preview=1';
    if (src === loadedSrc) return;
    loadedSrc = src;
    docHeight = 0;
    main.scrollTop = 0;
    tell('Chargement de la page…');
    frame.src = src;
  }

  frame.addEventListener('load', function () {
    tell('');
    // Page plus longue que la moyenne mesurée : la carte s'étend pour ne rien couper (rendu progressif : suivi quelques secondes).
    clearInterval(heightTimer);
    var ticks = 0, growth = 0;
    heightTimer = setInterval(function () {
      var h = 0;
      try { h = frame.contentDocument.documentElement.scrollHeight; } catch (e) { /* page d'un autre site après redirection */ }
      if (++ticks > 12) clearInterval(heightTimer);
      if (!report || h <= Math.max(docHeight, report.height) + 1) return;
      // Page qui grandit avec la fenêtre (hauteur en vh) : elle dépasserait toujours, on s'arrête.
      if (h - docHeight === growth || h > MAX_HEIGHT) { clearInterval(heightTimer); return; }
      growth = h - docHeight;
      docHeight = h;
      render();
    }, 400);
  });

  // ---------------------------------------------------------------- carte
  function render() {
    if (!report) return;
    var w = report.width, h = Math.max(report.height, docHeight);
    stage.style.width = frame.style.width = w + 'px';
    stage.style.height = frame.style.height = h + 'px';
    frame.style.opacity = state.page ? '1' : '0';
    scale = Math.min(1, (main.clientWidth - 32) / w) || 1;
    stage.style.transform = 'scale(' + scale + ')';
    viewport.style.width = w * scale + 'px';
    viewport.style.height = h * scale + 'px';
    stats.innerHTML = '';
    [[report.clicks, 'clic'], [report.views, 'vue']].forEach(function (s, i) {
      if (i) stats.appendChild(document.createTextNode(' · '));
      stats.appendChild(el('b', null, fmt(s[0])));
      stats.appendChild(document.createTextNode(' ' + s[1] + (s[0] > 1 ? 's' : '')));
    });
    stats.appendChild(document.createTextNode(' · '));
    stats.appendChild(el('b', null, Math.round(report.avgScroll) + ' %'));
    stats.appendChild(document.createTextNode(' défilé'));
    draw(w, h);
    placeLabels();
  }

  function draw(w, h) {
    var cw = Math.round(w * RES), ch = Math.round(h * RES);
    canvas.width = cw;
    canvas.height = ch;
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    ctx.clearRect(0, 0, cw, ch);
    if (state.mode === 'scroll') drawScroll(ctx, cw, ch);
    else drawClicks(ctx, cw, ch);
  }

  function drawClicks(ctx, w, h) {
    var points = report.points || [];
    if (!points.length) return;
    var max = Math.max.apply(null, points.map(function (p) { return p.count; }));
    var radius = RADIUS * RES;
    // 1) densité en niveaux d'alpha (positions en 1/10 000 de la largeur), 2) colorisation par la palette.
    points.forEach(function (p) {
      var x = (p.x / 10000) * w, y = p.y * RES;
      var g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, 'rgba(0,0,0,' + Math.max(0.08, Math.min(1, Math.sqrt(p.count / max))) + ')');
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
    });
    var img = ctx.getImageData(0, 0, w, h), d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var a = d[i + 3];
      if (!a) continue;
      d[i] = PALETTE[a * 3];
      d[i + 1] = PALETTE[a * 3 + 1];
      d[i + 2] = PALETTE[a * 3 + 2];
      d[i + 3] = Math.min(235, 60 + a);
    }
    ctx.putImageData(img, 0, 0);
  }

  function reachAt(pct) {
    var bands = report.scroll || [];
    for (var i = 0; i < bands.length - 1; i++) {
      var a = bands[i], b = bands[i + 1];
      if (pct >= a.depth && pct <= b.depth) return a.share + ((b.share - a.share) * (pct - a.depth)) / (b.depth - a.depth || 1);
    }
    return bands.length ? bands[bands.length - 1].share : 0;
  }

  /** Défilement : la page s'assombrit là où peu de visiteurs sont allés (profondeurs mesurées sur la hauteur moyenne). */
  function drawScroll(ctx, w, h) {
    var measured = report.height * RES;
    for (var y = 0; y < h; y += 4) {
      ctx.fillStyle = 'rgba(16, 16, 12, ' + (1 - reachAt(Math.min(100, (y / measured) * 100))) * 0.72 + ')';
      ctx.fillRect(0, y, w, 4);
    }
    ctx.fillStyle = 'rgba(59, 130, 246, .9)';
    ctx.fillRect(0, report.fold * RES - 1, w, 2);
  }

  function placeLabels() {
    labels.replaceChildren();
    if (state.mode !== 'scroll' || !report.views) return;
    var wanted = [{ y: report.fold, text: 'Ligne de flottaison moyenne (' + report.fold + ' px)', cls: 'fold' }];
    [0.75, 0.5, 0.25].forEach(function (target) {
      var band = (report.scroll || []).filter(function (b) { return b.share < target; })[0];
      if (band) wanted.push({ y: (band.depth / 100) * report.height, text: target * 100 + ' % des visiteurs ont vu jusqu’ici', cls: '' });
    });
    wanted.forEach(function (w) {
      var l = el('div', 'wlh-reach ' + w.cls, w.text);
      l.style.top = w.y * scale + 'px';
      labels.appendChild(l);
    });
  }

  remember();
  loadPages();
})();
