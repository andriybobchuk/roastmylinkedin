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

// Groq: OpenAI-compatible chat completions API. Extremely fast (LPU inference)
// and has a generous free tier (~30 RPM, 12k TPM on llama-3.3-70b-versatile).
// Retries on 429/503 with backoff, same shape as geminiJson.
async function groqJson({ apiKey, model, systemInstruction, userText, maxOutputTokens = 2500 }) {
  const url = 'https://api.groq.com/openai/v1/chat/completions';
  const body = {
    model,
    messages: [
      { role: 'system', content: systemInstruction },
      { role: 'user', content: userText },
    ],
    temperature: 0.75,
    max_tokens: maxOutputTokens,
    response_format: { type: 'json_object' },
  };
  const backoffs = [0, 1500, 4000, 10000];
  let lastText = '';
  for (const wait of backoffs) {
    if (wait) await new Promise(r => setTimeout(r, wait));
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (resp.ok) {
      const data = await resp.json();
      const text = data.choices?.[0]?.message?.content ?? '';
      try { return extractJson(text); }
      catch { throw new Error(`Groq returned non-JSON: ${text.slice(0, 400)}`); }
    }
    lastText = await resp.text();
    const overloadedBody = /overloaded|unavailable|rate.?limit|resource_exhausted|capacity/i.test(lastText);
    if (resp.status !== 503 && resp.status !== 429 && resp.status !== 500 && !overloadedBody) {
      throw new Error(`Groq error ${resp.status}: ${lastText.slice(0, 400)}`);
    }
  }
  throw new Error(`Groq overloaded after retries: ${lastText.slice(0, 300)}`);
}

// ------------------------------------------------------------------
// Public API — stage runners
// ------------------------------------------------------------------
// Walks a chain of provider callables in order. If a call fails with an
// overload-flavored error and there's a next provider, transparently retries.
// Any non-overload error bubbles immediately so we don't double-spend on a
// real bug. Empty chain throws — caller must ensure at least one provider.
async function runProviderChain(chain, label) {
  const providers = chain.filter(Boolean);
  if (providers.length === 0) throw new Error('No LLM provider configured');
  let lastErr;
  for (let i = 0; i < providers.length; i++) {
    try { return await providers[i](); }
    catch (err) {
      lastErr = err;
      const msg = err?.message || '';
      const overloaded = /overloaded|unavailable|503|429|500|high demand|resource_exhausted|rate.?limit|capacity/i.test(msg);
      const isLast = i === providers.length - 1;
      if (isLast || !overloaded) throw err;
      console.warn(`[audit:${label}] provider ${i} overloaded — falling back to provider ${i + 1}:`, msg);
    }
  }
  throw lastErr;
}

// Builds the ordered provider chain from opts:
//   1. Groq (free, fastest, primary)
//   2. Gemini (free)
//   3. Anthropic (paid, most reliable)
// Any provider whose key is missing is simply skipped.
function buildChain({ opts, userText, groqTokens, geminiTokens, claudeTokens }) {
  const { groqKey, geminiKey, anthropicKey, groqModel, geminiModel, claudeModel } = opts;
  return [
    groqKey ? () => groqJson({
      apiKey: groqKey, model: groqModel || 'openai/gpt-oss-120b',
      systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: groqTokens,
    }) : null,
    geminiKey ? () => geminiJson({
      apiKey: geminiKey, model: geminiModel || 'gemini-3.6-flash',
      systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: geminiTokens,
    }) : null,
    anthropicKey ? () => claudeJson({
      apiKey: anthropicKey, model: claudeModel || 'claude-sonnet-4-6',
      systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: claudeTokens,
    }) : null,
  ];
}

export async function runFastStage(profile, targetRole, opts) {
  const chain = buildChain({
    opts,
    userText: buildFastPrompt(profile, targetRole),
    // Groq's gpt-oss-120b spends hidden reasoning tokens before emitting JSON,
    // so its budget is roughly 2× the actual output size we want.
    groqTokens: 4000,
    geminiTokens: 1800,
    claudeTokens: 5000,
  });
  return runProviderChain(chain, 'fast');
}

