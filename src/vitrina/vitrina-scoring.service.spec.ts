import { Prisma } from '../generated/prisma/client.js';
import { AdminVitrinaService } from './admin-vitrina.service.js';
import { UpdateVitrinaAlgorithmDto } from './dto/admin-vitrina.dto.js';
import { VitrinaCronService } from './vitrina-cron.service.js';
import { toScoringConfig } from './vitrina-settings.js';
import type { SettingRow } from './vitrina-settings.js';

const row: SettingRow = {
  wSales: 40,
  wRevenue: 15,
  wVelocity: 15,
  wInterest: 20,
  wNovelty: 10,
  halfLifeDays: 14,
  windowDays: 90,
  noveltyDays: 21,
  maxPerFranchise: 4,
  mmrLambda: new Prisma.Decimal('0.35'),
  priorM: new Prisma.Decimal('3.00'),
  scarcityThreshold: 3,
  minSalesForRanking: 5,
  viewDayCap: 30,
  currentRunId: null,
  updatedAt: new Date(0),
  updatedById: null,
};

describe('toScoringConfig', () => {
  it('maps Decimals to numbers and drops pointer/audit columns', () => {
    const c = toScoringConfig(row);
    expect(c.mmrLambda).toBe(0.35);
    expect(c.priorM).toBe(3);
    expect(c).not.toHaveProperty('currentRunId');
    expect(Object.keys(c)).toHaveLength(14);
  });
});

describe('VitrinaCronService.isEnabled', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });
  const svc = () => new VitrinaCronService({} as never, {} as never);
  it('explicit true/false wins; default is on outside tests', () => {
    process.env.VITRINA_CRON_ENABLED = 'true';
    expect(svc().isEnabled()).toBe(true);
    process.env.VITRINA_CRON_ENABLED = 'false';
    expect(svc().isEnabled()).toBe(false);
    delete process.env.VITRINA_CRON_ENABLED;
    process.env.NODE_ENV = 'production';
    expect(svc().isEnabled()).toBe(true);
    process.env.NODE_ENV = 'test';
    expect(svc().isEnabled()).toBe(false);
  });
});

describe('AdminVitrinaService weights guard', () => {
  it('rejects a sum != 100 before touching the DB (VITRINA_WEIGHTS_INVALID)', async () => {
    const prisma = { $transaction: vi.fn() };
    const svc = new AdminVitrinaService(
      prisma as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const dto = Object.assign(new UpdateVitrinaAlgorithmDto(), {
      wSales: 50,
      wRevenue: 15,
      wVelocity: 15,
      wInterest: 20,
      wNovelty: 10,
    });
    await expect(svc.updateAlgorithm(dto, 'a')).rejects.toMatchObject({
      status: 400,
      response: { errorCode: 'VITRINA_WEIGHTS_INVALID' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
