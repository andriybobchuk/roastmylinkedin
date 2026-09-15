// GET /.netlify/functions/analyze-status?id=<jobId>
//
// Returns current audit job state from Netlify Blobs.
// Response shapes:
//   { status: "pending" }
//   { status: "done", result: {...} }
//   { status: "error", error: "..." }
//   { status: "unknown" }        (job not found — client should keep polling briefly)

import { connectLambda, getStore } from '@netlify/blobs';

export const handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: 'Method not allowed' };
  }

  connectLambda(event);

  const jobId = String(event.queryStringParameters?.id || '').trim();
  if (!jobId || !/^[a-zA-Z0-9-]{8,64}$/.test(jobId)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Bad jobId' }),
    };
  }

  try {
    const state = await getStore('audit-jobs').get(jobId, { type: 'json' });
    if (!state || (state.expiresAt && Date.now() > state.expiresAt)) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ status: 'unknown' }),
      };
    }
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify(state),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err?.message || 'Storage error' }),
    };
  }
};
