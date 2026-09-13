// Background Netlify Function: POST /.netlify/functions/analyze-background
//
// Returns 202 immediately (Netlify convention for background functions).
// Runs the audit for up to 15 minutes, writes result to Netlify Blobs.
// Client polls /analyze-status?id=<jobId> to read state.

import { getStore } from '@netlify/blobs';
import { runAudit, parseUsername } from '../../lib/audit.mjs';

const store = () => getStore('audit-jobs');

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const jobId = String(body.jobId || '').trim();
  const username = parseUsername(body.username);
  const targetRole = String(body.targetRole || '').trim();

  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) return { statusCode: 400, body: 'Bad jobId' };
  if (!username) return { statusCode: 400, body: 'Bad username' };

  const jobs = store();

  // Write initial 'pending' state so client polling sees something quickly.
  await jobs.setJSON(jobId, { status: 'pending', createdAt: Date.now() });

  try {
    const result = await runAudit({
      username,
      targetRole,
      apifyToken: process.env.APIFY_TOKEN,
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
      geminiModel: process.env.GEMINI_MODEL || 'gemini-3.6-flash',
    });
    await jobs.setJSON(jobId, { status: 'done', result, completedAt: Date.now() });
  } catch (err) {
    await jobs.setJSON(jobId, {
      status: 'error',
      error: err?.message || 'Unknown error',
      completedAt: Date.now(),
    });
  }

  // Return value is ignored for background functions — client already got 202.
  return { statusCode: 200, body: 'ok' };
};
