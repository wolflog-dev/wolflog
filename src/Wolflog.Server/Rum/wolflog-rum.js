/* Wolflog RUM : erreurs JavaScript, chargement des pages, appels réseau, Web Vitals
   et audience anonyme (pages vues, sources, événements, clics et défilement).
   <script src="https://wolflog.exemple.fr/wolflog-rum.js" defer data-key="wlb_…" data-service="mon-site" data-env="prod"></script>
   Options : data-analytics="false" (pas d'audience), data-heatmaps="false" (pas de clics ni de défilement),
   data-pageviews="server" (pages vues mesurées par l'application, ex. Wolflog.Client.Blazor : pas de double comptage).
   Événements : wolflog.track('inscription', { plan: 'pro' }) ou <button data-wolflog-event="inscription" data-wolflog-event-plan="pro">.
   Utilisateurs uniques : data-user="identifiant de connexion" (vide si personne n'est connecté) ou wolflog.identify('…') après
   la connexion, wolflog.identify(null) à la déconnexion. Wolflog ne garde qu'un pseudonyme de l'identifiant.
   Ajoutez data-wolflog-mask sur un élément pour ne jamais envoyer son libellé.
   Captures de page (cartes de chaleur affichables partout, voir plus bas) : data-snapshots="false" les désactive.
   Relais par le site (ASP.NET Core : app.UseWolflogHeatmapPreview()) : <script src="/_wolflog/wolflog-rum.js" …>, l'envoi passe
   alors par le site lui-même (Wolflog en HTTP derrière un site en HTTPS, bloqueurs de publicité). */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__wolflogRum) return;
  // Page affichée dans l'aperçu des cartes de chaleur de Wolflog : rien n'est mesuré. Wolflog apprend seulement quelle page
  // s'affiche vraiment (une redirection vers la page de connexion se voit ainsi).
  if (window.name === 'wolflog-preview' || /[?&]wolflog-preview=1/.test(location.search)) {
    try { if (window.parent !== window) window.parent.postMessage({ wolflogPreview: location.pathname }, '*'); } catch (e) { /* ignoré */ }
    return;
  }
  window.__wolflogRum = true;

  var attr = function (n, d) { return script.getAttribute('data-' + n) || d; };
  // Adresse de Wolflog : dossier du script (https://wolflog/ ; /_wolflog/ quand le site le relaie).
  var base = attr('endpoint', new URL('.', new URL(script.src, location.href)).href).replace(/\/$/, '');
  var endpoint = base + '/v1/rum?k=' + encodeURIComponent(attr('key', ''));
  var service = attr('service', location.hostname);
  var traceOrigins = attr('trace-origins', '').split(/[\s,]+/).filter(Boolean);
  var sampleRate = parseFloat(attr('sample', '1'));
  var analytics = attr('analytics', 'true') !== 'false';
  var heatmaps = analytics && attr('heatmaps', 'true') !== 'false';
  var serverPageviews = attr('pageviews', 'browser') === 'server';
  if (Math.random() > sampleRate) return;

  var session;
  try {
    session = sessionStorage.getItem('wolflog.session');
    if (!session) { session = hex(8); sessionStorage.setItem('wolflog.session', session); }
  } catch (e) { session = hex(8); }

  // Utilisateur connecté (utilisateurs uniques) : attribut data-user de la page, sinon celui annoncé par wolflog.identify.
  var user = '';
  function identify(id) {
    user = id == null ? '' : String(id).slice(0, 256);
    try { if (user) sessionStorage.setItem('wolflog.user', user); else sessionStorage.removeItem('wolflog.user'); } catch (e) { /* stockage indisponible */ }
  }
  if (script.hasAttribute('data-user')) identify(script.getAttribute('data-user'));
  else try { user = sessionStorage.getItem('wolflog.user') || ''; } catch (e) { /* stockage indisponible */ }

  var queue = [];
  function hex(bytes) {
    var a = new Uint8Array(bytes);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function push(e) {
    e.ts = e.ts || Date.now();
    e.path = e.path || location.pathname;
    queue.push(e);
    if (queue.length >= 30) flush();
  }
  function flush() {
    if (!queue.length) return;
    var body = JSON.stringify({
      service: service, env: attr('env', ''), version: attr('version', ''), session: session,
      ua: navigator.userAgent, lang: navigator.language, screen: screen.width + 'x' + screen.height, hostname: location.host,
      user: user || undefined, events: queue.splice(0, queue.length),
    });
    // text/plain : pas de requête préalable CORS ; sendBeacon survit à la fermeture de la page.
    try {
      if (navigator.sendBeacon && navigator.sendBeacon(endpoint, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) { /* repli ci-dessous */ }
    try { origFetch(endpoint, { method: 'POST', body: body, keepalive: true, headers: { 'Content-Type': 'text/plain' } }).catch(function () {}); } catch (e) { /* ignoré */ }
  }
  setInterval(flush, 5000);
  addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { reportVitals(); flush(); } });
  addEventListener('pagehide', function () { reportVitals(); flush(); });

  // ---------------------------------------------------------------- erreurs
  addEventListener('error', function (ev) {
    var t = ev.target;
    if (t && t !== window && (t.src || t.href)) {
      push({ type: 'error', name: 'ResourceError', message: 'Échec du chargement de ' + (t.src || t.href) });
      return;
    }
    var err = ev.error;
    push({ type: 'error', name: (err && err.name) || 'Error', message: String((err && err.message) || ev.message || 'Erreur'),
      stack: err && err.stack, source: ev.filename, line: ev.lineno, col: ev.colno });
  }, true);
  addEventListener('unhandledrejection', function (ev) {
    var r = ev.reason;
    push({ type: 'error', name: (r && r.name) || 'UnhandledRejection', message: String((r && r.message) || r), stack: r && r.stack });
  });

  // ---------------------------------------------------------------- pages
  // Audience : titre, référent et query string (le serveur n'en garde que les paramètres UTM).
  function audience(e, referrer) {
    if (analytics && !serverPageviews) { e.title = document.title; e.referrer = referrer; e.query = location.search; }
    else e.noAudience = true;
    return e;
  }
  function pageLoad() {
    var n = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!n) { if (analytics) push(audience({ type: 'page', nav: 'navigate' }, document.referrer)); return; }
    push(audience({ type: 'page', duration: Math.round(n.loadEventEnd || n.duration), ttfb: Math.round(n.responseStart),
      domReady: Math.round(n.domContentLoadedEventEnd), size: n.transferSize || 0, nav: n.type }, document.referrer));
  }
  if (document.readyState === 'complete') setTimeout(pageLoad, 0);
  else addEventListener('load', function () { setTimeout(pageLoad, 0); });
  if (document.readyState === 'complete') setTimeout(snapshotLater, 0); // après l'initialisation de la fin du script
  else addEventListener('load', snapshotLater);

  // Applications monopages : chaque changement de route est une vue.
  var lastPath = location.pathname, lastUrl = location.href;
  function routeChanged() {
    if (location.pathname === lastPath) return;
    var previous = lastUrl, path = location.pathname;
    endPage();
    lastPath = path;
    lastUrl = location.href;
    startPage();
    snapshotLater();
    // Laisse le temps à l'application de mettre à jour le titre de la page.
    setTimeout(function () { push(audience({ type: 'view', path: path }, previous)); }, 150);
  }
  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function () { var r = orig.apply(this, arguments); setTimeout(routeChanged, 0); return r; };
  });
  addEventListener('popstate', routeChanged);

  // ---------------------------------------------------------------- appels réseau
  function traced(url) {
    try {
      var u = new URL(url, location.href);
      if (u.href.indexOf(base + '/v1/') === 0) return null;
      var allowed = u.origin === location.origin || traceOrigins.some(function (o) { return u.origin === o || u.href.indexOf(o) === 0; });
      return { url: u.href, host: u.host, inject: allowed };
    } catch (e) { return null; }
  }
  function record(info, method, status, start, ids) {
    push({ type: 'fetch', method: method, url: info.url, host: info.host, status: status, duration: Math.round(performance.now() - start),
      trace: ids && ids.trace, span: ids && ids.span, ts: Date.now() - Math.round(performance.now() - start) });
  }
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var info = traced(typeof input === 'string' ? input : (input && input.url) || String(input));
      if (!info) return origFetch(input, init);
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var ids = null;
      if (info.inject) {
        ids = { trace: hex(16), span: hex(8) };
        init = init || {};
        var headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        headers.set('traceparent', '00-' + ids.trace + '-' + ids.span + '-01');
        init.headers = headers;
      }
      var start = performance.now();
      return origFetch(input, init).then(function (res) { record(info, method, res.status, start, ids); return res; },
        function (err) { record(info, method, 0, start, ids); throw err; });
    };
  }
  var open = XMLHttpRequest.prototype.open, send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__wolflog = { method: String(method).toUpperCase(), info: traced(url) };
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var v = this.__wolflog, xhr = this;
    if (v && v.info) {
      if (v.info.inject) {
        v.ids = { trace: hex(16), span: hex(8) };
        try { xhr.setRequestHeader('traceparent', '00-' + v.ids.trace + '-' + v.ids.span + '-01'); } catch (e) { /* en-tête refusé */ }
      }
      var start = performance.now();
      xhr.addEventListener('loadend', function () { record(v.info, v.method, xhr.status, start, v.ids); });
    }
    return send.apply(this, arguments);
  };

  // ---------------------------------------------------------------- Web Vitals
  var vitals = { lcp: 0, cls: 0, inp: 0, fcp: 0 }, reported = false, clsWindow = 0, clsLast = 0;
  function observe(type, cb) {
    try { new PerformanceObserver(function (l) { l.getEntries().forEach(cb); }).observe({ type: type, buffered: true }); } catch (e) { /* non géré */ }
  }
  observe('paint', function (e) { if (e.name === 'first-contentful-paint') vitals.fcp = e.startTime; });
  observe('largest-contentful-paint', function (e) { vitals.lcp = e.startTime; });
  observe('layout-shift', function (e) {
    if (e.hadRecentInput) return;
    // Fenêtres de session : au plus 1 s entre décalages, 5 s au total.
    if (e.startTime - clsLast > 1000 || e.startTime - clsWindow > 5000) { clsWindow = e.startTime; vitals.clsCurrent = 0; }
    clsLast = e.startTime;
    vitals.clsCurrent = (vitals.clsCurrent || 0) + e.value;
    vitals.cls = Math.max(vitals.cls, vitals.clsCurrent);
  });
  observe('event', function (e) { if (e.interactionId && e.duration > vitals.inp) vitals.inp = e.duration; });
  function reportVitals() {
    if (reported) return;
    reported = true;
    var n = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    var v = { lcp: vitals.lcp, fcp: vitals.fcp, inp: vitals.inp, cls: vitals.cls, ttfb: n ? n.responseStart : 0 };
    Object.keys(v).forEach(function (k) { if (v[k] > 0 || k === 'cls') push({ type: 'vital', name: k, value: Math.round(v[k] * (k === 'cls' ? 1000 : 1)) / (k === 'cls' ? 1000 : 1) }); });
  }

  // ---------------------------------------------------------------- audience : événements
  function track(name, data) {
    if (!analytics || !name) return;
    push({ type: 'track', name: String(name).slice(0, 100), data: data && typeof data === 'object' ? data : undefined });
  }
  window.wolflog = window.wolflog || {};
  window.wolflog.track = track;
  window.wolflog.identify = identify;

  // ---------------------------------------------------------------- cartes de chaleur : clics et défilement
  // Anonyme : coordonnées, sélecteur CSS et libellé des liens/boutons uniquement (jamais le contenu des champs).
  var maxDepth = 0, scrollSent = false, scrollPath = location.pathname, recent = [];
  function docWidth() { return Math.max(document.documentElement.scrollWidth, document.body ? document.body.scrollWidth : 0) || innerWidth; }
  function docHeight() { return Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0); }
  function depth() {
    var h = docHeight();
    return h ? Math.min(100, Math.round(((window.scrollY || 0) + innerHeight) / h * 100)) : 100;
  }
  function selector(el) {
    var parts = [];
    for (var n = 0; el && el.nodeType === 1 && n < 5 && el !== document.body; n++, el = el.parentElement) {
      var tag = el.tagName.toLowerCase();
      if (el.id && !/\d{3,}|^[a-f0-9-]{16,}$/i.test(el.id)) { parts.unshift(tag + '#' + el.id); break; }
      var cls = (typeof el.className === 'string' ? el.className : '').split(/\s+/).filter(function (c) {
        return c && !/^(active|show|open|hover|focus|selected|disabled)$/.test(c) && !/\d{3,}/.test(c);
      }).slice(0, 2);
      var part = tag + (cls.length ? '.' + cls.join('.') : '');
      var parent = el.parentElement;
      if (parent) {
        var same = Array.prototype.filter.call(parent.children, function (c) { return c.tagName === el.tagName; });
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(el) + 1) + ')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0, 200);
  }
  function label(el) {
    var a = el.closest && el.closest('a,button,[role=button],summary,input[type=submit],input[type=button]');
    if (!a || a.closest('[data-wolflog-mask]')) return undefined;
    var t = a.tagName === 'INPUT' ? a.value : a.getAttribute('aria-label') || a.textContent || '';
    return t.replace(/\s+/g, ' ').trim().slice(0, 60) || undefined;
  }
  function viewport(e) {
    e.vw = innerWidth; e.vh = innerHeight; e.dh = docHeight();
    return e;
  }
  // Défilement maximal atteint : envoyé une fois par page (changement de route, onglet masqué, fermeture).
  function endPage() {
    if (!heatmaps || scrollSent || !innerWidth || !innerHeight) return;
    scrollSent = true;
    push(viewport({ type: 'scroll', path: scrollPath, depth: Math.max(maxDepth, depth()) }));
  }
  function startPage() {
    scrollPath = location.pathname;
    maxDepth = 0;
    scrollSent = false;
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || t.nodeType !== 1) return;
    // Événements déclaratifs : data-wolflog-event="nom" et data-wolflog-event-<propriété>="valeur".
    var tagged = t.closest && t.closest('[data-wolflog-event]');
    if (tagged) {
      var data = {};
      for (var i = 0; i < tagged.attributes.length; i++) {
        var name = tagged.attributes[i].name;
        if (name.indexOf('data-wolflog-event-') === 0) data[name.slice(19)] = tagged.attributes[i].value;
      }
      track(tagged.getAttribute('data-wolflog-event'), data);
    }
    if (!heatmaps || !innerWidth) return;
    var now = Date.now();
    recent = recent.filter(function (c) { return now - c.t < 800 && Math.abs(c.x - ev.pageX) < 30 && Math.abs(c.y - ev.pageY) < 30; });
    recent.push({ t: now, x: ev.pageX, y: ev.pageY });
    var click = viewport({ type: 'click', x: Math.round(ev.pageX / docWidth() * 10000) / 10000, y: Math.round(ev.pageY), selector: selector(t), label: label(t) });
    if (recent.length >= 3) click.rage = true; // clics répétés au même endroit : frustration
    push(click);
    // Dead click : ni modification de la page ni navigation dans les 700 ms (hors champs de saisie).
    if (!t.closest('input,textarea,select,label,[contenteditable]') && window.MutationObserver) {
      var changed = false, before = location.href;
      var mo = new MutationObserver(function () { changed = true; });
      mo.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
      setTimeout(function () { mo.disconnect(); if (!changed && location.href === before) click.dead = true; }, 700);
    }
  }, true);

  var ticking = false;
  addEventListener('scroll', function () {
    if (ticking || !heatmaps) return;
    ticking = true;
    setTimeout(function () { ticking = false; maxDepth = Math.max(maxDepth, depth()); }, 200);
  }, { passive: true });
  addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') { endPage(); flush(); } });
  addEventListener('pagehide', function () { endPage(); flush(); });

  // ---------------------------------------------------------------- cartes de chaleur : capture de la page
  // Wolflog dessine la carte sur cette capture quand il ne peut pas afficher la page en direct : site en HTTP et Wolflog en
  // HTTPS, page derrière une connexion, site injoignable. Une capture par page et par appareil et par jour au plus (Wolflog dit
  // s'il en manque une). Rien de personnel : texte du contenu masqué (seuls restent menus, titres, boutons, liens et libellés,
  // hors tableaux), valeurs des champs jamais envoyées, images remplacées par des aplats, adresses des liens retirées.
  // data-wolflog-mask masque un élément entier, data-wolflog-unmask laisse voir le texte d'un élément.
  var snapshots = heatmaps && attr('snapshots', 'true') !== 'false' && !!origFetch && !!window.JSON;
  var snapshotEndpoint = base + '/v1/rum/snapshot?k=' + encodeURIComponent(attr('key', ''));
  var asked = {};
  var KEEP = /^(A|BUTTON|LABEL|LEGEND|H[1-6]|TH|CAPTION|SUMMARY|NAV|HEADER)$/;
  var ROLES = /^(button|link|tab|menuitem|heading|columnheader|navigation)$/;
  var PIXEL = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  function snapshotLater() {
    var path = location.pathname;
    if (!snapshots || asked[path]) return;
    asked[path] = true;
    try { if (sessionStorage.getItem('wolflog.snap.' + path)) return; sessionStorage.setItem('wolflog.snap.' + path, '1'); } catch (e) { /* stockage indisponible */ }
    // Laisse l'application finir d'afficher la page (Blazor, applications monopages).
    setTimeout(function () {
      if (location.pathname !== path || document.visibilityState === 'hidden') return;
      origFetch(snapshotEndpoint + '&service=' + encodeURIComponent(service) + '&path=' + encodeURIComponent(path) + '&vw=' + innerWidth, { credentials: 'omit' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (answer) { if (answer && answer.want && location.pathname === path) sendSnapshot(path); })
        .catch(function () { /* Wolflog injoignable : pas de capture */ });
    }, 2500);
  }

  function sendSnapshot(path) {
    var html;
    try { html = capture(); } catch (e) { return; }
    if (!html || html.length > 2000000) return;
    var body = JSON.stringify({ service: service, path: path, vw: innerWidth, dh: docHeight(), ua: navigator.userAgent, html: html });
    // Réponse lue (vide) : non lue, le navigateur affiche l'envoi comme interrompu dans ses outils de développement.
    origFetch(snapshotEndpoint, { method: 'POST', body: body, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
      .then(function (r) { return r.text(); })
      .catch(function () {});
  }

  /** Texte masqué : dans un tableau, ou hors des menus, titres, boutons, liens et libellés (sauf data-wolflog-unmask). */
  function masked(el) {
    var keep = false;
    for (var e = el; e && e.nodeType === 1; e = e.parentElement) {
      if (e.hasAttribute('data-wolflog-mask') || /^(TD|TEXTAREA|OPTION|DATALIST)$/.test(e.tagName)) return true;
      if (e.hasAttribute('data-wolflog-unmask')) return false;
      if (!keep && (KEEP.test(e.tagName) || ROLES.test(e.getAttribute('role') || ''))) keep = true;
    }
    return !keep;
  }

  function hide(text) {
    return text.replace(/[^\s.,;:!?'"()\[\]\-–—/|+*%€$&@#]/g, function (c) {
      if (/\d/.test(c)) return '0';
      return c !== c.toLowerCase() ? 'X' : 'x';
    });
  }

  function size(el) {
    var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  }

  function placeholder(clone, source) {
    var d = document.createElement('div');
    var sz = size(source);
    d.setAttribute('style', 'display:inline-block;width:' + sz.w + 'px;height:' + sz.h + 'px;background:#e2e8f0;border-radius:4px');
    clone.parentNode.replaceChild(d, clone);
  }

  /** Feuilles de style lisibles recopiées (adresses rendues absolues), les autres liées par leur adresse. */
  function sheetCss(sheet, depthLeft) {
    var rules;
    try { rules = sheet.cssRules; } catch (e) { return null; }
    var css = '', baseHref = sheet.href || location.href;
    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      if (r.type === 3 && r.styleSheet && depthLeft > 0) {
        var inner = sheetCss(r.styleSheet, depthLeft - 1);
        if (inner !== null) { css += (r.media && r.media.mediaText ? '@media ' + r.media.mediaText + '{' + inner + '}' : inner) + '\n'; continue; }
      }
      css += r.cssText + '\n';
    }
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, function (m, q, u) {
      if (/^(data:|#)/i.test(u)) return m;
      try { return 'url("' + new URL(u, baseHref).href + '")'; } catch (e) { return m; }
    });
  }

  function styles() {
    var out = '', sheets = Array.prototype.slice.call(document.styleSheets).concat(document.adoptedStyleSheets || []);
    sheets.forEach(function (sheet) {
      if (sheet.disabled) return;
      var media = sheet.media && sheet.media.mediaText ? ' media="' + sheet.media.mediaText.replace(/"/g, '&quot;') + '"' : '';
      var css = sheetCss(sheet, 3);
      if (css !== null) out += '<style' + media + '>' + css.replace(/<\/style/gi, '<\\/style') + '</style>';
      else if (sheet.href) out += '<link rel="stylesheet" href="' + sheet.href.replace(/"/g, '&quot;') + '"' + media + '>';
    });
    return out;
  }

  function capture() {
    var root = document.documentElement, clone = root.cloneNode(true);
    var a = document.createTreeWalker(root, 5), b = document.createTreeWalker(clone, 5); // éléments et textes
    var texts = [], swaps = [], drops = [];
    // Parcours parallèle : la page donne les tailles et le contexte de chaque nœud, la copie reçoit les modifications.
    for (var x = a.currentNode, y = b.currentNode; x && y; x = a.nextNode(), y = b.nextNode()) {
      if (y.nodeType === 3) {
        var parent = x.parentElement;
        if (parent && /\S/.test(y.nodeValue) && !/^(STYLE|SCRIPT|NOSCRIPT|TITLE)$/.test(parent.tagName) && masked(parent)) texts.push(y);
        continue;
      }
      var tag = y.tagName;
      if (/^(SCRIPT|NOSCRIPT|TEMPLATE|BASE|STYLE)$/.test(tag) || (tag === 'LINK' && !/^icon$/i.test(y.rel)) || (tag === 'META' && y.httpEquiv)) { drops.push(y); continue; }
      for (var i = y.attributes.length - 1; i >= 0; i--) {
        var name = y.attributes[i].name;
        if (/^on/i.test(name) || /^(title|alt|action|formaction|ping)$/i.test(name)) y.removeAttribute(name);
      }
      if (tag === 'A' && y.hasAttribute('href')) y.setAttribute('href', '#');
      if (tag === 'INPUT' && !/^(button|submit|reset|image)$/i.test(y.type)) { y.removeAttribute('value'); y.removeAttribute('checked'); }
      if (tag === 'TEXTAREA') y.textContent = '';
      if (tag === 'IMG') {
        var sz = size(x);
        y.removeAttribute('srcset');
        y.removeAttribute('sizes');
        y.setAttribute('src', PIXEL);
        if (sz.w && sz.h) { y.setAttribute('width', sz.w); y.setAttribute('height', sz.h); }
        y.setAttribute('style', (y.getAttribute('style') || '') + ';background:#e2e8f0');
      } else if (tag === 'SOURCE' || tag === 'TRACK') drops.push(y);
      else if (/^(IFRAME|OBJECT|EMBED|CANVAS|VIDEO|AUDIO)$/.test(tag)) swaps.push([y, x]);
    }
    texts.forEach(function (t) {
      var host = t.parentNode;
      if (/^(OPTION|TEXTAREA)$/.test(host.nodeName)) { t.nodeValue = hide(t.nodeValue); return; }
      var span = document.createElement('span');
      span.className = 'wl-mask';
      span.textContent = hide(t.nodeValue);
      host.replaceChild(span, t);
    });
    swaps.forEach(function (s) { placeholder(s[0], s[1]); });
    drops.forEach(function (d) { if (d.parentNode) d.parentNode.removeChild(d); });
    var css = styles() + '<style>.wl-mask{color:transparent!important;background:rgba(148,163,184,.45)!important;border-radius:3px;'
      + '-webkit-box-decoration-break:clone;box-decoration-break:clone}</style>';
    var html = clone.outerHTML;
    var head = html.indexOf('</head>');
    return '<!doctype html>' + (head >= 0 ? html.slice(0, head) + css + html.slice(head) : css + html);
  }
})();
