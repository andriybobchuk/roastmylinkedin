// Shared audit logic: fetch profile from Apify, run LLM roast.
// Used by both the local Node server (server.js) and the Netlify Function.

// ------------------------------------------------------------------
// Speed-tuned prompt (aims for ~15-25s total LLM time).
// ------------------------------------------------------------------
export const SYSTEM_PROMPT = `You are a sharp tech recruiter roasting a LinkedIn profile. Voice: witty, sarcastic-when-warranted, specific, useful. Mock buzzwords/cliches — not the person. Reference their real companies, tech, and numbers.

Output valid JSON only. No preamble, no code fences.

Rules:
- 3-5 findings total (1 good, 2-4 warns/bads). Sharpest problem first.
- Titles: 4-8 punchy words, quotable.
- Descriptions: 1 sharp observation + 1 concrete fix. Under 40 words.
- Summary: 2 memorable sentences.
- Rewrites reference real data. No invented numbers. No AI slop.

Score honestly: 80-95 strong senior, 60-79 solid mid, 40-59 weak, under 40 broken.`;

export function buildAuditPrompt(profile, targetRole) {
  return `Analyze for target role: ${targetRole || 'auto-detect from profile'}. Return JSON:

{
  "score": <int 0-100>,
  "role_detected": "<engineering discipline>",
  "summary": "<2 memorable sentences>",
  "benchmark": { "percentile": "<top X% or bottom X%>", "reasoning": "<one sentence>" },
  "findings": [
    { "section": "<Headline|About|Experience|Skills|Featured|Activity|Recommendations>", "severity": "<good|warn|bad>", "title": "<4-8 word title>", "description": "<max 40 words>", "impact_points": <int> }
  ],
  "rewrites": {
    "headline": "<~220 chars, uses real company/tech>",
    "about_first_paragraph": "<~300 chars>",
    "top_bullets": ["<3 STAR bullets using real data>"]
  }
}

Match profile language if not English.

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
// LLM: Gemini (default) or Claude, whichever is configured.
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

export async function auditWithGemini(profile, targetRole, { apiKey, model = 'gemini-3.6-flash' }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: buildAuditPrompt(profile, targetRole) }] }],
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens: 3500,
      responseMimeType: 'application/json',
    },
  };

  // Retry with exponential backoff on 503 (Gemini's "high demand") and 429.
  const backoffs = [0, 1500, 4000];
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
    if (resp.status !== 503 && resp.status !== 429) {
      throw new Error(`Gemini error ${resp.status}: ${lastText.slice(0, 400)}`);
    }
  }
  throw new Error(`Gemini overloaded (503) after retries: ${lastText.slice(0, 300)}`);
}

export async function auditWithClaude(profile, targetRole, { apiKey, model = 'claude-sonnet-4-6' }) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 3500,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildAuditPrompt(profile, targetRole) }],
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
// Main orchestrator — pick provider from env, run Apify then LLM
// ------------------------------------------------------------------
export async function runAudit({ username, targetRole, apifyToken, anthropicKey, geminiKey, claudeModel, geminiModel }) {
  const provider = anthropicKey ? 'anthropic' : geminiKey ? 'gemini' : null;
  if (!provider) throw new Error('No LLM key configured');

  const t0 = Date.now();
  const profile = await fetchProfile(username, apifyToken);
  const tScrape = Date.now() - t0;

  const audit = provider === 'anthropic'
    ? await auditWithClaude(profile, targetRole, { apiKey: anthropicKey, model: claudeModel })
    : await auditWithGemini(profile, targetRole, { apiKey: geminiKey, model: geminiModel });

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
