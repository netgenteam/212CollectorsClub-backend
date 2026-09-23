import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service.js';

export interface HealthStatus {
  status: 'ok';
  database: 'up';
  timestamp: string;
}

@Injectable()
export class AppService {
  private readonly logger = new Logger(AppService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Liveness check used by GET /health. Only returns successfully when the
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
