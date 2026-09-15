// POST /simulate-payment  — dev-only endpoint that fakes a paid checkout so
// the owner can test the full post-payment pipeline (recipe generation,
// success-page polling, /recipe/[token] rendering) without a real Stripe
// charge.
//
// Body: { jobId: string, token: string }
//   - jobId  = the audit job whose profile+audit should feed the recipe
//   - token  = must match process.env.TEST_PAYMENT_TOKEN, else 403
//
// Response: { sessionId: "test_...", recipeToken, ready }
//   Frontend then redirects to /success.html?session_id=<sessionId>.

import { connectLambda, getStore } from '@netlify/blobs';
import { runRecipeStage } from '../../lib/audit.mjs';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  connectLambda(event);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  const expected = process.env.TEST_PAYMENT_TOKEN;
  if (!expected) return { statusCode: 503, body: 'Simulate disabled: TEST_PAYMENT_TOKEN not set' };
  if (String(body.token || '') !== expected) return { statusCode: 403, body: 'Bad token' };

  const jobId = String(body.jobId || '').trim();
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const jobs = getStore('audit-jobs');
  const recipes = getStore('recipes');

  const audit = await jobs.get(jobId, { type: 'json' });
  if (!audit?.profile || !audit?.audit) {
    return { statusCode: 404, body: 'Audit not found or incomplete for that jobId' };
  }

  // Fabricate a session id shaped like Stripe's real ones so the same
  // reverse-lookup regex in /session-recipe accepts it.
  const sessionId = `cs_test_sim${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`;

  let recipe = null;
  let recipeError = null;
  try {
    recipe = await runRecipeStage(audit.profile, audit.audit, '', {
      anthropicKey: process.env.ANTHROPIC_API_KEY,
      geminiKey: process.env.GEMINI_API_KEY,
      groqKey: process.env.GROQ_API_KEY,
      claudeModel: process.env.CLAUDE_MODEL,
      geminiModel: process.env.GEMINI_MODEL,
      groqModel: process.env.GROQ_MODEL,
    });
  } catch (err) {
    recipeError = err.message;
    console.error('[simulate-payment] recipe generation failed:', err.message);
  }

  const recipeToken = randomToken();
  const record = {
    token: recipeToken,
    createdAt: Date.now(),
    email: 'test@simulated.local',
    stripeSessionId: sessionId,
    amountPaid: 0,
    currency: 'pln',
    jobId,
    profile: audit.profile,
    audit: audit.audit,
    recipe,
    recipeError,
    simulated: true,
  };
  await recipes.setJSON(recipeToken, record);
  await recipes.setJSON(`by-session:${sessionId}`, {
    token: recipeToken,
    ready: !!recipe,
    createdAt: Date.now(),
  });

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ sessionId, recipeToken, ready: !!recipe }),
  };
};

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 30);
}
