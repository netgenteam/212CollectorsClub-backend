import { Controller, Get, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { AppService, HealthStatus } from './app.service.js';

@ApiTags('health')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  /**
   * Liveness/readiness endpoint. Returns 200 only when the app can reach
   * the database (see AppService.checkHealth) — used as the real CI/CD
   * liveness check for later deploy stories.
   *
   * Decorated with @nestjs/swagger so it also serves as this story's smoke
   * test: the Swagger doc must reflect this route/shape automatically, with
   * no hand-maintained doc.
   */
  @Get('health')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Liveness/readiness check',
    description:
      'Returns 200 only when the app can reach the database; used as the CI/CD liveness check.',
  })
  @ApiResponse({
    status: HttpStatus.OK,
    description: 'The app and its database connection are healthy.',
    type: HealthStatus,
  })
  @ApiResponse({
    status: HttpStatus.SERVICE_UNAVAILABLE,
    description: 'The database is unreachable.',
  })
  getHealth(): Promise<HealthStatus> {
    return this.appService.checkHealth();
  }
}
