import { Module } from '@nestjs/common';

import { BacktestsModule } from './backtests/backtests.module';
import { ConfigModule } from './config/config.module';
import { DataModule } from './data/data.module';
import { HealthModule } from './health/health.module';
import { InfraModule } from './infra/infra.module';
import { JobsModule } from './jobs/jobs.module';
import { PineModule } from './pine/pine.module';
import { QueuesModule } from './infra/queues.module';
import { StrategiesModule } from './strategies/strategies.module';

@Module({
  imports: [
    ConfigModule,
    InfraModule,
    QueuesModule,
    HealthModule,
    PineModule,
    StrategiesModule,
    BacktestsModule,
    DataModule,
    JobsModule,
  ],
})
export class AppModule {}
