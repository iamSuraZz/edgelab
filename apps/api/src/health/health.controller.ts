import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import type { HealthResponse } from '@edgelab/shared';
import { HealthService } from './health.service';

@Controller('health')
export class HealthController {
  /**
   * The explicit @Inject token is required, not decorative: dev runs under tsx
   * (esbuild), which cannot emit `design:paramtypes` metadata, so Nest has nothing to
   * infer the dependency from. See PROJECT.md — every injected constructor parameter in
   * this app carries an explicit token.
   */
  constructor(@Inject(HealthService) private readonly health: HealthService) {}

  /**
   * GET /health — verifies Postgres and Redis are actually reachable.
   *
   * A degraded result is thrown as 503 so orchestrators and `curl --fail` treat it as
   * down. Passing the object to the exception keeps it as the verbatim response body,
   * so callers still see which dependency failed.
   */
  @Get()
  async check(): Promise<HealthResponse> {
    const result = await this.health.check();
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException(result);
    }
    return result;
  }
}
