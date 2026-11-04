import { Controller, Get, Logger, VersioningType } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { RedactingLogger } from './../src/common/redacting-logger.js';
import { createGlobalValidationPipe } from './../src/common/global-validation-pipe.js';
import { CryptoModule } from './../src/crypto/crypto.module.js';
import { IdDocCryptoService } from './../src/crypto/id-doc-crypto.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { generateIdDocTestEnv } from './helpers/iddoc-test-keys.js';

/**
 * Story 20.2: the crypto module inside the real app (DI, global, fail-fast at
 * boot) and the redacting logger on real error paths (Nest's exception filter,
 * a real Prisma/Postgres error that echoes a value). Read-only: nothing is
 * written to the database; the keys are throw-away ones from the test env.
 */
const SENTINEL = 'V-98765432';

@Controller('e2e-iddoc-boom')
class BoomController {
  @Get()
  boom(): never {
    throw new Error(`unexpected failure for buyer ${SENTINEL} (v98765432)`);
  }
}

describe('Story 20.2: IdDocCryptoService in the app', () => {
  let app: NestExpressApplication;
  let out: string[] = [];
  const spies: Array<{ mockRestore(): void }> = [];

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [BoomController],
    }).compile();
    app = moduleFixture.createNestApplication<NestExpressApplication>({
      logger: new RedactingLogger({ colors: false }),
    });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(createGlobalValidationPipe());
    await app.init();
    return async () => {
      await app.close();
    };
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    out = [];
  });

  function capture(): void {
    const sink = (c: unknown): boolean => {
      out.push(String(c));
      return true;
    };
    spies.push(
      vi.spyOn(process.stdout, 'write').mockImplementation(sink),
      vi.spyOn(process.stderr, 'write').mockImplementation(sink),
    );
  }

  it('the global service is injectable, round-trips and rotates', () => {
    const svc = app.get(IdDocCryptoService);
    const enc = svc.encrypt('V-12345678');
    expect(svc.decrypt(enc)).toBe('V-12345678');
    expect(svc.serialize(enc)).toBe('V-****5678');
    expect(svc.activeKeyVersion).toBe(1);
    expect(svc.decrypt(svc.encrypt('V-1', 2))).toBe('V-1');
    expect(JSON.stringify(svc)).not.toContain(
      generateIdDocTestEnv().IDDOC_BLIND_KEY,
    );
  });

  it('an unexpected 500 whose message carries a cedula is logged without it, and the response stays generic', async () => {
    capture();
    const res = await request(app.getHttpServer())
      .get('/api/v1/e2e-iddoc-boom')
      .expect(500);
    const logged = out.join('');
    spies.pop()!.mockRestore();
    spies.pop()!.mockRestore();
    expect(JSON.stringify(res.body)).not.toContain('98765432');
    expect(logged).toContain('unexpected failure');
    expect(logged).not.toContain('98765432');
    expect(logged).toContain('[REDACTED_ID]');
  });

  it('a real Postgres/Prisma error that echoes the value is redacted by the logger', async () => {
    const prisma = app.get(PrismaService);
    let raw = '';
    try {
      await prisma.$queryRawUnsafe(`SELECT '${SENTINEL}'::uuid`);
    } catch (e) {
      raw =
        e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e);
      capture();
      new Logger('E2E').error(e);
      new Logger('E2E').error(`Prisma failed: ${(e as Error).message}`);
      spies.pop()!.mockRestore();
      spies.pop()!.mockRestore();
      Logger.overrideLogger(new RedactingLogger({ colors: false }));
    }
    // The database really did echo it (otherwise this test proves nothing).
    expect(raw).toContain('98765432');
    const logged = out.join('');
    expect(logged).toContain('E2E');
    expect(logged).not.toContain('98765432');
  });
});

describe('Story 20.2: the boot aborts on a bad keyring (also in test)', () => {
  const KEYS = ['IDDOC_ENC_KEYS', 'IDDOC_ENC_ACTIVE_KEY', 'IDDOC_BLIND_KEY'];
  const saved: Record<string, string | undefined> = {};

  async function bootWith(
    env: Record<string, string | undefined>,
  ): Promise<void> {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    try {
      const m = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ ignoreEnvFile: true }), CryptoModule],
      }).compile();
      const a = m.createNestApplication();
      try {
        await a.init();
      } finally {
        await a.close();
      }
    } finally {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  it('boots with a valid keyring', async () => {
    await expect(bootWith(generateIdDocTestEnv())).resolves.toBeUndefined();
  });

  it('refuses to boot with no keys, a short key, a missing active version or a blind key equal to a cipher key', async () => {
    const good = generateIdDocTestEnv();
    const sameKey = good.IDDOC_ENC_KEYS.split(',')[0].split(':')[1];
    const bads: Array<Record<string, string | undefined>> = [
      {},
      {
        ...good,
        IDDOC_ENC_KEYS: `1:${Buffer.alloc(16, 1).toString('base64')}`,
      },
      { ...good, IDDOC_ENC_ACTIVE_KEY: '9' },
      { ...good, IDDOC_BLIND_KEY: sameKey },
      { ...good, IDDOC_BLIND_KEY: undefined },
    ];
    for (const bad of bads) {
      await expect(bootWith(bad)).rejects.toThrow(
        /Invalid ID document crypto configuration/,
      );
    }
  });
});
