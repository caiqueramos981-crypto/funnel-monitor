/**
 * Funnel Monitor Snippet v1.0
 * Lightweight tracker — max ~2kb minified
 * Usage: <script src="https://YOUR-APP.railway.app/snippet.js"
 *           data-server="https://YOUR-APP.railway.app"
 *           data-page="quiz"
 *           data-funnel="default">
 *        </script>
 */
(function () {
  'use strict';

  var script = document.currentScript || (function () {
    var s = document.getElementsByTagName('script');
    return s[s.length - 1];
  })();

  var SERVER = script.getAttribute('data-server') || 'https://YOUR-APP.railway.app';
  var PAGE   = script.getAttribute('data-page')   || 'quiz';
  var FUNNEL = script.getAttribute('data-funnel') || 'default';
  var SESSION_KEY = 'fm_session';
  var SESSION_TTL = 30 * 60 * 1000; // 30 min

  // ── Session ID ──────────────────────────────────────────────────────────────
  function getSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (raw) {
        var obj = JSON.parse(raw);
        if (obj.exp > Date.now()) {
          obj.exp = Date.now() + SESSION_TTL;
          localStorage.setItem(SESSION_KEY, JSON.stringify(obj));
          return obj.id;
        }
      }
    } catch (e) {}
    var id = 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ id: id, exp: Date.now() + SESSION_TTL }));
    } catch (e) {}
    return id;
  }

  // ── Send event ──────────────────────────────────────────────────────────────
  function sendEvent(geo) {
    var payload = {
      session_id: getSession(),
      page:       PAGE,
      funnel:     FUNNEL,
      country:    (geo && geo.country_code) || '',
      city:       (geo && geo.city)         || '',
      referrer:   document.referrer         || '',
      timestamp:  Date.now()
    };

    if (navigator.sendBeacon) {
      var blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
      navigator.sendBeacon(SERVER + '/track', blob);
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', SERVER + '/track', true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(JSON.stringify(payload));
    }
  }

  // ── Geo lookup ──────────────────────────────────────────────────────────────
  var GEO_KEY = 'fm_geo';
  var GEO_TTL = 60 * 60 * 1000; // 1h cache

  function getGeoAndSend() {
    try {
      var cached = localStorage.getItem(GEO_KEY);
      if (cached) {
        var g = JSON.parse(cached);
        if (g.exp > Date.now()) return sendEvent(g);
      }
    } catch (e) {}

    var xhr = new XMLHttpRequest();
    xhr.open('GET', 'https://ipapi.co/json/', true);
    xhr.timeout = 3000;
    xhr.onload = function () {
      if (xhr.status === 200) {
        try {
          var geo = JSON.parse(xhr.responseText);
          var toCache = { country_code: geo.country_code, city: geo.city, exp: Date.now() + GEO_TTL };
          try { localStorage.setItem(GEO_KEY, JSON.stringify(toCache)); } catch (e) {}
          sendEvent(toCache);
        } catch (e) { sendEvent(null); }
      } else {
        sendEvent(null);
      }
    };
    xhr.ontimeout = xhr.onerror = function () { sendEvent(null); };
    xhr.send();
  }

  // ── Boot ────────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', getGeoAndSend);
  } else {
    // Small defer so page loads first
    setTimeout(getGeoAndSend, 300);
  }
})();
