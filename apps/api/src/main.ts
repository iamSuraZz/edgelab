import 'reflect-metadata';
import process from 'node:process';
import { Logger, RequestMethod } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ApiErrorFilter } from './common/error.filter';
import { ConfigService } from './config/config.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);
  const logger = new Logger('Bootstrap');

  // Feature routes live under /api; health stays at the root so probes and the
  // spec'd `GET /health` both hit it directly.
  app.setGlobalPrefix('api', {
    exclude: [{ path: 'health', method: RequestMethod.GET }],
  });
  // One error shape for every failure, so a client never handles two.
  app.useGlobalFilters(new ApiErrorFilter());
  app.enableCors({ origin: [`http://localhost:${config.webPort}`], credentials: true });
  app.enableShutdownHooks();

  await app.listen(config.apiPort);

  logger.log(`API listening on http://localhost:${config.apiPort}`);
  logger.log(`Health: http://localhost:${config.apiPort}/health`);
  logger.log(`Market-data provider configured: ${String(config.providerConfigured)}`);
}

bootstrap().catch((err: unknown) => {
  // Config validation failures land here. The message names keys, never values.
  console.error('API failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
