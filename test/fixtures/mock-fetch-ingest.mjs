// Preload for the 15.9 script e2e: replaces global fetch (no network).
// MOCK_SCENARIO: ok | failed | not-configured | running | partial.
// Every request is echoed to stderr as `MOCKFETCH <METHOD> <url> <body>`.
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const scenario = process.env.MOCK_SCENARIO ?? 'ok';
let polls = 0;

globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const method = init.method ?? 'GET';
  console.error(`MOCKFETCH ${method} ${url} ${init.body ?? ''}`);
  if (url.includes('tcgapi.dev'))
    throw new Error('tcgapi must never be called');
  if (url.endsWith('/admin/auth/login'))
    return json({ accessToken: 'tok' }, 200);
  if (url.endsWith('/admin/auth/logout'))
    return new Response(null, { status: 204 });
  if (init.headers?.authorization !== 'Bearer tok') return json({}, 401);
  if (url.endsWith('/stats')) {
    return json({
      totalCards: 7,
      byFranchise: { POKEMON: 7 },
      lastRun: {
        kind: 'INGEST',
        status: 'SUCCEEDED',
        startedAt: 'x',
        requestsUsed: 2,
      },
    });
  }
  if (url.endsWith('/ingest')) {
    if (scenario === 'not-configured') {
      return json({ errorCode: 'TCG_API_NOT_CONFIGURED' }, 503);
    }
    if (scenario === 'running') {
      return json(
        { errorCode: 'TCG_SYNC_ALREADY_RUNNING', details: { runId: 'r0' } },
        409,
      );
    }
    return json({ runId: 'r1', status: 'RUNNING' }, 202);
  }
  if (url.endsWith('/runs/r1')) {
    polls += 1;
    if (polls < 2)
      return json({ id: 'r1', status: 'RUNNING', requestsUsed: 1 });
    const status =
      scenario === 'failed'
        ? 'FAILED'
        : scenario === 'partial'
          ? 'PARTIAL'
          : 'SUCCEEDED';
    return json({
      id: 'r1',
      status,
      requestsUsed: 3,
      quotaRemaining: 80,
      summary: { created: 5 },
      errorSummary: status === 'FAILED' ? 'boom' : null,
    });
  }
  throw new Error(`unexpected fetch ${url}`);
};
