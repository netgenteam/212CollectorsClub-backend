import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import { PrismaService } from './prisma/prisma.service.js';

// A class (not a plain interface) so @nestjs/swagger can read its
// @ApiProperty metadata at runtime and reflect the real response shape in
// the generated OpenAPI doc — an interface has no metadata to introspect.
export class HealthStatus {
  @ApiProperty({
    enum: ['ok'],
    example: 'ok',
    description: 'Overall liveness status of the app.',
  })
  status: 'ok';

  @ApiProperty({
    enum: ['up'],
    example: 'up',
    description: 'Database connectivity status.',
  })
  database: 'up';

  @ApiProperty({
    example: '2026-09-22T10:00:00.000Z',
    description: 'ISO-8601 UTC timestamp of the check.',
  })
  timestamp: string;
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness check used by GET /api/v1/health. Only returns successfully when the
   * app can actually reach the database — a real check, not a static 200.
   */
  async checkHealth(): Promise<HealthStatus> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      this.logger.error('Health check failed: database unreachable', error);
      throw new ServiceUnavailableException('Database is unreachable');
    }

    return {
      status: 'ok',
      database: 'up',
      timestamp: new Date().toISOString(),
    };
  }
}
