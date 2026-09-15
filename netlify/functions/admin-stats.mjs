// GET /admin/stats?token=<TEST_PAYMENT_TOKEN>&days=7
//
// Owner-only analytics dashboard. Server-renders a single HTML page with:
//   - Top-line KPIs (sessions, page views, submits, checkouts, purchases)
//   - Funnel visualization (voronka) of session progression through the
//     landing -> audit -> paywall -> checkout -> success -> recipe steps
//   - Top UTM sources / referrers / countries
//   - Full list of LinkedIn URLs / usernames that visitors audited
//
// Auth: query token must equal process.env.TEST_PAYMENT_TOKEN. Same secret
// we already require for /simulate-payment (fewer secrets to manage). We
// return 403 with no other information on a bad token.

import { connectLambda, getStore } from '@netlify/blobs';

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ------- date range helpers -------
function isoDay(d) { return d.toISOString().slice(0, 10); }
function shiftDays(d, delta) { const x = new Date(d); x.setUTCDate(x.getUTCDate() + delta); return x; }

async function loadEventsRange(days) {
  const store = getStore('analytics');
  const today = new Date();
  const events = [];
  for (let i = 0; i < days; i++) {
    const day = isoDay(shiftDays(today, -i));
    let listing;
    try { listing = await store.list({ prefix: `events/${day}/` }); }
    catch { continue; }
    const blobs = listing?.blobs || [];
    // Parallelize the reads within the day for speed.
    const batch = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' }).catch(() => null)));
    for (const ev of batch) { if (ev) events.push(ev); }
  }
  return events;
}

// ------- aggregation -------
function buildSessions(events) {
  // sessions: Map<sessionId, { types: Set<string>, evs: Event[], first: number, last: number, utm, ref, country }>
  const sessions = new Map();
  for (const e of events) {
    if (!sessions.has(e.sessionId)) {
      sessions.set(e.sessionId, {
        id: e.sessionId,
        types: new Set(),
        evs: [],
        first: e.at,
        last: e.at,
        utm: e.utm || {},
        ref: e.ref || null,
        country: e.country || null,
      });
    }
    const s = sessions.get(e.sessionId);
    s.types.add(e.type);
    s.evs.push(e);
    if (e.at < s.first) s.first = e.at;
    if (e.at > s.last) s.last = e.at;
    // Latest non-empty UTM wins (first-touch is arguably better; MVP-simple wins here).
    if (e.utm && Object.keys(e.utm).length) s.utm = e.utm;
    if (e.ref && !s.ref) s.ref = e.ref;
    if (e.country && !s.country) s.country = e.country;
  }
  return sessions;
}

const FUNNEL_STEPS = [
  { name: 'Landed on site',      match: (s) => s.types.has('page_view') },
  { name: 'Submitted audit',     match: (s) => s.types.has('audit_submit') },
  { name: 'Report loaded',       match: (s) => s.types.has('audit_completed') },
  { name: 'Viewed paywall',      match: (s) => s.types.has('paywall_view') },
  { name: 'Clicked checkout',    match: (s) => s.types.has('checkout_click') || s.types.has('sim_payment_click') },
  { name: 'Reached success',     match: (s) => s.types.has('success_view') },
  { name: 'Opened Recipe',       match: (s) => s.types.has('recipe_view') },
  { name: 'Downloaded PDF',      match: (s) => s.types.has('pdf_download') },
];

