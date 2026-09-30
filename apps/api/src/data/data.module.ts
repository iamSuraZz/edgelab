import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { randomUUID } from 'node:crypto';

import type { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import {
  blockedNotice,
  coverageForAll,
  rateLimitStreak,
  copyBarsIgnoreDuplicates,
  bumpDataVersion,
  dailyBarCounts,
  findSymbolByCode,
  findSymbolById,
  listSymbols,
  updateSymbol,
  type DbClient,
  type StoredSymbol,
} from '@edgelab/db';
import {
  BinanceProvider,
  DukascopyProvider,
  RedisBudget,
  TwelveDataProvider,
  streamExnessZip,
  streamMt5Csv,
} from '@edgelab/data';
import {
  CandlesQuerySchema,
  DailyCountsQuerySchema,
  ImportRequestSchema,
  IngestRequestSchema,
  SymbolPatchBodySchema,
  type CandlesQuery,
  type DailyCountsQuery,
  type ImportRequestBody,
  type IngestRequestBody,
  type JobCreated,
  type SymbolPatch,
} from '@edgelab/shared';

import { CandlesService, type CandleResponse } from '../candles/candles.service';
import { ApiException } from '../common/api-error';
import { ZodPipe } from '../common/zod.pipe';
import { ConfigService } from '../config/config.service';
import { DB_CLIENT, REDIS_CLIENT } from '../infra/infra.module';
import { INGEST_QUEUE, QUEUE_NAME } from '../infra/queues.module';

/**
 * The Data page's API: what instruments exist, what data is stored for them, how to get more.
 */

export interface SymbolWithCoverage extends StoredSymbol {
  readonly coverage: {
    readonly barCount: number;
    readonly firstBar: number | null;
    readonly lastBar: number | null;
    readonly sources: readonly string[];
  };
}

@Injectable()
export class DataService {
  constructor(
    @Inject(DB_CLIENT) private readonly db: DbClient,
    @Inject(INGEST_QUEUE) private readonly ingestQueue: Queue,
    @Inject(CandlesService) private readonly candles: CandlesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(ConfigService) private readonly config: ConfigService,
  ) {}

  /**
   * Symbols with their coverage, in one pass.
   *
   * Coverage is joined here rather than left to the client because "which symbols have data"
   * is the first question the Data page asks, and answering it with N follow-up requests is
   * what makes that page feel slow.
   */
  async listSymbolsWithCoverage(): Promise<SymbolWithCoverage[]> {
    const [symbols, coverage] = await Promise.all([listSymbols(this.db), coverageForAll(this.db)]);
    const byCode = new Map(coverage.map((c) => [c.symbol, c]));

    return symbols.map((s) => {
      const c = byCode.get(s.symbol);
      return {
        ...s,
        coverage: {
          barCount: c?.barCount ?? 0,
          firstBar: c?.firstBar ?? null,
          lastBar: c?.lastBar ?? null,
          sources: c?.sources ?? [],
        },
      };
    });
  }

  async patchSymbol(id: string, patch: SymbolPatch): Promise<StoredSymbol> {
    const existing = await findSymbolById(this.db, id);
    if (existing === null) throw ApiException.notFound(`No symbol with id ${id}.`);

    const updated = await updateSymbol(this.db, id, patch);
    if (updated === null) throw ApiException.internal(`Symbol ${id} vanished mid-update.`);
    return updated;
  }

  /**
   * Coverage, plus a `blocked` line per symbol whose feed has been refusing us.
   *
   * Coverage alone says which bars exist; it cannot say why the rest do not. After three
   * consecutive rate-limited nights that distinction is the only thing worth reading — the gap is
   * not "still downloading", it is "the source is blocked" — so it travels with the coverage rather
   * than being buried in a nightly log nobody opens.
   */
  async coverage(): Promise<unknown> {
    const rows = await coverageForAll(this.db);

    return Promise.all(
      rows.map(async (row) => {
        const notices: string[] = [];
        for (const source of row.sources) {
          const notice = blockedNotice(
            source,
            await rateLimitStreak(this.db, row.symbolId, source),
          );
          if (notice !== null) notices.push(notice);
        }
        return notices.length === 0 ? row : { ...row, blocked: notices };
      }),
    );
  }

  /**
   * What each provider can do right now.
   *
   * Capabilities come from the adapters themselves rather than a list kept here, so a provider
   * cannot claim in the UI something its implementation does not do. The KEY is never returned,
   * only whether one is present (PROJECT.md's secrets rule) — `enabled` plus `disabledReason`
   * names the env var, never its value.
   *
   * Twelve Data's remaining credits come from the same Redis counters the fetcher spends, so the
   * figure on screen is the one that will actually refuse the next request rather than an estimate.
   */
  async providers(): Promise<unknown> {
    /*
     * Adapters constructed WITHOUT credentials, purely to read their capabilities.
     *
     * `ConfigService` has no getter for the provider key by design (PROJECT.md), so the API cannot
     * build a working Twelve Data client and should not pretend to. The adapter supplies the shape
     * — label, whether a key is needed, whether it carries spread, its rate limits — and config
     * supplies PRESENCE, which is the only thing about the key this side is allowed to know.
     */
    const adapters = [
      new DukascopyProvider({ cacheDir: this.config.dataCacheDir }),
      new BinanceProvider(),
      new TwelveDataProvider({ apiKey: '' }),
    ];

    const rows = await coverageForAll(this.db);
    const keyPresent = this.config.providerConfigured;

    return Promise.all(
      adapters.map(async (adapter) => {
        const declared = adapter.capabilities();
        // Only the key-dependent fields are overridden, and only for the adapter that needs one.
        const caps =
          declared.requiresKey && keyPresent
            ? { ...declared, enabled: true, disabledReason: undefined }
            : declared;

        /*
         * "Blocked since" is reported per PROVIDER here, not per symbol as coverage does (A11).
         * A provider rate-limited for three nights running is a fact about the source, and a card
         * that stays cheerfully green while every nightly job fails is the thing that made A11
         * necessary in the first place.
         */
        const blocked: string[] = [];
        for (const row of rows) {
          if (!row.sources.includes(caps.id)) continue;
          const notice = blockedNotice(
            caps.id,
            await rateLimitStreak(this.db, row.symbolId, caps.id),
          );
          if (notice !== null) blocked.push(`${row.symbol}: ${notice}`);
        }

        /*
         * The SAME counters the fetcher spends, so the number on screen is the one that will refuse
         * the next request — not an estimate of it. Meaningless without a key, hence null.
         */
        const limits = caps.rateLimit;
        const budget =
          caps.enabled && limits?.perMinute !== undefined && limits.perDay !== undefined
            ? await new RedisBudget(this.redis, caps.id, {
                perMinute: limits.perMinute,
                perDay: limits.perDay,
              }).status()
            : null;

        return { ...caps, budget, blocked };
      }),
    );
  }

  /** Per-day bar counts, for the calendar heatmap. */
  async dailyCounts(symbolCode: string, fromMs: number, toMs: number): Promise<unknown> {
    const symbol = await this.requireSymbol(symbolCode);
    return dailyBarCounts(this.db, symbol.id, fromMs, toMs);
  }

  async readCandles(query: CandlesQuery): Promise<CandleResponse> {
    const symbol = await this.requireSymbol(query.symbol);

    const response = await this.candles.get({
      symbol,
      timeframe: query.tf,
      fromMs: query.from,
      toMs: query.to,
    });

    // An empty result is not an error — an empty chart is a legitimate answer for a quiet
    // range — but a range entirely outside stored coverage is worth naming, because the fix is
    // to download data rather than to retry.
    if (response.count === 0) {
      const cov = (await coverageForAll(this.db)).find((c) => c.symbol === symbol.symbol);
      if (cov === undefined || cov.barCount === 0) {
        throw ApiException.noData(
          `No ${symbol.symbol} data stored at all. Download some with POST /api/data/ingest first.`,
          { symbol: symbol.symbol },
        );
      }
      if (cov.lastBar !== null && query.from > cov.lastBar) {
        throw ApiException.noData(
          `No ${symbol.symbol} data after ${isoDay(cov.lastBar)}. ` +
            `Stored coverage is ${isoDay(cov.firstBar ?? 0)} .. ${isoDay(cov.lastBar)}.`,
          { symbol: symbol.symbol, availableFrom: cov.firstBar, availableTo: cov.lastBar },
        );
      }
    }

    return response;
  }

  async enqueueIngest(body: IngestRequestBody): Promise<JobCreated> {
    const symbol = await this.requireSymbol(body.symbol);

    // Refuse here rather than letting the job fail: the provider is either configured for
    // this symbol or it is not, and that is knowable without queueing anything.
    if (symbol.providerSymbols[body.provider] === undefined) {
      throw ApiException.validation(
        `${symbol.symbol} has no instrument id for provider "${body.provider}". ` +
          `Configured providers: ${Object.keys(symbol.providerSymbols).join(', ') || 'none'}.`,
        { symbol: symbol.symbol, provider: body.provider },
      );
    }

    // A unique id, not BullMQ's per-queue counter — see `newJobId` in backtests.module.ts (A57).
    const job = await this.ingestQueue.add(
      QUEUE_NAME.ingest,
      {
        symbolCode: symbol.symbol,
        provider: body.provider,
        fromMs: body.from,
        toMs: body.to,
        force: body.force,
      },
      { jobId: randomUUID() },
    );

    const jobId = String(job.id);
    return { jobId, queue: QUEUE_NAME.ingest, eventsUrl: `/api/jobs/${jobId}/events` };
  }

  /**
   * Import an uploaded file.
   *
   * Runs INLINE rather than through the queue, because the file lives in this process's
   * memory: handing the job to the worker would mean shipping the bytes through Redis or a
   * shared volume. Parsing is streamed from a temp file so a 500 MB tick export is never held
   * whole, and the temp file is removed in `finally` whatever happens.
   */
  async importFile(
    body: ImportRequestBody,
    file: { originalname: string; buffer: Buffer },
  ): Promise<{ symbol: string; rows: number; inserted: number; duplicates: number }> {
    const symbol = await this.requireSymbol(body.symbol);

    if (body.format === 'generic-csv') {
      throw ApiException.unsupported(
        'The generic CSV importer is not wired to this endpoint yet. Use --format mt5-csv, ' +
          'or `pnpm run import:file` for other layouts.',
      );
    }

    const dir = await mkdtemp(path.join(tmpdir(), 'edgelab-import-'));
    const filePath = path.join(dir, path.basename(file.originalname) || `upload-${randomUUID()}`);

    let inserted = 0;
    let duplicates = 0;

    try {
      await writeFile(filePath, file.buffer);

      const store = async (bars: Parameters<typeof copyBarsIgnoreDuplicates>[1]['bars']) => {
        const result = await copyBarsIgnoreDuplicates(this.db, {
          symbolId: symbol.id,
          source: body.format === 'mt5-csv' ? 'mt5-csv' : 'exness-ticks',
          bars,
        });
        inserted += result.inserted;
        duplicates += result.duplicates;
      };

      // The two importers report different stat shapes — MT5 counts CSV rows, Exness counts
      // ticks — so the response reports whichever the format produced rather than inventing a
      // common field that would mean different things.
      const rows =
        body.format === 'mt5-csv'
          ? (
              await streamMt5Csv(
                filePath,
                {
                  serverUtcOffsetMinutes: body.serverUtcOffsetMinutes,
                  mintick: symbol.mintick,
                },
                store,
              )
            ).rows
          : (await streamExnessZip(filePath, {}, store)).ticks;

      if (inserted > 0) await bumpDataVersion(this.db, symbol.id);

      return { symbol: symbol.symbol, rows, inserted, duplicates };
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw ApiException.validation(`Could not import ${file.originalname}: ${message}`);
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async requireSymbol(code: string): Promise<StoredSymbol> {
    const symbol = await findSymbolByCode(this.db, code);
    if (symbol === null) {
      throw ApiException.notFound(
        `No symbol "${code}". Check GET /api/symbols for what is configured.`,
      );
    }
    return symbol;
  }
}

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

@Controller()
export class DataController {
  constructor(@Inject(DataService) private readonly data: DataService) {}

  @Get('symbols')
  symbols(): Promise<SymbolWithCoverage[]> {
    return this.data.listSymbolsWithCoverage();
  }

  @Patch('symbols/:id')
  patchSymbol(
    @Param('id') id: string,
    @Body(new ZodPipe(SymbolPatchBodySchema)) patch: SymbolPatch,
  ): Promise<StoredSymbol> {
    return this.data.patchSymbol(id, patch);
  }

  @Get('candles')
  candles(@Query(new ZodPipe(CandlesQuerySchema)) query: CandlesQuery): Promise<CandleResponse> {
    return this.data.readCandles(query);
  }

  @Get('data/providers')
  providers(): Promise<unknown> {
    return this.data.providers();
  }

  @Get('data/coverage')
  coverage(): Promise<unknown> {
    return this.data.coverage();
  }

  @Get('data/daily-counts')
  dailyCounts(
    @Query(new ZodPipe(DailyCountsQuerySchema)) query: DailyCountsQuery,
  ): Promise<unknown> {
    return this.data.dailyCounts(query.symbol, query.from, query.to);
  }

  @Post('data/ingest')
  ingest(@Body(new ZodPipe(IngestRequestSchema)) body: IngestRequestBody): Promise<JobCreated> {
    return this.data.enqueueIngest(body);
  }

  @Post('data/import')
  @UseInterceptors(
    FileInterceptor('file', {
      // Tick ZIPs are large; the cap is a guard against a runaway upload, not a target.
      limits: { fileSize: 512 * 1024 * 1024 },
    }),
  )
  import(
    @Body(new ZodPipe(ImportRequestSchema)) body: ImportRequestBody,
    @UploadedFile() file?: { originalname: string; buffer: Buffer },
  ): Promise<{ symbol: string; rows: number; inserted: number; duplicates: number }> {
    if (file === undefined) {
      throw ApiException.validation('No file uploaded. Send the file as multipart field "file".');
    }
    return this.data.importFile(body, file);
  }
}

@Module({
  controllers: [DataController],
  providers: [DataService, CandlesService],
  exports: [DataService, CandlesService],
})
export class DataModule {}
