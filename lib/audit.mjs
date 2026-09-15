// Shared audit logic: fetch profile from Apify, run LLM roast.
// Split into TWO parallel stages so the client can render the verdict at ~8s
// while the rewrites finish cooking in the background.

// ------------------------------------------------------------------
// Voice/tone system prompt — shared by both stages.
// ------------------------------------------------------------------
export const SYSTEM_PROMPT = `You are a sharp tech recruiter roasting a LinkedIn profile. Voice: witty, sarcastic-when-warranted, specific, useful. Mock buzzwords/cliches — not the person. Reference their real companies, tech, and numbers.

Output valid JSON only. No preamble, no code fences.

Score honestly: 80-95 strong senior, 60-79 solid mid, 40-59 weak, under 40 broken.

Voice rules:
- Titles: 4-8 punchy words, quotable.
- Descriptions: 1 sharp observation + 1 concrete fix. Under 40 words.
- Rewrites reference real data. No invented numbers. No AI slop.`;

// ------------------------------------------------------------------
// STAGE 1 (fast) prompt — just the verdict layer: score, benchmark, summary, findings.
// Target: 4-8s round trip.
// ------------------------------------------------------------------
export function buildFastPrompt(profile, targetRole) {
  return `Analyze for target role: ${targetRole || 'auto-detect from profile'}. Return JSON:

{
  "score": <int 0-100>,
  "role_detected": "<engineering discipline>",
  "summary": "<2 memorable sentences>",
  "benchmark": { "percentile": "<top X% or bottom X%>", "reasoning": "<one sentence>" },
  "findings": [
    { "section": "<Headline|About|Experience|Skills|Featured|Activity|Recommendations>", "severity": "<good|warn|bad>", "title": "<4-8 word title>", "description": "<max 40 words>", "impact_points": <int> }
  ]
}

Rules: 3-5 findings total, 1 good, 2-4 warns/bads. Sharpest problem first. Match profile language if not English.

PROFILE:
${JSON.stringify(profile)}`;
}

// ------------------------------------------------------------------
// STAGE 2 (deep) prompt — only the rewrites layer.
// Target: 8-14s round trip; runs in parallel with stage 1.
// ------------------------------------------------------------------
export function buildRewritesPrompt(profile, targetRole) {
  return `You are rewriting sections of this LinkedIn profile for target role: ${targetRole || 'auto-detect from profile'}. Return JSON:

{
  "headline": "<rewritten headline, ~220 chars, uses real company/tech from profile>",
  "about_first_paragraph": "<rewritten About opening, ~300 chars>",
  "top_bullets": ["<3 STAR bullets using real data from the profile>"]
}

Use only real data from the profile. Never invent numbers. Match the profile's language if not English. No AI slop, no "passionate about", no "results-driven".

PROFILE:
${JSON.stringify(profile)}`;
}

// ------------------------------------------------------------------
// Apify: single LinkedIn profile scrape
// ------------------------------------------------------------------
export async function fetchProfile(username, apifyToken) {
  const actor = 'apimaestro~linkedin-profile-detail';
  const url = `https://api.apify.com/v2/acts/${actor}/run-sync-get-dataset-items?token=${apifyToken}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, includeEmail: false }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Apify error ${resp.status}: ${text.slice(0, 300)}`);
  }

  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Profile not found or empty result from Apify.');
  }
  return data[0];
}

// ------------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------------
function extractJson(text) {
  const cleaned = String(text || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

async function callGeminiOnce(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  return resp;
}

async function geminiJson({ apiKey, model, systemInstruction, userText, maxOutputTokens = 2500 }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: systemInstruction }] },
    contents: [{ role: 'user', parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens,
      responseMimeType: 'application/json',
    },
  };

  // Retry with backoff on 503 (Gemini overload) / 429 / body-level "high demand".
  // Extended budget: 6 attempts, ~62s of total retry time — Gemini overload
  // spikes usually clear inside a minute.
  const backoffs = [0, 2000, 5000, 10000, 20000, 25000];
  let lastText = '';
  for (const wait of backoffs) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    const resp = await callGeminiOnce(url, body);
    if (resp.ok) {
      const data = await resp.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      try { return extractJson(text); }
      catch { throw new Error(`Gemini returned non-JSON: ${text.slice(0, 400)}`); }
    }
    lastText = await resp.text();
    const overloadedBody = /overloaded|unavailable|high demand|resource_exhausted/i.test(lastText);
    if (resp.status !== 503 && resp.status !== 429 && !overloadedBody) {
      throw new Error(`Gemini error ${resp.status}: ${lastText.slice(0, 400)}`);
    }
  }
  throw new Error(`Gemini overloaded (503) after retries: ${lastText.slice(0, 300)}`);
}

