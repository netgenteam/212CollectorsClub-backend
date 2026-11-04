import { describe, expect, it } from 'vitest';
import {
  IddocUsageError,
  parseBackfillArgs,
  parseReencryptArgs,
} from './iddoc-args.js';

describe('parseBackfillArgs', () => {
  it('no flag = backfill; one mode at most', () => {
    expect(parseBackfillArgs([])).toMatchObject({ mode: 'backfill' });
    expect(parseBackfillArgs(['--verify'])).toMatchObject({ mode: 'verify' });
    expect(parseBackfillArgs(['--scrub'])).toMatchObject({ mode: 'scrub' });
    expect(parseBackfillArgs(['--check'])).toMatchObject({ mode: 'check' });
    expect(() => parseBackfillArgs(['--verify', '--scrub'])).toThrow(
      IddocUsageError,
    );
    expect(() => parseBackfillArgs(['--check', '--verify'])).toThrow(
      IddocUsageError,
    );
  });
  it('numbers are bounded; unknown flags are refused (and never echoed whole)', () => {
    expect(
      parseBackfillArgs(['--batch-size', '100', '--pause-ms', '0']),
    ).toEqual({
      mode: 'backfill',
      batchSize: 100,
      pauseMs: 0,
    });
    for (const bad of [
      ['--batch-size', '0'],
      ['--batch-size', '99999'],
      ['--batch-size'],
      ['--pause-ms', '-1'],
      ['--batch-size', '1e3'],
    ])
      expect(() => parseBackfillArgs(bad)).toThrow(IddocUsageError);
    expect(() => parseBackfillArgs(['--drop-everything'])).toThrow(
      /unknown argument/,
    );
    expect(() => parseBackfillArgs(['V-12345678'])).toThrow(IddocUsageError);
  });
});

describe('parseReencryptArgs', () => {
  it('--to is required', () => {
    expect(() => parseReencryptArgs([])).toThrow(/--to/);
    expect(() => parseReencryptArgs(['--dry-run'])).toThrow(/--to/);
    expect(() => parseReencryptArgs(['--to', 'x'])).toThrow(IddocUsageError);
    expect(() => parseReencryptArgs(['--to', '0'])).toThrow(IddocUsageError);
  });
  it('parses version and dry-run', () => {
    expect(parseReencryptArgs(['--to', '2'])).toEqual({ to: 2, dryRun: false });
    expect(parseReencryptArgs(['--to', '2', '--dry-run'])).toMatchObject({
      to: 2,
      dryRun: true,
    });
  });
});
