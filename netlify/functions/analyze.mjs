// Netlify Function: POST /analyze
// Wraps the shared audit logic in Netlify's handler format.

import { runAudit, parseUsername } from '../../lib/audit.mjs';

export const config = {
  // Netlify Function config. Timeout: default 10s on Free, 26s on Pro.
  // Set generous internal timeouts in audit.mjs (60/90s) so real bottleneck
  // is Netlify's platform limit, not our fetch aborts.
};

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method not allowed' }),
    };
  }

  const APIFY_TOKEN = process.env.APIFY_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

  if (!APIFY_TOKEN) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'APIFY_TOKEN not configured' }),
    };
  }
  if (!ANTHROPIC_API_KEY && !GEMINI_API_KEY) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'No LLM key configured (set ANTHROPIC_API_KEY or GEMINI_API_KEY)' }),
    };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) }; }

  const username = parseUsername(body.username);
  const targetRole = String(body.targetRole || '').trim();

  if (!username) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Invalid LinkedIn username or URL' }),
    };
  }

  try {
    const result = await runAudit({
      username,
      targetRole,
      apifyToken: APIFY_TOKEN,
      anthropicKey: ANTHROPIC_API_KEY,
      geminiKey: GEMINI_API_KEY,
      claudeModel: CLAUDE_MODEL,
      geminiModel: GEMINI_MODEL,
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