async function claudeJson({ apiKey, model, systemInstruction, userText, maxOutputTokens = 2500 }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxOutputTokens,
      system: systemInstruction,
      messages: [{ role: 'user', content: userText }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Anthropic error ${resp.status}: ${text.slice(0, 400)}`);
  }
  const data = await resp.json();
  const text = data.content?.[0]?.text ?? '';
  try { return extractJson(text); }
  catch { throw new Error(`Claude returned non-JSON: ${text.slice(0, 400)}`); }
}

// ------------------------------------------------------------------
// Public API — stage runners
// ------------------------------------------------------------------
// If the primary provider fails with an overload-flavored error and the
// OTHER provider is configured, transparently retry against the secondary.
// Non-overload errors bubble out unchanged.
async function withProviderFallback(primaryFn, secondaryFn) {
  try { return await primaryFn(); }
  catch (err) {
    const msg = err?.message || '';
    const overloaded = /overloaded|unavailable|503|429|high demand|resource_exhausted|rate.?limit/i.test(msg);
    if (secondaryFn && overloaded) {
      console.warn('[audit] primary provider overloaded — falling back:', msg);
      return await secondaryFn();
    }
    throw err;
  }
}

export async function runFastStage(profile, targetRole, opts) {
  const { anthropicKey, geminiKey, claudeModel, geminiModel } = opts;
  const userText = buildFastPrompt(profile, targetRole);
  const claudeCall = anthropicKey ? () => claudeJson({
    apiKey: anthropicKey, model: claudeModel || 'claude-sonnet-4-6',
    systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 5000,
  }) : null;
  const geminiCall = geminiKey ? () => geminiJson({
    apiKey: geminiKey, model: geminiModel || 'gemini-3.6-flash',
    systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 1800,
  }) : null;
  if (claudeCall && geminiCall) return withProviderFallback(claudeCall, geminiCall);
  return (claudeCall || geminiCall)();
}

// ------------------------------------------------------------------
// STAGE 3 (post-payment) prompt — full Recipe: everything the paywall
// promises. Runs once, right after a successful Stripe checkout. Output
// is stored permanently under the customer's unique token.
// ------------------------------------------------------------------
export function buildRecipePrompt(profile, initialAudit, targetRole) {
  return `The customer just paid for The Recipe. Generate the FULL extended
audit content — everything the paywall promised. Return one JSON object with
these top-level keys, matching the profile's language:

{
  "all_bullets_rewritten": [
    { "role": "Job title @ Company", "bullets": ["<STAR-format bullet>", ...] },
    ...
  ],
  "featured_posts": [
    { "title": "<hook title>", "body": "<150-200 word LinkedIn post draft>" },
    ...5 total
  ],
  "recommendation_requests": [
    { "target_relationship": "former manager / ex-teammate / etc",
      "subject": "<email subject>",
      "body": "<~120 word personal but professional request>" },
    ...3 total
  ],
  "skills_gap": {
    "missing_skills": ["<skill 1>", ...5-8 items],
    "learning_path": ["<step 1>", ...],
    "commentary": "<2-3 sentence honest read of what's missing and why it matters>"
  },
  "cover_letter": {
    "opening_paragraph": "<hook that references their real work>",
    "middle_paragraph": "<value prop grounded in their real experience>",
    "closing_paragraph": "<clear CTA>",
    "notes": "<1-2 sentences on how to customize per application>"
  }
}

Rules:
- Rewrite EVERY experience bullet from the profile — not a sample.
- Use ONLY real facts from the profile. Never invent numbers, employers,
  or technologies. If something isn't in the profile, don't add it.
- STAR format for bullets: situation / task / action / result, but written
  as one crisp sentence per bullet.
- Featured posts should be technical and match the person's stack. Not
  generic "I'm passionate about learning" fluff. Real hooks, real code
  references, real takeaways.
- Recommendation-request emails must sound like a human wrote them — no
  corporate template phrasing.
- Skills gap = the 5-8 highest-signal missing skills for their target
  role, not just LinkedIn keyword suggestions.
- Cover letter references the person's real bullets/patents/publications.

TARGET ROLE: ${targetRole || 'auto-detect from profile'}
PROFILE: ${JSON.stringify(profile)}
INITIAL AUDIT: ${JSON.stringify(initialAudit)}`;
}

export async function runRecipeStage(profile, initialAudit, targetRole, opts) {
  const { anthropicKey, geminiKey, claudeModel, geminiModel } = opts;
  if (anthropicKey) {
    return claudeJson({
      apiKey: anthropicKey,
      model: claudeModel || 'claude-sonnet-4-6',
      systemInstruction: SYSTEM_PROMPT,
      userText: buildRecipePrompt(profile, initialAudit, targetRole),
      maxOutputTokens: 6000,
    });
  }
  return geminiJson({
    apiKey: geminiKey,
    model: geminiModel || 'gemini-3.6-flash',
    systemInstruction: SYSTEM_PROMPT,
    userText: buildRecipePrompt(profile, initialAudit, targetRole),
    maxOutputTokens: 6000,
  });
}

export async function runRewritesStage(profile, targetRole, opts) {
  const { anthropicKey, geminiKey, claudeModel, geminiModel } = opts;
  const userText = buildRewritesPrompt(profile, targetRole);
  const claudeCall = anthropicKey ? () => claudeJson({
    apiKey: anthropicKey, model: claudeModel || 'claude-sonnet-4-6',
    systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 2600,
  }) : null;
  const geminiCall = geminiKey ? () => geminiJson({
    apiKey: geminiKey, model: geminiModel || 'gemini-3.6-flash',
    systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 2200,
  }) : null;
  if (claudeCall && geminiCall) return withProviderFallback(claudeCall, geminiCall);
  return (claudeCall || geminiCall)();
}

// ------------------------------------------------------------------
// Legacy single-shot for callers that don't want progressive rendering.
// Runs both stages IN PARALLEL and merges — cuts the total wall time.
// ------------------------------------------------------------------
export async function runAudit({ username, targetRole, apifyToken, anthropicKey, geminiKey, claudeModel, geminiModel }) {
  const provider = anthropicKey ? 'anthropic' : geminiKey ? 'gemini' : null;
  if (!provider) throw new Error('No LLM key configured');

  const t0 = Date.now();
  const profile = await fetchProfile(username, apifyToken);
  const tScrape = Date.now() - t0;

  const opts = { anthropicKey, geminiKey, claudeModel, geminiModel };
  const [fast, rewrites] = await Promise.all([
    runFastStage(profile, targetRole, opts),
    runRewritesStage(profile, targetRole, opts),
  ]);
  const audit = { ...fast, rewrites };

  const tTotal = Date.now() - t0;
  return {
    profile: {
      fullname: profile.basic_info?.fullname,
      headline: profile.basic_info?.headline,
      current_company: profile.basic_info?.current_company,
      location: profile.basic_info?.location?.full,
      picture: profile.basic_info?.profile_picture_url,
      follower_count: profile.basic_info?.follower_count,
    },
    audit,
    timing_ms: { scrape: tScrape, llm: tTotal - tScrape, total: tTotal },
    provider,
  };
}

// Convenience: profile-only projection used everywhere.
export function projectProfile(profile) {
  return {
    fullname: profile.basic_info?.fullname,
    headline: profile.basic_info?.headline,
    current_company: profile.basic_info?.current_company,
    location: profile.basic_info?.location?.full,
    picture: profile.basic_info?.profile_picture_url,
    follower_count: profile.basic_info?.follower_count,
  };
}

// ------------------------------------------------------------------
// Input parsing: bare username OR full URL
// ------------------------------------------------------------------
export function parseUsername(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const m = s.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  const candidate = (m ? m[1] : s).replace(/^@/, '');
  if (!/^[a-zA-Z0-9_-]{3,100}$/.test(candidate)) return null;
  return candidate;
}
