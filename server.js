// Local dev server. On Netlify, static files are served automatically
// and /analyze / /analyze-status are handled by Functions.
//
// Endpoints (async job pattern — matches Netlify prod behavior):
//   POST /analyze          { jobId, username, targetRole }  → 202 (kicks off async work)
//   GET  /analyze-status?id=X                                → { status: ..., result?, error? }
//
// Env vars:
//   APIFY_TOKEN         required
//   ANTHROPIC_API_KEY   optional. Preferred if set.
//   GEMINI_API_KEY      optional (free tier: aistudio.google.com)
//   PORT                default 3000
//
// Run:
//   APIFY_TOKEN=xxx GEMINI_API_KEY=AIza... node server.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  fetchProfile,
  runFastStage,
  runRewritesStage,
  projectProfile,
  parseUsername,
} from './lib/audit.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, 'public');

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const APIFY_TOKEN = process.env.APIFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

const PROVIDER = ANTHROPIC_API_KEY ? 'anthropic' : GEMINI_API_KEY ? 'gemini' : null;

if (!APIFY_TOKEN) {
  console.error('Missing APIFY_TOKEN env var.');
  process.exit(1);
}
if (!PROVIDER) {
  console.error('Missing LLM key. Set either GEMINI_API_KEY or ANTHROPIC_API_KEY.');
  process.exit(1);
}

// -----------------------------------------------------------------------------
// In-memory job store (Netlify uses Blobs; this mirrors the same interface).
// Jobs auto-expire after 10 minutes to prevent memory leaks.
// -----------------------------------------------------------------------------
const jobs = new Map();
const JOB_TTL_MS = 10 * 60 * 1000;

function setJob(id, state) {
  jobs.set(id, { ...state, _writtenAt: Date.now() });
}
function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  if (Date.now() - j._writtenAt > JOB_TTL_MS) {
    jobs.delete(id);
    return null;
  }
  const { _writtenAt, ...rest } = j;
  return rest;
}

// -----------------------------------------------------------------------------
// HTTP plumbing
// -----------------------------------------------------------------------------
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
function sendJson(res, status, obj, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(obj));
}
async function serveStatic(res, filename, contentType) {
  try {
    const buf = await readFile(join(PUBLIC_DIR, filename));
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}

// -----------------------------------------------------------------------------
// POST /analyze — start an async audit job. Returns 202 immediately.
// -----------------------------------------------------------------------------
async function handleAnalyzeStart(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }

  const jobId = String(body.jobId || '').trim();
  const username = parseUsername(body.username);
  const targetRole = String(body.targetRole || '').trim();

  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) return sendJson(res, 400, { error: 'Bad jobId' });
  if (!username) return sendJson(res, 400, { error: 'Invalid LinkedIn username or URL' });

  setJob(jobId, { status: 'pending', createdAt: Date.now() });

  // Fire and forget — client polls for result.
  runAuditAsync(jobId, username, targetRole);

  // 202 Accepted matches Netlify background function semantics.
  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ jobId, status: 'pending' }));
}

async function runAuditAsync(jobId, username, targetRole) {
  const t0 = Date.now();
  const provider = ANTHROPIC_API_KEY ? 'anthropic' : 'gemini';
  const opts = {
    anthropicKey: ANTHROPIC_API_KEY,
    geminiKey: GEMINI_API_KEY,
    claudeModel: CLAUDE_MODEL,
    geminiModel: GEMINI_MODEL,
  };
  console.log(`[analyze:start] ${jobId.slice(0, 8)}… ${username}`);
  try {
    const rawProfile = await fetchProfile(username, APIFY_TOKEN);
    const profile = projectProfile(rawProfile);
    const tScrape = Date.now() - t0;
    setJob(jobId, { status: 'scrape_done', profile, createdAt: t0, timing_ms: { scrape: tScrape } });

    const fastPromise = runFastStage(rawProfile, targetRole, opts);
    const rewritesPromise = runRewritesStage(rawProfile, targetRole, opts);

    fastPromise.then(fast => {
      const tFast = Date.now() - t0;
      const current = getJob(jobId) || {};
      if (current.status !== 'done' && current.status !== 'error') {
        setJob(jobId, {
          status: 'fast_done',
          profile,
          audit: { ...fast, rewrites: null },
          timing_ms: { ...(current.timing_ms || {}), scrape: tScrape, fast: tFast },
          provider,
        });
        console.log(`[analyze:fast] ${jobId.slice(0, 8)}… ${tFast}ms score=${fast.score}`);
      }
    }).catch(() => {});

    const [fast, rewrites] = await Promise.all([fastPromise, rewritesPromise]);
    const tTotal = Date.now() - t0;
    setJob(jobId, {
      status: 'done',
      profile,
      audit: { ...fast, rewrites },
      timing_ms: { scrape: tScrape, llm: tTotal - tScrape, total: tTotal },
      provider,
      completedAt: Date.now(),
    });
    console.log(`[analyze:done] ${jobId.slice(0, 8)}… ${tTotal}ms score=${fast.score}`);
  } catch (err) {
    setJob(jobId, { status: 'error', error: err?.message || 'Unknown error', completedAt: Date.now() });
    console.error(`[analyze:err] ${jobId.slice(0, 8)}… ${err?.message}`);
  }
}

// -----------------------------------------------------------------------------
// GET /analyze-status?id=X — poll for job state.
// -----------------------------------------------------------------------------
function handleAnalyzeStatus(req, res, url) {
  const jobId = String(url.searchParams.get('id') || '').trim();
  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
    return sendJson(res, 400, { error: 'Bad jobId' });
  }
  const state = getJob(jobId);
  if (!state) return sendJson(res, 200, { status: 'unknown' }, { 'Cache-Control': 'no-store' });
  return sendJson(res, 200, state, { 'Cache-Control': 'no-store' });
}

// -----------------------------------------------------------------------------
// Router
// -----------------------------------------------------------------------------
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/')                return serveStatic(res, 'index.html',     'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/terms')           return serveStatic(res, 'terms.html',     'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/privacy')         return serveStatic(res, 'privacy.html',   'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/analyze')        return handleAnalyzeStart(req, res);
  if (req.method === 'GET' && url.pathname === '/analyze-status')  return handleAnalyzeStatus(req, res, url);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  const model = PROVIDER === 'anthropic' ? CLAUDE_MODEL : GEMINI_MODEL;
  console.log(`Roast My LinkedIn (dev) at http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER} · Model: ${model} · Mode: async polling`);
});
