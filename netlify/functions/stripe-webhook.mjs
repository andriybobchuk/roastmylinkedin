// Stripe webhook — fulfills The Recipe after payment.
//
// Flow:
//   1. Verify Stripe signature
//   2. On checkout.session.completed, read the client_reference_id
//      (which the frontend set to the audit jobId)
//   3. Fetch the original audit from Blobs
//   4. Run the Recipe generation stage (LLM) to produce the extended content
//   5. Store the full record in a *permanent* Blobs store under a random token
//   6. Email the customer their /recipe/<token> permanent link (via Resend)
//
// Env vars required:
//   STRIPE_SECRET_KEY        Stripe API secret (sk_live_… or sk_test_…)
//   STRIPE_WEBHOOK_SECRET    Signing secret from the webhook endpoint
//   RESEND_API_KEY           For sending the delivery email
//   APIFY_TOKEN              (already set; only needed if we re-fetch)
//   GROQ_API_KEY, GEMINI_API_KEY, or ANTHROPIC_API_KEY   For the LLM stage

import Stripe from 'stripe';
import { connectLambda, getStore } from '@netlify/blobs';
import { runRecipeStage } from '../../lib/audit.mjs';

const SITE_URL = 'https://roastmylinkedin.net';

export const handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2024-06-20' });
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];

  // The raw body is required to verify the signature. Netlify passes
  // isBase64Encoded=true for binary bodies; we decode if needed.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] signature failed:', err.message);
    return { statusCode: 400, body: `Signature verification failed: ${err.message}` };
  }

  // We only care about completed checkouts. Ack everything else so
  // Stripe doesn't retry.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: `ignored: ${stripeEvent.type}` };
  }

  connectLambda(event);

  const session = stripeEvent.data.object;
  const jobId = session.client_reference_id || null;
  const email = session.customer_details?.email || session.customer_email || null;
  const amount = (session.amount_total ?? 0) / 100;

  console.log(`[webhook] checkout.session.completed  session=${session.id}  jobId=${jobId}  email=${email}  amount=${amount}`);

  if (!email) {
    console.error('[webhook] no customer email — cannot deliver Recipe');
    return { statusCode: 200, body: 'no-email' };
  }

  const jobs = getStore('audit-jobs');
  const recipes = getStore('recipes');

  // 1) Try to fetch the original audit by jobId
  let audit = null;
  if (jobId) {
    try { audit = await jobs.get(jobId, { type: 'json' }); }
    catch (e) { console.warn('[webhook] failed to fetch audit:', e.message); }
  }

  // 2) Generate the extended Recipe content, if we have the raw audit
  let recipe = null;
  let recipeError = null;
  if (audit?.profile && audit?.audit) {
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
      console.error('[webhook] recipe generation failed:', err.message);
    }
  } else {
    console.warn('[webhook] audit not found or expired — sending fallback email');
  }

  // 3) Persist the record forever, keyed by unguessable token
  const token = randomToken();
  const record = {
    token,
    createdAt: Date.now(),
    email,
    stripeSessionId: session.id,
    amountPaid: amount,
    currency: session.currency || 'pln',
    jobId,
    profile: audit?.profile || null,
    audit: audit?.audit || null,
    recipe,
    recipeError,
  };
  try {
    await recipes.setJSON(token, record);
    // Reverse-lookup entry: success.html reads ?session_id={CHECKOUT_SESSION_ID}
    // from the URL and polls /session-recipe to get the token as soon as this
    // webhook finishes. Avoids emailing the customer if the tab is still open.
    await recipes.setJSON(`by-session:${session.id}`, { token, ready: !!recipe, createdAt: Date.now() });
  } catch (err) {
    console.error('[webhook] failed to persist recipe:', err.message);
    return { statusCode: 500, body: 'persistence-failed' };
  }

  // 4) Email the customer their permanent link
  const link = `${SITE_URL}/recipe/${token}`;
  try {
    await sendResendEmail({
      to: email,
      subject: 'Your Recipe is ready.',
      html: buildRecipeEmail(link, audit?.profile?.fullname, !!recipe),
    });
  } catch (err) {
    console.error('[webhook] email failed:', err.message);
    // Don't 500 — we already have the record; user can email support if the
    // notification bounced. Return 200 so Stripe stops retrying.
  }

  return { statusCode: 200, body: 'ok' };
};

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function randomToken() {
  // 30-char base36 token (~150 bits of entropy) — unguessable, URL-safe.
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, b => b.toString(36).padStart(2, '0')).join('').slice(0, 30);
}

async function sendResendEmail({ to, subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('RESEND_API_KEY not configured');
  // Default to Resend's shared verified domain so emails send even before
  // roastmylinkedin.net DKIM/SPF are set up. Once the domain is verified in
  // Resend, set RESEND_FROM=Andrii @ Roast My LinkedIn <hello@roastmylinkedin.net>
  // in Netlify env vars and the branded sender takes over automatically.
  const from = process.env.RESEND_FROM || 'Roast My LinkedIn <onboarding@resend.dev>';
  const replyTo = process.env.RESEND_REPLY_TO || 'andriybobchuk@gmail.com';
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: replyTo,
      subject,
      html,
    }),
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
  const bodyIfPending = `<p>We're finishing your extended Recipe now — it usually takes a few minutes. Refresh the link in a bit and it'll be there. If it's not ready after 30 minutes, hit reply and I'll fix it manually.</p>`;
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
    <p style="font-size:12px;color:#8A7F6E">
      Roast My LinkedIn is operated by Andrii Bobchuk, Warsaw, Poland.
      Not affiliated with LinkedIn Corporation.
    </p>
  </div>
</body></html>`;
}
