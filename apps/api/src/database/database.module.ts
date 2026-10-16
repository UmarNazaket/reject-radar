import { type DynamicModule, Global, Inject, Module, type OnModuleDestroy } from '@nestjs/common';
import { createDb, createPool } from '@rejectradar/db';
import type { Pool } from 'pg';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');

@Global()
@Module({})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  static register(connectionString: string): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        // pg connects lazily, so creating the pool never touches the database.
        { provide: PG_POOL, useFactory: () => createPool(connectionString) },
        { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool) => createDb(pool) },
      ],
      exports: [PG_POOL, DB],
    };
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
