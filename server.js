// Local dev server. On Netlify, static files are served automatically
// and /analyze routes to netlify/functions/analyze.mjs.
//
// Env vars:
//   APIFY_TOKEN         required
//   ANTHROPIC_API_KEY   optional. Preferred if set.
//   GEMINI_API_KEY      optional. Free tier at aistudio.google.com
//   PORT                default 3000
//
// Run:
//   APIFY_TOKEN=xxx GEMINI_API_KEY=AIza... node server.js

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAudit, parseUsername } from './lib/audit.mjs';

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
  console.error('Missing LLM key. Set either:');
  console.error('  GEMINI_API_KEY    (free tier: https://aistudio.google.com/app/apikey)');
  console.error('  ANTHROPIC_API_KEY (paid: https://console.anthropic.com/settings/keys)');
  process.exit(1);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
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

async function handleAnalyze(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return sendJson(res, 400, { error: 'Invalid JSON body' }); }

  const username = parseUsername(body.username);
  const targetRole = String(body.targetRole || '').trim();
  if (!username) return sendJson(res, 400, { error: 'Invalid LinkedIn username or URL' });

  try {
    console.log(`[analyze] ${username}`);
    const result = await runAudit({
      username,
      targetRole,
      apifyToken: APIFY_TOKEN,
      anthropicKey: ANTHROPIC_API_KEY,
      geminiKey: GEMINI_API_KEY,
      claudeModel: CLAUDE_MODEL,
      geminiModel: GEMINI_MODEL,
    });
    console.log(`[analyze] ${result.provider}: scrape=${result.timing_ms.scrape}ms llm=${result.timing_ms.llm}ms total=${result.timing_ms.total}ms score=${result.audit.score}`);
    sendJson(res, 200, result);
  } catch (err) {
    console.error('[analyze] error:', err.message);
    sendJson(res, 500, { error: err.message });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'GET' && url.pathname === '/')          return serveStatic(res, 'index.html',     'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/terms')     return serveStatic(res, 'terms.html',     'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/privacy')   return serveStatic(res, 'privacy.html',   'text/html; charset=utf-8');
  if (req.method === 'GET' && url.pathname === '/wireframe') return serveStatic(res, 'wireframe.html', 'text/html; charset=utf-8');
  if (req.method === 'POST' && url.pathname === '/analyze')  return handleAnalyze(req, res);

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  const model = PROVIDER === 'anthropic' ? CLAUDE_MODEL : GEMINI_MODEL;
  console.log(`Roast My LinkedIn (dev) at http://localhost:${PORT}`);
  console.log(`Provider: ${PROVIDER} · Model: ${model}`);
});
