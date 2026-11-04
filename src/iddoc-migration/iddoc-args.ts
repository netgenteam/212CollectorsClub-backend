/** Story 20.3: argument parsing of the `pnpm iddoc:*` CLIs (pure, tested). */
export class IddocUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IddocUsageError';
  }
}

export type BackfillCommand = {
  mode: 'backfill' | 'verify' | 'scrub' | 'check';
  batchSize?: number;
  pauseMs?: number;
};

function num(
  flag: string,
  v: string | undefined,
  min: number,
  max: number,
): number {
  if (v === undefined || !/^\d+$/.test(v)) {
    throw new IddocUsageError(`${flag} needs a whole number`);
  }
  const n = Number(v);
  if (n < min || n > max) {
    throw new IddocUsageError(`${flag} must be between ${min} and ${max}`);
  }
  return n;
}

/** `iddoc:backfill [--verify | --scrub | --check] [--batch-size N] [--pause-ms N]`: exactly one mode (none = backfill). */
export function parseBackfillArgs(argv: string[]): BackfillCommand {
  let mode: BackfillCommand['mode'] = 'backfill';
  let chosen = 0;
  let batchSize: number | undefined;
  let pauseMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--verify' || a === '--scrub' || a === '--check') {
      mode = a.slice(2) as 'verify' | 'scrub' | 'check';
      chosen++;
    } else if (a === '--batch-size') {
      batchSize = num(a, argv[++i], 1, 5000);
    } else if (a === '--pause-ms') {
      pauseMs = num(a, argv[++i], 0, 10_000);
    } else {
      throw new IddocUsageError(`unknown argument ${a.slice(0, 40)}`);
    }
  }
  if (chosen > 1) {
    throw new IddocUsageError('use only one of --verify, --scrub, --check');
  }
  return { mode, batchSize, pauseMs };
}

export interface ReencryptCommand {
  to: number;
  dryRun: boolean;
  batchSize?: number;
  pauseMs?: number;
}

/** `iddoc:reencrypt --to <N> [--dry-run] [--batch-size N] [--pause-ms N]` (`--to` is required). */
export function parseReencryptArgs(argv: string[]): ReencryptCommand {
  let to: number | undefined;
  let dryRun = false;
  let batchSize: number | undefined;
  let pauseMs: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--to') to = num(a, argv[++i], 1, 9999);
    else if (a === '--dry-run') dryRun = true;
    else if (a === '--batch-size') batchSize = num(a, argv[++i], 1, 5000);
    else if (a === '--pause-ms') pauseMs = num(a, argv[++i], 0, 10_000);
    else throw new IddocUsageError(`unknown argument ${a.slice(0, 40)}`);
  }
  if (to === undefined) throw new IddocUsageError('--to <version> is required');
  return { to, dryRun, batchSize, pauseMs };
}
