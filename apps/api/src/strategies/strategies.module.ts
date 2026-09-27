import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Module,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import {
  listStrategies,
  readStrategy,
  readStrategyVersion,
  setStrategyTags,
  touchStrategy,
  updateStrategyMeta,
  upsertStrategyVersion,
  type DbClient,
} from '@edgelab/db';
import {
  CreateStrategySchema,
  CreateStrategyVersionSchema,
  UpdateStrategySchema,
  type CreateStrategy,
  type CreateStrategyVersion,
  type StrategySummary,
  type StrategyVersionSource,
  type UpdateStrategy,
} from '@edgelab/shared';

import { ApiException } from '../common/api-error';
import { ZodPipe } from '../common/zod.pipe';
import { DB_CLIENT } from '../infra/infra.module';
import { PineModule, PineService } from '../pine/pine.module';

/**
 * Strategies and their versions.
 *
 * The version rule from spec 04 — "Save creates a new version when the source hash changes" —
 * lives in `upsertStrategyVersion`, keyed on the sha256 of the source. Saving an unchanged
 * script therefore returns the existing version rather than piling up duplicates, which is what
 * makes pressing Save twice harmless and lets a run always point at a stored version.
 */

@Injectable()
export class StrategiesService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    // Explicit token even for a class dependency: the apps run under tsx/esbuild, which does
    // not emit `design:paramtypes`, so Nest has nothing to infer from. See engineering-notes.
    @Inject(PineService) private readonly pine: PineService,
  ) {}

  async list(): Promise<StrategySummary[]> {
    const rows = await listStrategies(this.db.db);
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      notes: r.notes,
      tags: r.tags,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      versionCount: r.versionCount,
      latestVersion:
        r.latestVersion === null
          ? null
          : {
              id: r.latestVersion.id,
              version: r.latestVersion.version,
              sourceHash: r.latestVersion.sourceHash,
              pineVersion: r.latestVersion.pineVersion === 'v6' ? 'v6' : 'v5',
              title: r.latestVersion.title,
              createdAt: r.latestVersion.createdAt,
            },
    }));
  }

  async get(id: string): Promise<Awaited<ReturnType<typeof readStrategy>>> {
    const strategy = await readStrategy(this.db.db, id);
    if (strategy === null) throw ApiException.notFound(`No strategy with id ${id}.`);
    return strategy;
  }

  /**
   * Create a strategy and its first version.
   *
   * The source is compiled first so the stored version records the real Pine version and
   * declared title rather than a guess — and so a script that cannot compile at all is
   * rejected here instead of failing later inside a job, where the feedback is worse.
   */
  async create(
    body: CreateStrategy,
  ): Promise<{ strategyId: string; versionId: string; version: number }> {
    const compiled = this.pine.compile(body.source);
    if (!compiled.ok) {
      throw ApiException.compileFailed(
        `"${body.name}" does not compile: ${firstError(compiled.diagnostics)}`,
        { diagnostics: compiled.diagnostics },
      );
    }

    const ref = await upsertStrategyVersion(this.db.db, {
      name: body.name,
      pineSource: body.source,
      pineVersion: compiled.meta.version === 6 ? 'v6' : 'v5',
      title: compiled.meta.title,
      notes: body.notes ?? null,
    });

    if (body.tags.length > 0) {
      await setStrategyTags(this.db.db, ref.strategyId, body.tags);
    }

    return { strategyId: ref.strategyId, versionId: ref.versionId, version: ref.version };
  }

  /** Add a version to an existing strategy; a no-op when the source is unchanged. */
  async addVersion(
    strategyId: string,
    body: CreateStrategyVersion,
  ): Promise<{ versionId: string; version: number; created: boolean }> {
    const strategy = await readStrategy(this.db.db, strategyId);
    if (strategy === null) throw ApiException.notFound(`No strategy with id ${strategyId}.`);

    const compiled = this.pine.compile(body.source);
    if (!compiled.ok) {
      throw ApiException.compileFailed(
        `New version of "${strategy.name}" does not compile: ${firstError(compiled.diagnostics)}`,
        { diagnostics: compiled.diagnostics },
      );
    }

    const ref = await upsertStrategyVersion(this.db.db, {
      name: strategy.name,
      pineSource: body.source,
      pineVersion: compiled.meta.version === 6 ? 'v6' : 'v5',
      title: compiled.meta.title,
    });

    await touchStrategy(this.db.db, strategyId);

    return { versionId: ref.versionId, version: ref.version, created: ref.created };
  }

  /**
   * One version's source, for the diff view and `.pine` export.
   *
   * Checks the version belongs to the strategy in the path rather than trusting the id alone:
   * otherwise `/strategies/A/versions/<a version of B>` would quietly serve B's source, and the
   * Library would show a diff between two unrelated scripts with no hint anything was wrong.
   */
  async readVersion(strategyId: string, versionId: string): Promise<StrategyVersionSource> {
    const version = await readStrategyVersion(this.db.db, versionId);
    if (version === null) throw ApiException.notFound(`No version with id ${versionId}.`);
    if (version.strategyId !== strategyId) {
      throw ApiException.notFound(
        `Version ${versionId} does not belong to strategy ${strategyId}.`,
      );
    }

    return {
      id: version.id,
      strategyId: version.strategyId,
      version: version.version,
      source: version.pineSource,
    };
  }

  /** Rename, re-tag or annotate. Absent fields are left alone; `notes: null` clears them. */
  async update(strategyId: string, body: UpdateStrategy): Promise<StrategySummary> {
    const existing = await readStrategy(this.db.db, strategyId);
    if (existing === null) throw ApiException.notFound(`No strategy with id ${strategyId}.`);

    if (body.tags !== undefined) await setStrategyTags(this.db.db, strategyId, body.tags);
    if (body.name !== undefined || body.notes !== undefined) {
      await updateStrategyMeta(this.db.db, strategyId, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.notes === undefined ? {} : { notes: body.notes }),
      });
    }

    const updated = await readStrategy(this.db.db, strategyId);
    if (updated === null) throw ApiException.notFound(`No strategy with id ${strategyId}.`);
    return {
      id: updated.id,
      name: updated.name,
      notes: updated.notes,
      tags: updated.tags,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
      versionCount: updated.versionCount,
      latestVersion:
        updated.latestVersion === null
          ? null
          : {
              id: updated.latestVersion.id,
              version: updated.latestVersion.version,
              sourceHash: updated.latestVersion.sourceHash,
              pineVersion: updated.latestVersion.pineVersion === 'v6' ? 'v6' : 'v5',
              title: updated.latestVersion.title,
              createdAt: updated.latestVersion.createdAt,
            },
    };
  }
}

