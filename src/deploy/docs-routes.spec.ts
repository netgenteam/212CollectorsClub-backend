import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Story 20.10 (QA round 2): every `/api/v1/...` route cited in section 22 of `docs/deployment.md` (and its verb, when the
 * text gives one right before it) must exist in a controller. `GET /api/v1/admin/fx` was cited but only
 * `/admin/fx/settings|status|...` exist (a 404 for the operator).
 */
const ROOT = join(__dirname, '..', '..');
const SRC = join(ROOT, 'src');

function controllers(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'generated' || name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) controllers(full, out);
    else if (name.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

const join2 = (...p: string[]) =>
  '/' + p.join('/').split('/').filter(Boolean).join('/');

/** `{ 'GET /api/v1/admin/fx/status', ... }` from the `@Controller('x')` + `@Get('y')` decorators. */
export function routeTable(): Set<string> {
  const routes = new Set<string>();
  for (const f of controllers(SRC)) {
    const text = readFileSync(f, 'utf8');
    const base = /@Controller\(\s*(?:'([^']*)')?\s*\)/.exec(text)?.[1] ?? '';
    for (const m of text.matchAll(
      /@(Get|Post|Put|Patch|Delete)\(\s*(?:'([^']*)')?\s*\)/g,
    )) {
      routes.add(`${m[1].toUpperCase()} ${join2('api/v1', base, m[2] ?? '')}`);
    }
  }
  return routes;
}

function section22(): string {
  const doc = readFileSync(join(ROOT, 'docs', 'deployment.md'), 'utf8');
  const start = doc.indexOf('\n## 22. ');
  expect(start).toBeGreaterThan(0);
  return doc.slice(start);
}

/** Cited routes as `[verb|null, path]`; `:param` segments are kept, trailing punctuation is dropped. */
export function citedRoutes(text: string): Array<[string | null, string]> {
  const out: Array<[string | null, string]> = [];
  for (const m of text.matchAll(
    /(?:\b(GET|POST|PUT|PATCH|DELETE)\s+)?`?(\/api\/v1(?:\/[A-Za-z0-9_:-]+)*)/g,
  )) {
    out.push([m[1] ?? null, m[2]]);
  }
  return out;
}

describe('docs/deployment.md section 22 cites only real routes', () => {
  const table = routeTable();
  const cited = citedRoutes(section22());

  it('the route table and the extraction work', () => {
    expect(table.has('GET /api/v1/admin/fx/status')).toBe(true);
    expect(table.has('POST /api/v1/admin/audit/verify')).toBe(true);
    expect(cited.length).toBeGreaterThanOrEqual(6);
    expect(
      citedRoutes('Comprueba con `GET /api/v1/admin/fx` (o').at(0),
    ).toEqual(['GET', '/api/v1/admin/fx']);
  });

  it('each cited route (and verb) exists in a controller', () => {
    const missing: string[] = [];
    for (const [verb, path] of cited) {
      if (path === '/api/v1') continue; // the bare prefix
      const found = verb
        ? table.has(`${verb} ${path}`)
        : [...table].some((r) => r.endsWith(` ${path}`));
      if (!found) missing.push(`${verb ?? '*'} ${path}`);
    }
    expect(missing).toEqual([]);
  });

  it('would have caught the bare /admin/fx of round 2', () => {
    expect(table.has('GET /api/v1/admin/fx')).toBe(false);
  });
});
