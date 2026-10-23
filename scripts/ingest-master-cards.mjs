#!/usr/bin/env node
/**
 * Llena `Master_Cards` del backend desplegado desde tu máquina, sin SSH:
 * login admin → POST /admin/tcg-master-cards/ingest (arranca la ingesta en el
 * servidor, con la TCGAPI_KEY del propio servidor) → sondea
 * GET /admin/tcg-master-cards/runs/:id hasta que termina → imprime resumen y
 * stats. Esta herramienta NO usa ni envía TCGAPI_KEY. Sin dependencias (Node >= 20).
 *
 * Uso:
 *   node scripts/ingest-master-cards.mjs [--games pokemon,magic] [--sets sv3pt5,151]
 *                                        [--max-requests 40] [--set-limit 5] [--refresh-sets]
 *   node scripts/ingest-master-cards.mjs --status   # solo imprime las stats
 *
 * Variables de entorno (o archivo scripts/.env.import, ver .env.import.example):
 *   API_BASE_URL         p.ej. https://api.midominio.com/api/v1   (obligatoria)
 *   ADMIN_USER           usuario o email del admin                (obligatoria)
 *   ADMIN_PASSWORD                                                (obligatoria)
 *   INGEST_GAMES         equivale a --games        (opcional; si falta, defaults del servidor)
 *   INGEST_SETS          equivale a --sets         (opcional)
 *   INGEST_MAX_REQUESTS  equivale a --max-requests (opcional)
 *   INGEST_POLL_SECONDS  segundos entre sondeos (default: 5)
 *
 * Código de salida: 0 con SUCCEEDED/PARTIAL (PARTIAL = cuota/presupuesto; vuelve a
 * ejecutar para continuar), 1 con FAILED o cualquier error (incluye 409/503).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

loadEnvFile(join(HERE, '.env.import'));

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') {
    fail(`Falta la variable de entorno ${name}`);
  }
  return value;
};

const VALUE_FLAGS = {
  '--games': 'games',
  '--sets': 'sets',
  '--max-requests': 'maxRequests',
  '--set-limit': 'setLimit',
};

function parseArgs(argv) {
  const opts = {};
  let status = false;
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let inline;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (arg === '--status') status = true;
    else if (arg === '--refresh-sets') opts.refreshSets = true;
    else if (VALUE_FLAGS[arg]) {
      const value = inline ?? argv[++i];
      if (value === undefined || value.startsWith('--')) fail(`${arg} requiere un valor`);
      opts[VALUE_FLAGS[arg]] = value;
    } else fail(`Argumento desconocido: ${arg}`);
  }
  return { opts, status };
}

const list = (value) =>
  value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function positiveInt(name, value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) fail(`${name} debe ser un entero >= 1 (recibido "${value}")`);
  return n;
}

/** Flags > envs INGEST_*; lo que falte queda fuera del body (defaults del servidor). */
export function buildBody(opts, environ = process.env) {
  const games = opts.games ?? environ.INGEST_GAMES;
  const sets = opts.sets ?? environ.INGEST_SETS;
  const maxRequests = opts.maxRequests ?? environ.INGEST_MAX_REQUESTS;
  const body = {};
  if (games) body.games = list(games);
  if (sets) body.sets = list(sets);
  if (maxRequests) body.maxRequests = positiveInt('--max-requests', maxRequests);
  if (opts.setLimit) body.setLimit = positiveInt('--set-limit', opts.setLimit);
  if (opts.refreshSets) body.refreshSets = true;
  return body;
}

const { opts, status: STATUS_ONLY } = parseArgs(process.argv.slice(2));
const API = env('API_BASE_URL').replace(/\/+$/, '');
const POLL_MS = positiveInt('INGEST_POLL_SECONDS', env('INGEST_POLL_SECONDS', '5')) * 1000;

async function api(path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    /* cuerpo vacío o no JSON */
  }
  return { res, body: parsed };
}

async function login() {
  const { res, body } = await api('/admin/auth/login', {
    method: 'POST',
    body: { usernameOrEmail: env('ADMIN_USER'), password: env('ADMIN_PASSWORD') },
  });
  if (!res.ok || !body?.accessToken) {
    fail(`Login admin falló (${res.status}): ${JSON.stringify(body)}`);
  }
  return body.accessToken;
}

async function printStats(token) {
  const { res, body } = await api('/admin/tcg-master-cards/stats', { token });
  if (!res.ok) fail(`GET stats falló (${res.status}): ${JSON.stringify(body)}`);
  console.log(`Master cards cargadas: ${body.totalCards}`);
  for (const [franchise, n] of Object.entries(body.byFranchise ?? {})) {
    console.log(`  ${franchise}: ${n}`);
  }
  if (body.lastRun) {
    const r = body.lastRun;
    console.log(`Última corrida: ${r.kind} ${r.status} (${r.startedAt}), ${r.requestsUsed} requests`);
  } else {
    console.log('Última corrida: ninguna');
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const token = await login();
  try {
    if (STATUS_ONLY) return await printStats(token);

    const body = buildBody(opts);
    console.log(`Iniciando ingesta en el servidor: ${JSON.stringify(body)}`);
    const start = await api('/admin/tcg-master-cards/ingest', { method: 'POST', token, body });
    if (start.res.status === 409) {
      const runId = start.body?.details?.runId;
      fail(
        `Ya hay una corrida en curso${runId ? ` (${runId})` : ''}; espera a que termine o consulta --status.`,
      );
    }
    if (start.res.status === 503) {
      fail(
        'El servidor no tiene TCGAPI_KEY configurada (TCG_API_NOT_CONFIGURED). ' +
          'Configúrala en el env del servidor; esta herramienta no la envía.',
      );
    }
    if (start.res.status !== 202 || !start.body?.runId) {
      fail(`POST ingest falló (${start.res.status}): ${JSON.stringify(start.body)}`);
    }
    const { runId } = start.body;
    console.log(`Corrida ${runId} iniciada; consultando cada ${POLL_MS / 1000}s…`);

    let runState;
    for (;;) {
      const { res, body: current } = await api(`/admin/tcg-master-cards/runs/${runId}`, { token });
      if (!res.ok) fail(`GET runs/${runId} falló (${res.status}): ${JSON.stringify(current)}`);
      runState = current;
      if (runState.status !== 'RUNNING') break;
      console.log(`  RUNNING… requests usados: ${runState.requestsUsed}`);
      await sleep(POLL_MS);
    }

    console.log(`Status: ${runState.status}`);
    console.log(`Summary: ${JSON.stringify(runState.summary)}`);
    console.log(`Requests usados: ${runState.requestsUsed}`);
    console.log(`Cuota restante (última conocida): ${runState.quotaRemaining ?? 'desconocida'}`);
    if (runState.status === 'PARTIAL') {
      console.log('Cuota/presupuesto alcanzado: el progreso quedó guardado, vuelve a ejecutar para continuar.');
    }
    if (runState.errorSummary) console.error(`Error: ${runState.errorSummary}`);
    await printStats(token);
    if (runState.status === 'FAILED') process.exitCode = 1;
  } finally {
    await api('/admin/auth/logout', { method: 'POST', token });
  }
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  }
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

await run();