// ------------------------------------------------------------------
// STAGE 3 (post-payment) prompt — full Recipe: everything the paywall
// promises. Runs once, right after a successful Stripe checkout. Output
// is stored permanently under the customer's unique token.
// ------------------------------------------------------------------
export function buildRecipePrompt(profile, initialAudit, targetRole) {
  return `The customer just paid for The Recipe. Generate the FULL extended
audit content — a maxed-out SSI-style deliverable. Return one JSON object with
ALL of these top-level keys, matching the profile's language:

{
  "score_breakdown": {
    "dimensions": [
      { "name": "Discoverability",       "score": <0-100>, "commentary": "<2 sentences>", "fixes": ["<action>", "<action>", "<action>"] },
      { "name": "Positioning",           "score": <0-100>, "commentary": "<2 sentences>", "fixes": ["<action>", "<action>", "<action>"] },
      { "name": "Proof of shipping",     "score": <0-100>, "commentary": "<2 sentences>", "fixes": ["<action>", "<action>", "<action>"] },
      { "name": "Seniority signals",     "score": <0-100>, "commentary": "<2 sentences>", "fixes": ["<action>", "<action>", "<action>"] },
      { "name": "Content & authority",   "score": <0-100>, "commentary": "<2 sentences>", "fixes": ["<action>", "<action>", "<action>"] },
      { "name": "Recommendations",       "score": <0-100>, "commentary": "<2 sentences>", "fixes": ["<action>", "<action>", "<action>"] }
    ]
  },
  "headline_variants": [
    { "angle": "Senior-IC frame",       "text": "<~220 chars>", "why": "<1 sentence>" },
    { "angle": "Recruiter-keyword frame","text": "<~220 chars>", "why": "<1 sentence>" },
    { "angle": "Unusual hook",           "text": "<~220 chars>", "why": "<1 sentence>" },
    { "angle": "Seniority-signal frame", "text": "<~220 chars>", "why": "<1 sentence>" },
    { "angle": "Role-transition frame",  "text": "<~220 chars>", "why": "<1 sentence>" }
  ],
  "about_full_rewrite": {
    "opening_paragraph":  "<~350 chars hook + credential>",
    "middle_paragraph":   "<~450 chars: what they ship + real numbers + stack>",
    "closing_paragraph":  "<~250 chars: what they're open to + CTA>",
    "alternative_openings": [
      "<alt opening 1, different angle, ~350 chars>",
      "<alt opening 2, different angle, ~350 chars>"
    ]
  },
  "interview_prep": [
    {
      "question": "<'Tell me about a time when...' or similar behavioral prompt>",
      "answer":   "<STAR-format answer 90-140 words using real project from profile>",
      "grounded_in": "<which company/project/patent from profile>"
    }
    // 10 total, covering: leadership, conflict, ambiguity, technical rigor,
    // ownership, failure, mentoring, stakeholder management, prioritization,
    // impact.
  ],
  "recruiter_visibility": {
    "keywords": [
      { "keyword": "<a role-relevant search term recruiters actually type>",
        "currently_visible": true|false,
        "reasoning": "<1 sentence — where it appears in profile or why it misses>",
        "fix": "<1 sentence concrete addition/edit>" }
      // 6 total; mix of role titles + top stack skills + differentiators
    ],
    "top_missing_keywords": ["<keyword>", "<keyword>", "<keyword>"]
  },
  "all_bullets_rewritten": [
    { "role": "Job title @ Company", "bullets": ["<STAR-format bullet>", ...] }
  ],
  "featured_posts": [
    { "title": "<hook title>", "body": "<150-200 word LinkedIn post draft>" }
    // 5 total
  ],
  "recommendation_requests": [
    { "target_relationship": "former manager / ex-teammate / etc",
      "subject": "<email subject>",
      "body": "<~120 word personal request>" }
    // 3 total
  ],
  "skills_gap": {
    "missing_skills": ["<skill>", "..."],
    "learning_path": ["<step>", "..."],
    "commentary": "<2-3 sentence honest read>"
  },
  "cover_letter": {
    "opening_paragraph": "<hook using real work>",
    "middle_paragraph":  "<value prop from real experience>",
    "closing_paragraph": "<clear CTA>",
    "notes": "<1-2 sentences on per-application customization>"
  }
}

Rules:
- Score breakdown: numbers must be honest — a weak profile can dip into 30s
  on multiple dimensions. Total need not equal the overall audit score;
  these are independent signals. Fixes must be specific, not generic.
- Headline variants: five DIFFERENT angles, each optimized for a distinct
  reader (recruiter search vs. hiring manager vs. peer network). No dupes.
- About full rewrite: complete three-paragraph replacement plus two
  meaningfully different alternative openings the customer can A/B against
  each other. Never invent achievements.
- Interview prep: ground each answer in ACTUAL project/company/patent from
  the profile. No hypothetical scenarios. Format each answer as STAR
  (Situation-Task-Action-Result), but written in flowing prose, not labeled.
- Recruiter visibility: keywords are what a hiring manager or recruiter
  would literally type into LinkedIn search. Assess honestly — the profile
  either surfaces or it doesn't. Fixes are specific text additions.
- Rewrite EVERY experience bullet — not a sample.
- Use ONLY real facts from the profile. Never invent numbers, employers,
  or technologies.
- Featured posts: technical, stack-matched, real hooks. No generic "I'm
  passionate about learning" fluff.
- Recommendation requests must sound human. No corporate templates.
- Skills gap = the 5-8 highest-signal missing skills for their target role.

TARGET ROLE: ${targetRole || 'auto-detect from profile'}
PROFILE: ${JSON.stringify(profile)}
INITIAL AUDIT: ${JSON.stringify(initialAudit)}`;
}

