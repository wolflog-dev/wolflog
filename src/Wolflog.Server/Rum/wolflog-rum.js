/* Wolflog RUM : erreurs JavaScript, chargement des pages, appels réseau et Web Vitals.
   <script src="https://wolflog.exemple.fr/wolflog-rum.js" defer data-key="wlb_…" data-service="mon-site" data-env="prod"></script> */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script || window.__wolflogRum) return;
  window.__wolflogRum = true;

  var attr = function (n, d) { return script.getAttribute('data-' + n) || d; };
  var base = attr('endpoint', new URL(script.src, location.href).origin).replace(/\/$/, '');
  var endpoint = base + '/v1/rum?k=' + encodeURIComponent(attr('key', ''));
  var service = attr('service', location.hostname);
  var traceOrigins = attr('trace-origins', '').split(/[\s,]+/).filter(Boolean);
  var sampleRate = parseFloat(attr('sample', '1'));
  if (Math.random() > sampleRate) return;

  var session;
  try {
    session = sessionStorage.getItem('wolflog.session');
    if (!session) { session = hex(8); sessionStorage.setItem('wolflog.session', session); }
  } catch (e) { session = hex(8); }

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
      ua: navigator.userAgent, lang: navigator.language, screen: screen.width + 'x' + screen.height, events: queue.splice(0, queue.length),
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
  function pageLoad() {
    var n = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    if (!n) return;
    push({ type: 'page', duration: Math.round(n.loadEventEnd || n.duration), ttfb: Math.round(n.responseStart),
      domReady: Math.round(n.domContentLoadedEventEnd), size: n.transferSize || 0, nav: n.type });
  }
  if (document.readyState === 'complete') setTimeout(pageLoad, 0);
  else addEventListener('load', function () { setTimeout(pageLoad, 0); });

  // Applications monopages : chaque changement de route est une vue.
  var lastPath = location.pathname;
  function routeChanged() {
    if (location.pathname === lastPath) return;
    lastPath = location.pathname;
    push({ type: 'view' });
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
})();
