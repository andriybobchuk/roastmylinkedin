// POST /track — analytics event ingest.
//
// Client script (/track.js) fires JSON POST payloads:
//   { sessionId, type, at, path, ref, vp, ua, utm, ...eventProps }
//
// One blob per event under `analytics` store, key:
//   events/<YYYY-MM-DD>/<HHMMSS.mmm>-<sessionId>-<type>-<rand>
//
// This lets the admin dashboard list a date range via prefix + read each
// event. Small-scale friendly; if we ever cross ~5k events/day we can add
// a nightly rollup.

import { connectLambda, getStore } from '@netlify/blobs';

// Per-IP rate limit: 300 events/hour is generous for even chatty pages
// while still stopping a bad actor from filling the store.
const RATE_WINDOW_MS = 60 * 60 * 1000;
const RATE_LIMIT_PER_IP = 300;

function extractClientIp(event) {
  const h = event.headers || {};
  const raw = h['x-nf-client-connection-ip']
    || h['X-Nf-Client-Connection-Ip']
    || (h['x-forwarded-for'] || h['X-Forwarded-For'] || '').split(',')[0]
    || h['client-ip']
    || '';
  return String(raw).trim() || null;
}

async function rateLimit(ip) {
  if (!ip) return true;
  const store = getStore('rate-limits');
  const key = `track:${ip}`;
  const now = Date.now();
  let state;
  try { state = await store.get(key, { type: 'json' }); } catch { return true; }
  if (!state || !state.resetAt || state.resetAt < now) {
    await store.setJSON(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return true;
  }
  if (state.count >= RATE_LIMIT_PER_IP) return false;
  await store.setJSON(key, { count: state.count + 1, resetAt: state.resetAt });
  return true;
}

// Coarse country from Netlify's edge geo header (JSON blob).
function parseGeo(headers) {
  try {
    const raw = headers['x-nf-geo'] || headers['X-Nf-Geo'];
    if (!raw) return null;
    const j = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return { country: j.country?.code || null, city: j.city || null };
  } catch { return null; }
}

// Redact last octet of IPv4 for GDPR-friendliness (still lets us see rough
// distinct-visitor buckets without storing PII).
function coarseIp(ip) {
  if (!ip) return null;
  return ip.replace(/\.\d+$/, '.x').replace(/:[0-9a-f]{1,4}$/i, ':x');
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  connectLambda(event);

  const ip = extractClientIp(event);
  if (!(await rateLimit(ip))) {
    return { statusCode: 429, body: 'rate-limited' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Bad JSON' }; }

  if (!body.type || typeof body.type !== 'string' || body.type.length > 40) {
    return { statusCode: 400, body: 'Bad event type' };
  }
  if (!body.sessionId || typeof body.sessionId !== 'string' || body.sessionId.length > 60) {
    return { statusCode: 400, body: 'Bad session id' };
  }

  const at = Number(body.at) || Date.now();
  const geo = parseGeo(event.headers || {});
  const enriched = {
    ...body,
    at,
    serverAt: Date.now(),
    ip: coarseIp(ip),
    country: geo?.country || null,
    city: geo?.city || null,
  };

  // Trim payload — belt and suspenders against oversized events.
  if (JSON.stringify(enriched).length > 6000) {
    return { statusCode: 413, body: 'Event too large' };
  }

  const d = new Date(at);
  const day = d.toISOString().slice(0, 10);
  const time = d.toISOString().slice(11, 23).replace(/[:.]/g, '');
  const rand = Math.random().toString(36).slice(2, 8);
  const key = `events/${day}/${time}-${body.sessionId}-${body.type}-${rand}`;

  try {
    await getStore('analytics').setJSON(key, enriched);
  } catch (err) {
    console.error('[track] write failed:', err.message);
    return { statusCode: 500, body: 'write-failed' };
  }

  return { statusCode: 204, body: '' };
};
