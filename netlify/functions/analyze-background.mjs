// Background Netlify Function: POST /.netlify/functions/analyze-background
//
// Two-stage audit — after Apify scrape, kicks off fast (findings) + deep
// (rewrites) Gemini calls in parallel. Writes intermediate Blobs state as
// each stage finishes so the client can render progressively.
//
// State machine (written to Blobs under jobId):
//   { status: "pending" }                     — right after invocation
//   { status: "scrape_done", profile }        — after Apify (~5s)
//   { status: "fast_done", profile, audit }   — after fast Gemini call (~10-12s)
//   { status: "done", profile, audit, timing_ms, provider }   — full result
//   { status: "error", error }                — on any failure

import { connectLambda, getStore } from '@netlify/blobs';
import {
  fetchProfile,
  runFastStage,
  runRewritesStage,
  projectProfile,
  parseUsername,
} from '../../lib/audit.mjs';

// ------------------------------------------------------------------
// Rate limit helpers
// ------------------------------------------------------------------
const RATE_WINDOW_MS = 60 * 60 * 1000;  // 1 hour
const RATE_LIMIT_PER_IP = 5;             // audits per window per IP

function extractClientIp(event) {
  const h = event.headers || {};
  // Netlify's canonical header first, then the standard proxy chain.
  const raw = h['x-nf-client-connection-ip']
    || h['X-Nf-Client-Connection-Ip']
    || (h['x-forwarded-for'] || h['X-Forwarded-For'] || '').split(',')[0]
    || h['client-ip']
    || '';
  return String(raw).trim() || null;
}

async function checkRateLimit(ip) {
  if (!ip) return { allowed: true };   // unknown IP → don't punish, log elsewhere
  const store = getStore('rate-limits');
  const key = `ip:${ip}`;
  const now = Date.now();
  let state;
  try { state = await store.get(key, { type: 'json' }); }
  catch { return { allowed: true }; }  // storage hiccup → fail open

  if (!state || !state.resetAt || state.resetAt < now) {
    await store.setJSON(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return { allowed: true };
  }
  if (state.count >= RATE_LIMIT_PER_IP) {
    return { allowed: false, resetAt: state.resetAt };
  }
  await store.setJSON(key, { count: state.count + 1, resetAt: state.resetAt });
  return { allowed: true };
}

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const jobId = String(body.jobId || '').trim();
  const username = parseUsername(body.username);
  const targetRole = String(body.targetRole || '').trim();

  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) return { statusCode: 400, body: 'Bad jobId' };
  if (!username) return { statusCode: 400, body: 'Bad username' };

  // ------------------------------------------------------------------
  // Rate limit — protects Apify/LLM spend from a single client burning
  // through our budget. Keyed by client IP. 5 audits per hour per IP.
  // ------------------------------------------------------------------
  const clientIp = extractClientIp(event);
  const rate = await checkRateLimit(clientIp);
  if (!rate.allowed) {
    // Background functions return 202 to the client no matter what, so we
    // signal via Blobs — the client will poll analyze-status and see the
    // rate-limit message.
    await getStore('audit-jobs').setJSON(jobId, {
      status: 'error',
      error: 'RATE_LIMITED: Too many audits from your network in the last hour. Please try again later.',
      completedAt: Date.now(),
    });
    return { statusCode: 200, body: 'rate-limited' };
  }

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const GROQ_API_KEY = process.env.GROQ_API_KEY;
  const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
  const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  // Provider label recorded on the finished job. Chain order for fast/rewrites
  // is Groq → Gemini → Anthropic, so label from the first configured one.
  const provider = GROQ_API_KEY ? 'groq' : GEMINI_API_KEY ? 'gemini' : 'anthropic';
  const opts = {
    anthropicKey: ANTHROPIC_API_KEY,
    geminiKey: GEMINI_API_KEY,
    groqKey: GROQ_API_KEY,
    claudeModel: CLAUDE_MODEL,
    geminiModel: GEMINI_MODEL,
    groqModel: GROQ_MODEL,
  };

  const jobs = getStore('audit-jobs');
  const t0 = Date.now();
  await jobs.setJSON(jobId, { status: 'pending', createdAt: t0 });

  try {
    // 1. Scrape profile via Apify
    const rawProfile = await fetchProfile(username, APIFY_TOKEN);
    const profile = projectProfile(rawProfile);
    const tScrape = Date.now() - t0;

    await jobs.setJSON(jobId, {
      status: 'scrape_done',
      profile,
      createdAt: t0,
      timing_ms: { scrape: tScrape },
    });

    // 2. Kick off both Gemini calls in parallel
    const fastPromise = runFastStage(rawProfile, targetRole, opts);
    const rewritesPromise = runRewritesStage(rawProfile, targetRole, opts);

    // Update Blobs as soon as the fast call finishes (usually 6-10s)
    fastPromise.then(async (fast) => {
      try {
        const tFast = Date.now() - t0;
        // Read whatever state is current so we don't clobber a race
        const current = (await jobs.get(jobId, { type: 'json' })) || {};
        if (current.status !== 'done' && current.status !== 'error') {
          await jobs.setJSON(jobId, {
            ...current,
            status: 'fast_done',
            profile,
            audit: { ...fast, rewrites: null },
            timing_ms: { ...(current.timing_ms || {}), scrape: tScrape, fast: tFast },
            provider,
          });
        }
      } catch (e) { /* swallow — will resolve at 'done' anyway */ }
    }).catch(() => { /* deep will bubble too */ });

    // 3. Wait for both
    const [fast, rewrites] = await Promise.all([fastPromise, rewritesPromise]);
    const tTotal = Date.now() - t0;

    await jobs.setJSON(jobId, {
      status: 'done',
      profile,
      audit: { ...fast, rewrites },
      timing_ms: { scrape: tScrape, llm: tTotal - tScrape, total: tTotal },
      provider,
      completedAt: Date.now(),
    });
  } catch (err) {
    await jobs.setJSON(jobId, {
      status: 'error',
      error: err?.message || 'Unknown error',
      completedAt: Date.now(),
    });
  }

  return { statusCode: 200, body: 'ok' };
};