export async function runRecipeStage(profile, initialAudit, targetRole, opts) {
  // Recipe is the paid deliverable and is much bigger than the fast/rewrites
  // stages, so we bias toward the sturdier model: Claude first if available,
  // then Gemini, then Groq. (Groq's llama-3.3-70b handles it but can truncate
  // long JSON near the token cap.)
  const { anthropicKey, geminiKey, groqKey, claudeModel, geminiModel, groqModel } = opts;
  const userText = buildRecipePrompt(profile, initialAudit, targetRole);
  const chain = [
    anthropicKey ? () => claudeJson({
      apiKey: anthropicKey, model: claudeModel || 'claude-sonnet-4-6',
      systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 12000,
    }) : null,
    geminiKey ? () => geminiJson({
      apiKey: geminiKey, model: geminiModel || 'gemini-3.6-flash',
      systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 12000,
    }) : null,
    groqKey ? () => groqJson({
      apiKey: groqKey, model: groqModel || 'openai/gpt-oss-120b',
      systemInstruction: SYSTEM_PROMPT, userText, maxOutputTokens: 18000,
    }) : null,
  ];
  return runProviderChain(chain, 'recipe');
}

export async function runRewritesStage(profile, targetRole, opts) {
  const chain = buildChain({
    opts,
    userText: buildRewritesPrompt(profile, targetRole),
    groqTokens: 4500,
    geminiTokens: 2200,
    claudeTokens: 2600,
  });
  return runProviderChain(chain, 'rewrites');
}

// ------------------------------------------------------------------
// Legacy single-shot for callers that don't want progressive rendering.
// Runs both stages IN PARALLEL and merges — cuts the total wall time.
// ------------------------------------------------------------------
export async function runAudit({ username, targetRole, apifyToken, anthropicKey, geminiKey, groqKey, claudeModel, geminiModel, groqModel }) {
  const provider = groqKey ? 'groq' : geminiKey ? 'gemini' : anthropicKey ? 'anthropic' : null;
  if (!provider) throw new Error('No LLM key configured');

  const t0 = Date.now();
  const profile = await fetchProfile(username, apifyToken);
  const tScrape = Date.now() - t0;

  const opts = { anthropicKey, geminiKey, groqKey, claudeModel, geminiModel, groqModel };
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
