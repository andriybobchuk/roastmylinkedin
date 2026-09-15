// POST /simulate-payment  — dev-only endpoint that fakes a paid checkout so
// the owner can test the full post-payment pipeline (recipe generation,
// success-page polling, /recipe/[token] rendering, delivery email) without
// a real Stripe charge.
//
// Body: { jobId: string, token: string, sendTo?: string }
//   - jobId  = the audit job whose profile+audit should feed the recipe
//   - token  = must match process.env.TEST_PAYMENT_TOKEN, else 403
//   - sendTo = optional destination for the delivery email; defaults to
//              process.env.SIM_EMAIL_TO || 'andriybobchuk@gmail.com'
//
// Response: { sessionId: "test_...", recipeToken, ready, emailSent, emailError }
//   Frontend then redirects to /success.html?session_id=<sessionId>.

import { connectLambda, getStore } from '@netlify/blobs';
import { runRecipeStage } from '../../lib/audit.mjs';

// Even though this endpoint is token-gated, rate-limit per IP as belt-and-
// suspenders — if the token ever leaks, one IP still can't burn through
// the LLM budget faster than 10/hr.
const SIM_RATE_WINDOW_MS = 60 * 60 * 1000;
const SIM_RATE_LIMIT_PER_IP = 10;

function extractClientIp(event) {
  const h = event.headers || {};
  const raw = h['x-nf-client-connection-ip']
    || h['X-Nf-Client-Connection-Ip']
    || (h['x-forwarded-for'] || h['X-Forwarded-For'] || '').split(',')[0]
    || h['client-ip']
    || '';
  return String(raw).trim() || null;
}

async function checkSimRateLimit(ip) {
  if (!ip) return { allowed: true };
  const store = getStore('rate-limits');
  const key = `sim:${ip}`;
  const now = Date.now();
  let state;
  try { state = await store.get(key, { type: 'json' }); }
  catch { return { allowed: true }; }
  if (!state || !state.resetAt || state.resetAt < now) {
    await store.setJSON(key, { count: 1, resetAt: now + SIM_RATE_WINDOW_MS });
    return { allowed: true };
  }
  if (state.count >= SIM_RATE_LIMIT_PER_IP) return { allowed: false, resetAt: state.resetAt };
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

  const expected = process.env.TEST_PAYMENT_TOKEN;
  if (!expected) return { statusCode: 503, body: 'Simulate disabled: TEST_PAYMENT_TOKEN not set' };
  if (String(body.token || '') !== expected) return { statusCode: 403, body: 'Bad token' };

  const rate = await checkSimRateLimit(extractClientIp(event));
  if (!rate.allowed) return { statusCode: 429, body: 'Rate limited (dev): 10/hour per IP.' };

  const jobId = String(body.jobId || '').trim();
  if (!jobId) return { statusCode: 400, body: 'Missing jobId' };

  const jobs = getStore('audit-jobs');
  const recipes = getStore('recipes');

  const audit = await jobs.get(jobId, { type: 'json' });
  if (!audit?.profile || !audit?.audit) {
    return { statusCode: 404, body: 'Audit not found or incomplete for that jobId' };
  }
  if (audit.expiresAt && Date.now() > audit.expiresAt) {
    return { statusCode: 410, body: 'Audit expired (7-day TTL). Run a fresh audit first.' };
  }

  // Fabricate a session id shaped like Stripe's real ones so the same
  // reverse-lookup regex in /session-recipe accepts it.
  const sessionId = `cs_test_sim${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}${Math.random().toString(36).slice(2, 14)}`;

  const recipeOpts = {
    anthropicKey: process.env.ANTHROPIC_API_KEY,
    geminiKey: process.env.GEMINI_API_KEY,
    groqKey: process.env.GROQ_API_KEY,
    claudeModel: process.env.CLAUDE_MODEL,
    geminiModel: process.env.GEMINI_MODEL,
    groqModel: process.env.GROQ_MODEL,
  };
  let recipe = null;
  let recipeError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      recipe = await runRecipeStage(audit.profile, audit.audit, '', recipeOpts);
      break;
    } catch (err) {
      recipeError = err.message;
      console.error(`[simulate-payment] recipe attempt ${attempt} failed:`, err.message);
      if (attempt < 2) await new Promise(r => setTimeout(r, 5000));
    }
  }

  const recipeToken = randomToken();
  const sendTo = String(body.sendTo || process.env.SIM_EMAIL_TO || 'andriybobchuk@gmail.com').trim();
  const record = {
    token: recipeToken,
    createdAt: Date.now(),
    email: sendTo,
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

  // Send the delivery email so the sim exercises the same path a real
  // Stripe checkout does.
  const link = `https://roastmylinkedin.net/recipe/${recipeToken}`;
  let emailSent = false;
  let emailError = null;
  try {
    await sendResendEmail({
      to: sendTo,
      subject: '[SIM] Your Recipe is ready.',
      html: buildRecipeEmail(link, audit.profile?.fullname, !!recipe),
    });
    emailSent = true;
  } catch (err) {
    emailError = err.message;
    console.error('[simulate-payment] email failed:', err.message);
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ sessionId, recipeToken, ready: !!recipe, emailSent, emailError }),
  };
};

async function sendResendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not configured');
  const from = process.env.RESEND_FROM || 'Roast My LinkedIn <onboarding@resend.dev>';
  const replyTo = process.env.RESEND_REPLY_TO || 'andriybobchuk@gmail.com';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from, to: [to], reply_to: replyTo, subject, html }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Resend ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

function buildRecipeEmail(link, name, recipeReady) {
  const firstName = (name || '').split(' ')[0] || 'there';
  const bodyIfReady = `<p>Your extended Recipe is generated and waiting. Every experience bullet rewritten. Five Featured post drafts. Recommendation-request templates. Skills gap breakdown. Cover letter template.</p>`;
  const bodyIfPending = `<p>We're finishing your extended Recipe now — it usually takes a few minutes. Refresh the link in a bit and it'll be there.</p>`;
  return `<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#080605;background:#F1EBDF;margin:0;padding:0">
  <div style="max-width:560px;margin:40px auto;padding:32px 24px;background:#FFFFFF;">
    <h1 style="font-size:28px;letter-spacing:-0.02em;margin:0 0 12px">Your Recipe is ready, ${firstName}.</h1>
    <p style="font-size:15px;line-height:1.6;color:#333">Thanks for backing this. Your extended audit lives at the private URL below and stays there forever — bookmark it.</p>
    ${recipeReady ? bodyIfReady : bodyIfPending}
    <p style="margin:28px 0">
      <a href="${link}" style="display:inline-block;background:#17130F;color:#F1EBDF;padding:14px 22px;text-decoration:none;font-weight:800;letter-spacing:-0.005em">Open your Recipe →</a>
    </p>
    <p style="font-size:13px;color:#666;line-height:1.5">
      Direct URL: <a href="${link}" style="color:#D4A574">${link}</a><br>
      Lost this email? Reply to it — I'll resend.
    </p>
    <hr style="border:none;border-top:1px solid #e8e0cf;margin:28px 0">
    <p style="font-size:12px;color:#8A7F6E">Roast My LinkedIn is operated by Andrii Bobchuk, Warsaw, Poland. Not affiliated with LinkedIn Corporation.</p>
  </div>
</body></html>`;
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 30);
}
