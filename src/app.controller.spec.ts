import { Test, TestingModule } from '@nestjs/testing';
import { ServiceUnavailableException } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';

describe('AppController', () => {
  let appController: AppController;
  let appService: { checkHealth: () => Promise<unknown> };

  beforeEach(async () => {
    appService = {
      checkHealth: vi.fn(),
    };

    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [{ provide: AppService, useValue: appService }],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('GET /api/v1/health', () => {
    it('returns the health payload when the database is reachable', async () => {
      const payload = {
        status: 'ok',
        database: 'up',
        timestamp: new Date().toISOString(),
      };
      vi.mocked(appService.checkHealth).mockResolvedValue(payload);

      await expect(appController.getHealth()).resolves.toEqual(payload);
    });

    it('propagates a 503 when the database is unreachable', async () => {
      vi.mocked(appService.checkHealth).mockRejectedValue(
        new ServiceUnavailableException('Database is unreachable'),
      );

      await expect(appController.getHealth()).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
    });
  });
});