function buildFunnel(sessions) {
  const arr = [...sessions.values()];
  return FUNNEL_STEPS.map(step => ({
    name: step.name,
    count: arr.filter(step.match).length,
  }));
}

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ------- render -------
function renderPage({ days, events, sessions, funnel, kpis, utms, refs, countries, linkedins }) {
  const totalSessions = sessions.size;
  const funnelMax = funnel[0]?.count || 1;

  const funnelRows = funnel.map((step, i) => {
    const pct = totalSessions ? Math.round((step.count / totalSessions) * 100) : 0;
    const width = funnelMax ? Math.max(2, (step.count / funnelMax) * 100) : 0;
    const dropRate = i > 0 && funnel[i - 1].count
      ? Math.round(((funnel[i - 1].count - step.count) / funnel[i - 1].count) * 100)
      : 0;
    return `<div class="fn-row">
      <div class="fn-head">
        <span class="fn-name">${esc(step.name)}</span>
        <span class="fn-nums"><span class="fn-count">${step.count}</span><span class="fn-pct">${pct}%</span></span>
      </div>
      <div class="fn-track"><div class="fn-fill" style="width:${width}%"></div></div>
      ${i > 0 && funnel[i-1].count > step.count ? `<div class="fn-drop">↓ ${dropRate}% drop from previous step (${funnel[i-1].count - step.count} sessions)</div>` : ''}
    </div>`;
  }).join('');

  const utmRows = utms.length ? utms.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') : `<tr><td colspan="2" class="empty">No UTM sources yet.</td></tr>`;
  const refRows = refs.length ? refs.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') : `<tr><td colspan="2" class="empty">No external referrers yet.</td></tr>`;
  const countryRows = countries.length ? countries.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="num">${v}</td></tr>`).join('') : `<tr><td colspan="2" class="empty">No country data yet.</td></tr>`;

  const linkedinRows = linkedins.length ? linkedins.map(item => `
    <tr>
      <td class="mono">${esc(item.linkedin)}</td>
      <td class="num">${item.count}</td>
      <td>${item.completed ? '<span class="ok">✓ done</span>' : '<span class="muted">—</span>'}</td>
      <td>${item.checkout ? '<span class="ok">✓ checkout</span>' : '<span class="muted">—</span>'}</td>
      <td>${item.recipe ? '<span class="ok">✓ recipe</span>' : '<span class="muted">—</span>'}</td>
      <td class="small">${esc(new Date(item.lastSeen).toISOString().slice(0, 16).replace('T', ' '))}</td>
    </tr>
  `).join('') : `<tr><td colspan="6" class="empty">No audits submitted yet in this window.</td></tr>`;

  return `<!doctype html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Roast · Admin stats (${days}d)</title>
<meta name="robots" content="noindex, nofollow">
<style>
  :root { --bg:#17130F; --ink:#080605; --fg:#F1EBDF; --fg-dim:rgba(241,235,223,.68); --fg-faint:rgba(241,235,223,.42); --amber:#D4A574; --ok:#4A7C59; --err:#E0492B; }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Helvetica,Arial,sans-serif;line-height:1.5;-webkit-font-smoothing:antialiased;letter-spacing:-.01em;padding:32px 20px 80px}
  .wrap{max-width:1080px;margin:0 auto}
  h1{font-size:36px;font-weight:900;letter-spacing:-.03em;margin-bottom:6px}
  .sub{color:var(--fg-dim);font-size:14px;margin-bottom:32px}
  .range{display:inline-flex;gap:6px;margin-bottom:32px}
  .range a{padding:8px 14px;background:transparent;border:1px solid rgba(241,235,223,.14);color:var(--fg-dim);text-decoration:none;font-family:ui-monospace,monospace;font-size:11px;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
  .range a.active{background:var(--amber);color:var(--ink);border-color:var(--amber)}
  .kpi-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:44px}
  .kpi{padding:18px 20px;background:rgba(212,165,116,.06);border:1px solid rgba(212,165,116,.24)}
  .kpi-label{font-family:ui-monospace,monospace;font-size:10px;font-weight:800;letter-spacing:.22em;text-transform:uppercase;color:var(--amber);margin-bottom:6px}
  .kpi-value{font-size:32px;font-weight:900;letter-spacing:-.03em}
  .kpi-sub{font-size:11px;color:var(--fg-faint);margin-top:2px;font-family:ui-monospace,monospace;letter-spacing:.06em}
  section{margin-bottom:52px}
  h2{font-size:18px;font-weight:800;letter-spacing:-.01em;margin-bottom:16px;padding-bottom:10px;border-bottom:1px solid rgba(241,235,223,.14)}
  .fn-row{margin-bottom:18px}
  .fn-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:6px}
  .fn-name{font-size:14px;font-weight:700}
  .fn-nums{display:flex;gap:12px;align-items:baseline}
  .fn-count{font-family:ui-monospace,monospace;font-weight:900;font-size:18px;color:var(--amber)}
  .fn-pct{font-family:ui-monospace,monospace;font-size:11px;color:var(--fg-faint);letter-spacing:.1em}
  .fn-track{height:8px;background:rgba(241,235,223,.05);position:relative;overflow:hidden}
  .fn-fill{position:absolute;top:0;left:0;bottom:0;background:linear-gradient(90deg,var(--amber),#E4B98A);transition:width .5s ease}
  .fn-drop{font-family:ui-monospace,monospace;font-size:10px;color:var(--err);letter-spacing:.08em;margin-top:6px;padding-left:8px}
  .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:24px}
  @media (max-width:700px){.grid-2{grid-template-columns:1fr}}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid rgba(241,235,223,.08)}
  th{font-family:ui-monospace,monospace;font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase;color:var(--fg-faint)}
  td.num{text-align:right;font-family:ui-monospace,monospace;color:var(--amber);font-weight:800}
  td.mono{font-family:ui-monospace,monospace;font-size:12px}
  td.small{font-family:ui-monospace,monospace;font-size:11px;color:var(--fg-faint)}
  td.empty{color:var(--fg-faint);font-style:italic}
  .ok{color:var(--ok);font-family:ui-monospace,monospace;font-size:11px;font-weight:800;letter-spacing:.06em}
  .muted{color:var(--fg-faint);font-family:ui-monospace,monospace;font-size:11px}
  a{color:var(--amber)}
  .refresh{font-family:ui-monospace,monospace;font-size:11px;color:var(--fg-faint);letter-spacing:.1em;margin-left:12px}
</style>
</head><body>
<div class="wrap">
  <h1>Roast · Admin stats</h1>
  <div class="sub">Owner-only. Data window: last ${days} day${days === 1 ? '' : 's'} · rendered ${esc(new Date().toISOString().slice(0, 19).replace('T', ' '))}Z</div>

  <div class="range">
    <a href="?token=${encodeURIComponent(process.env.TEST_PAYMENT_TOKEN)}&days=1"  class="${days === 1 ? 'active' : ''}">1d</a>
    <a href="?token=${encodeURIComponent(process.env.TEST_PAYMENT_TOKEN)}&days=7"  class="${days === 7 ? 'active' : ''}">7d</a>
    <a href="?token=${encodeURIComponent(process.env.TEST_PAYMENT_TOKEN)}&days=30" class="${days === 30 ? 'active' : ''}">30d</a>
    <a href="?token=${encodeURIComponent(process.env.TEST_PAYMENT_TOKEN)}&days=90" class="${days === 90 ? 'active' : ''}">90d</a>
  </div>

  <div class="kpi-row">
    <div class="kpi"><div class="kpi-label">Sessions</div><div class="kpi-value">${kpis.sessions}</div><div class="kpi-sub">unique tabs</div></div>
    <div class="kpi"><div class="kpi-label">Page views</div><div class="kpi-value">${kpis.pageviews}</div></div>
    <div class="kpi"><div class="kpi-label">Audits submitted</div><div class="kpi-value">${kpis.submits}</div></div>
    <div class="kpi"><div class="kpi-label">Reports served</div><div class="kpi-value">${kpis.completed}</div><div class="kpi-sub">${kpis.submits ? Math.round((kpis.completed/kpis.submits)*100) : 0}% completion</div></div>
    <div class="kpi"><div class="kpi-label">Checkout clicks</div><div class="kpi-value">${kpis.checkouts}</div></div>
    <div class="kpi"><div class="kpi-label">Purchases</div><div class="kpi-value">${kpis.purchases}</div><div class="kpi-sub">${kpis.checkouts ? Math.round((kpis.purchases/kpis.checkouts)*100) : 0}% close rate</div></div>
    <div class="kpi"><div class="kpi-label">PDF downloads</div><div class="kpi-value">${kpis.downloads}</div></div>
    <div class="kpi"><div class="kpi-label">Avg time / page</div><div class="kpi-value">${kpis.avgTimeSec}s</div></div>
  </div>

  <section>
    <h2>Funnel · from landing to PDF download</h2>
    ${funnelRows}
  </section>

  <section>
    <h2>Audited LinkedIn profiles</h2>
    <table>
      <thead><tr><th>LinkedIn (URL / username)</th><th>Submits</th><th>Completed</th><th>Checkout</th><th>Recipe</th><th>Last</th></tr></thead>
      <tbody>${linkedinRows}</tbody>
    </table>
  </section>

  <div class="grid-2">
    <section>
      <h2>Top UTM sources</h2>
      <table>
        <thead><tr><th>Source · medium · campaign</th><th>Sessions</th></tr></thead>
        <tbody>${utmRows}</tbody>
      </table>
    </section>

    <section>
      <h2>Top referrers</h2>
      <table>
        <thead><tr><th>Referrer host</th><th>Sessions</th></tr></thead>
        <tbody>${refRows}</tbody>
      </table>
    </section>
  </div>

  <section>
    <h2>Countries (coarse, from edge geolocation)</h2>
    <table>
      <thead><tr><th>Country code</th><th>Sessions</th></tr></thead>
      <tbody>${countryRows}</tbody>
    </table>
  </section>
</div>
</body></html>`;
}

// ------- handler -------
export const handler = async (event) => {
  connectLambda(event);

  const expected = process.env.TEST_PAYMENT_TOKEN;
  const token = String(event.queryStringParameters?.token || '');
  if (!expected || token !== expected) {
    return { statusCode: 403, body: 'Forbidden' };
  }

  let days = parseInt(event.queryStringParameters?.days, 10);
  if (!Number.isFinite(days) || days < 1 || days > 90) days = 7;

  const events = await loadEventsRange(days);
  const sessions = buildSessions(events);
  const funnel = buildFunnel(sessions);

  // KPIs
  const kpis = {
    sessions: sessions.size,
    pageviews: events.filter(e => e.type === 'page_view').length,
    submits: events.filter(e => e.type === 'audit_submit').length,
    completed: events.filter(e => e.type === 'audit_completed').length,
    checkouts: events.filter(e => e.type === 'checkout_click').length,
    purchases: events.filter(e => e.type === 'success_view').length,
    downloads: events.filter(e => e.type === 'pdf_download').length,
    avgTimeSec: (() => {
      const times = events.filter(e => e.type === 'time_on_page' && Number(e.ms) > 0).map(e => Number(e.ms));
      if (!times.length) return 0;
      return Math.round(times.reduce((a, b) => a + b, 0) / times.length / 1000);
    })(),
  };

  // UTM aggregation — key by "source · medium · campaign" tuple.
  const utmMap = new Map();
  const refMap = new Map();
  const countryMap = new Map();
  for (const s of sessions.values()) {
    const u = s.utm || {};
    if (u.utm_source || u.utm_medium || u.utm_campaign) {
      const k = [u.utm_source || '-', u.utm_medium || '-', u.utm_campaign || '-'].join(' · ');
      utmMap.set(k, (utmMap.get(k) || 0) + 1);
    }
    if (s.ref) {
      try {
        const host = new URL(s.ref).host;
        if (host && !host.includes('roastmylinkedin.net')) {
          refMap.set(host, (refMap.get(host) || 0) + 1);
        }
      } catch { /* skip malformed ref */ }
    }
    if (s.country) countryMap.set(s.country, (countryMap.get(s.country) || 0) + 1);
  }

  // LinkedIn URLs — grouped by the actual submitted string, with progression flags.
  const linkedinMap = new Map();
  for (const e of events) {
    if (e.type === 'audit_submit' && e.linkedin) {
      const key = String(e.linkedin);
      if (!linkedinMap.has(key)) {
        linkedinMap.set(key, {
          linkedin: key,
          count: 0,
          completed: false,
          checkout: false,
          recipe: false,
          lastSeen: e.at,
          sessionIds: new Set(),
        });
      }
      const rec = linkedinMap.get(key);
      rec.count++;
      rec.sessionIds.add(e.sessionId);
      if (e.at > rec.lastSeen) rec.lastSeen = e.at;
    }
  }
  // Second pass: for each linkedin, look at whether ANY session that submitted
  // it also completed/checked out/opened recipe.
  for (const rec of linkedinMap.values()) {
    for (const e of events) {
      if (!rec.sessionIds.has(e.sessionId)) continue;
      if (e.type === 'audit_completed') rec.completed = true;
      if (e.type === 'checkout_click' || e.type === 'sim_payment_click') rec.checkout = true;
      if (e.type === 'recipe_view') rec.recipe = true;
    }
  }
  const linkedins = [...linkedinMap.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 60);

  const html = renderPage({
    days,
    events,
    sessions,
    funnel,
    kpis,
    utms: topN(utmMap, 15),
    refs: topN(refMap, 15),
    countries: topN(countryMap, 15),
    linkedins,
  });

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'private, no-store',
      'X-Robots-Tag': 'noindex, nofollow',
    },
    body: html,
  };
};
