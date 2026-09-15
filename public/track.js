// Roast My LinkedIn — lightweight analytics client.
// No cookies. Session ID lives in sessionStorage (per-tab, wiped on close).
// UTM params captured on first pageview per session.
//
// Public API: window.rml('event_name', { any: 'props' })
// Auto-tracks: page_view, time_on_page (via visibilitychange + pagehide).
(function () {
  var SES_KEY = 'rml_ses';
  var UTM_KEY = 'rml_utm';
  var TRACK_URL = '/track';

  function sid() {
    try {
      var s = sessionStorage.getItem(SES_KEY);
      if (!s) {
        s = Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
        sessionStorage.setItem(SES_KEY, s);
      }
      return s;
    } catch (e) { return 'x' + Math.random().toString(36).slice(2, 12); }
  }

  function utm() {
    try {
      var cached = sessionStorage.getItem(UTM_KEY);
      if (cached) return JSON.parse(cached);
    } catch (e) { /* ignore */ }
    var out = {};
    var params = new URLSearchParams(location.search);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'].forEach(function (k) {
      var v = params.get(k);
      if (v) out[k] = v;
    });
    try { sessionStorage.setItem(UTM_KEY, JSON.stringify(out)); } catch (e) { /* ignore */ }
    return out;
  }

  function send(payload) {
    var body = JSON.stringify(payload);
    // sendBeacon is fire-and-forget and survives page unload — critical
    // for time_on_page which fires as the user leaves.
    if (navigator.sendBeacon) {
      try {
        var blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(TRACK_URL, blob)) return;
      } catch (e) { /* fall through */ }
    }
    try {
      fetch(TRACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
        keepalive: true,
      }).catch(function () { /* swallow */ });
    } catch (e) { /* swallow */ }
  }

  function track(type, props) {
    var payload = {
      sessionId: sid(),
      at: Date.now(),
      type: String(type || 'unknown').slice(0, 40),
      path: location.pathname,
      ref: document.referrer || null,
      vp: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
      utm: utm(),
    };
    // Overlay caller props (they can override sessionId/at/type at their
    // own risk, but usually just append event-specific fields).
    if (props && typeof props === 'object') {
      for (var k in props) {
        if (Object.prototype.hasOwnProperty.call(props, k)) payload[k] = props[k];
      }
    }
    send(payload);
  }
  window.rml = track;

  // Automatic page_view on load.
  var pageStart = Date.now();
  track('page_view', { title: document.title || null });

  // Time on page — fire on tab hide + on pagehide (which fires on
  // navigation-away and reliably on iOS Safari where beforeunload doesn't).
  var timeSent = false;
  function sendTime() {
    if (timeSent) return;
    timeSent = true;
    track('time_on_page', { ms: Date.now() - pageStart });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') sendTime();
  });
  window.addEventListener('pagehide', sendTime);
  window.addEventListener('beforeunload', sendTime);
})();
