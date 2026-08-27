import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/public.decorator';
import { DatabaseService } from '../database/database.service';

@ApiTags('System')
@Controller()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(private readonly database: DatabaseService) {}

  @Public()
  @Get('health')
  @ApiOperation({ summary: 'Liveness and database readiness probe' })
  async health() {
    const database = await this.database.ping().catch(() => false);
    return {
      status: database ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      dependencies: { database: database ? 'up' : 'down' },
      timestamp: new Date().toISOString(),
    };
  }
}
