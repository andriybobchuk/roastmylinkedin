// GET /session-recipe?session_id=cs_...
//
// Called by success.html after Stripe redirects. Looks up the recipe token
// that our webhook wrote under `by-session:{sessionId}`. Returns:
//   200 { token, ready }   — webhook processed, link is usable
//   202 { pending: true }  — webhook not fired yet, keep polling
//   400                    — bad session_id

import { connectLambda, getStore } from '@netlify/blobs';

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  connectLambda(event);

  const sessionId = String(event.queryStringParameters?.session_id || '').trim();
  if (!sessionId || !/^cs_(test_|live_)?[A-Za-z0-9]{20,}$/.test(sessionId)) {
    return { statusCode: 400, body: 'Bad session_id' };
  }

  const recipes = getStore('recipes');
  let entry;
  try { entry = await recipes.get(`by-session:${sessionId}`, { type: 'json' }); }
  catch { entry = null; }

  if (!entry || !entry.token) {
    return {
      statusCode: 202,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      body: JSON.stringify({ pending: true }),
    };
  }

  return {
    statusCode: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: JSON.stringify({ token: entry.token, ready: !!entry.ready }),
  };
};
