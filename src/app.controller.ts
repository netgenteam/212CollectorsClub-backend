import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { AppService, HealthStatus } from './app.service.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Liveness/readiness endpoint. Returns 200 only when the app can reach
   * the database (see AppService.checkHealth) — used as the real CI/CD
   * liveness check for later deploy stories.
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  getHealth(): Promise<HealthStatus> {
    return this.appService.checkHealth();
  }
}