function firstError(diagnostics: readonly { severity: string; message: string }[]): string {
  return diagnostics.find((d) => d.severity === 'error')?.message ?? 'unknown error';
}

@Controller('strategies')
export class StrategiesController {
  constructor(@Inject(StrategiesService) private readonly strategies: StrategiesService) {}

  @Get()
  list(): Promise<StrategySummary[]> {
    return this.strategies.list();
  }

  @Get(':id')
  get(@Param('id') id: string): Promise<unknown> {
    return this.strategies.get(id);
  }

  @Post()
  create(
    @Body(new ZodPipe(CreateStrategySchema)) body: CreateStrategy,
  ): Promise<{ strategyId: string; versionId: string; version: number }> {
    return this.strategies.create(body);
  }

  @Post(':id/versions')
  addVersion(
    @Param('id') id: string,
    @Body(new ZodPipe(CreateStrategyVersionSchema)) body: CreateStrategyVersion,
  ): Promise<{ versionId: string; version: number; created: boolean }> {
    return this.strategies.addVersion(id, body);
  }

  @Get(':id/versions/:versionId')
  readVersion(
    @Param('id') id: string,
    @Param('versionId') versionId: string,
  ): Promise<StrategyVersionSource> {
    return this.strategies.readVersion(id, versionId);
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body(new ZodPipe(UpdateStrategySchema)) body: UpdateStrategy,
  ): Promise<StrategySummary> {
    return this.strategies.update(id, body);
  }
}

@Module({
  // PineModule, because StrategiesService compiles before it stores. Without this import Nest
  // cannot resolve PineService and the whole API fails to boot — which is what the e2e run
  // caught: the module had never been started against a real stack.
  imports: [PineModule],
  controllers: [StrategiesController],
  providers: [StrategiesService],
  exports: [StrategiesService],
})
export class StrategiesModule {}
