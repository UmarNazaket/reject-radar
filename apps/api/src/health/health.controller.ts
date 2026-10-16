import { Controller, Get, HttpStatus, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { AppError } from '../common/errors';
import { PG_POOL } from '../database/database.module';

@Controller('health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Liveness: never touches the database, so health checks don't wake Neon (spec §15). */
  @Get()
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready(): Promise<{ status: 'ready' }> {
    try {
      await this.pool.query('select 1');
      return { status: 'ready' };
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'DB_UNAVAILABLE', 'Database is not reachable');
    }
  }
}
