import { Prisma } from '../generated/prisma/client.js';
import { LandingBlocksService } from './landing-blocks.service.js';

describe('LandingBlocksService.publishRow (concurrent PUT safety)', () => {
  it('promotes the read draft but clears only if draftUpdatedAt is unchanged', async () => {
    const readAt = new Date('2026-01-01T00:00:00.000Z');
    const tx = {
      landingConfigEntry: {
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findUniqueOrThrow: vi.fn().mockResolvedValue({ key: 'ticker' }),
      },
    };
    const service = new LandingBlocksService(
      {} as never,
      {} as never,
      {} as never,
    );
    await (
      service as unknown as {
        publishRow: (...a: unknown[]) => Promise<unknown>;
      }
    ).publishRow(
      tx,
      { key: 'ticker', draftValue: { items: [] }, draftUpdatedAt: readAt },
      'admin-1',
    );

    const upd = tx.landingConfigEntry.update.mock.calls[0][0] as {
      data: Record<string, unknown>;
    };
    expect(upd.data.value).toEqual({ items: [] });
    // The promotion itself never clears the draft.
    expect(upd.data).not.toHaveProperty('draftValue');
    expect(tx.landingConfigEntry.updateMany).toHaveBeenCalledWith({
      where: { section: 'home', key: 'ticker', draftUpdatedAt: readAt },
      data: {
        draftValue: Prisma.DbNull,
        draftUpdatedAt: null,
        draftUpdatedById: null,
      },
    });
  });
});
