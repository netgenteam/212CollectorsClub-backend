import type { IngestOptions } from '../tcg-ingest.service.js';

const VALUE_FLAGS = new Set([
  '--games',
  '--sets',
  '--max-requests',
  '--set-limit',
]);
const BOOL_FLAGS = new Set(['--dry-run', '--refresh-sets']);

function list(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

function positive(flag: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${flag} must be a positive integer (got "${value}")`);
  }
  return n;
}

/**
 * Story 15.4: `--games a,b --sets id|slug,... --max-requests N --set-limit N
 * --dry-run --refresh-sets` (also `--flag=value`). Anything not given stays
 * undefined so the `TCG_*` envs / defaults apply.
 */
export function parseIngestArgs(argv: string[]): Partial<IngestOptions> {
  const out: Partial<IngestOptions> = {};
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') continue;
    let inline: string | undefined;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    if (BOOL_FLAGS.has(arg)) {
      if (arg === '--dry-run') out.dryRun = true;
      else out.refreshSets = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) throw new Error(`Unknown argument: ${arg}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`${arg} requires a value`);
    }
    if (arg === '--games') out.games = list(value);
    else if (arg === '--sets') out.sets = list(value);
    else if (arg === '--max-requests') out.maxRequests = positive(arg, value);
    else out.setLimit = positive(arg, value);
  }
  return out;
}
