import { Global, Module } from '@nestjs/common';
import process from 'node:process';
import { loadDotEnvFile, loadEnv } from '@edgelab/shared/config';
import { ConfigService } from './config.service';

/**
 * The only place process.env is read. Validation happens once at boot, so a
 * misconfigured deployment fails immediately and loudly rather than at first use.
 *
 * The .env load happens here rather than in main.ts so that any entrypoint — including
 * e2e tests instantiating the module directly — gets the same configuration.
 */
@Global()
@Module({
  providers: [
    {
      provide: ConfigService,
      useFactory: (): ConfigService => {
        loadDotEnvFile();
        return new ConfigService(loadEnv(process.env));
      },
    },
  ],
  exports: [ConfigService],
})
export class ConfigModule {}
