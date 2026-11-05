import { sessionOptions, withUtcSession } from './db-session.js';

describe('session options of every application connection (Story 20.8 round 2)', () => {
  it('adds the UTC time zone to a URL without options', () => {
    const u = new URL(
      withUtcSession('postgresql://u:p@h:5432/d?schema=public'),
    );
    expect(u.searchParams.get('options')).toBe('-c TimeZone=UTC');
    expect(u.searchParams.get('schema')).toBe('public');
    expect(u.toString()).toContain('options=-c%20TimeZone%3DUTC');
    expect(u.toString()).not.toContain('+');
  });

  it('keeps and extends an options already in the URL, never duplicates the zone', () => {
    const once = withUtcSession(
      'postgresql://u:p@h/d?options=-c%20lock_timeout%3D10000',
    );
    expect(new URL(once).searchParams.get('options')).toBe(
      '-c lock_timeout=10000 -c TimeZone=UTC',
    );
    expect(new URL(withUtcSession(once)).searchParams.get('options')).toBe(
      '-c lock_timeout=10000 -c TimeZone=UTC',
    );
  });

  it('a zone someone already put in the options is respected (it is theirs to explain)', () => {
    expect(sessionOptions('-c timezone=UTC')).toBe('-c timezone=UTC');
  });

  it('extra flags go before the zone', () => {
    expect(sessionOptions(null, ['-c search_path=public'])).toBe(
      '-c search_path=public -c TimeZone=UTC',
    );
  });

  it('credentials with special characters survive', () => {
    const raw = 'postgresql://us%40er:p%2Fw%3A@h:5432/db%20x?schema=public';
    const out = new URL(withUtcSession(raw));
    expect(out.username).toBe('us%40er');
    expect(out.password).toBe('p%2Fw%3A');
    expect(out.pathname).toBe('/db%20x');
  });
});

describe('every connection the application opens carries the UTC session option', () => {
  it('the retention lock client', async () => {
    const { RetentionSessionLock } =
      await import('../retention/retention-lock.js');
    const cs = RetentionSessionLock.connectionString(
      'postgresql://u:p@h:5432/d?schema=public',
    );
    expect(new URL(cs).searchParams.get('options')).toBe('-c TimeZone=UTC');
    expect(new URL(cs).searchParams.get('schema')).toBeNull(); // not a libpq option
  });

  it('the usage log writer pool (with the search_path of ?schema=)', async () => {
    const { PrismaUsageLogWriter } =
      await import('../usage/usage-log.writer.js');
    const w = new PrismaUsageLogWriter({
      getOrThrow: () => 'postgresql://u:p@h:5432/d?schema=app',
    } as never);
    const pool = (
      w as unknown as {
        getPool: () => {
          options: { connectionString: string };
          end: () => Promise<void>;
        };
      }
    ).getPool();
    try {
      expect(
        new URL(pool.options.connectionString).searchParams.get('options'),
      ).toBe('-c search_path=app -c TimeZone=UTC');
    } finally {
      await pool.end();
    }
  });
});
