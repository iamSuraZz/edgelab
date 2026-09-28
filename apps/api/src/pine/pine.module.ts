import { Body, Controller, Get, Inject, Injectable, Module, Post } from '@nestjs/common';
import { readM1Bars, type DbClient } from '@edgelab/db';
import { PineTsEngine, STRATEGY_FIXTURES, type Diagnostic, type InputSpec } from '@edgelab/engine';
import { CompileRequestSchema, getSeedSymbol, type CompileRequest } from '@edgelab/shared';

import { ZodPipe } from '../common/zod.pipe';
import { DB_CLIENT } from '../infra/infra.module';

/**
 * Compilation is a pure function of the source, so it runs INLINE rather than through the
 * queue: it takes a few milliseconds, and the editor calls it on every debounced keystroke.
 * Round-tripping that through Redis would add latency to the one interaction that has to feel
 * instant, for no isolation benefit — `compile()` transpiles but never executes user code.
 */

export interface CompileResponse {
  readonly ok: boolean;
  readonly diagnostics: readonly Diagnostic[];
  readonly meta: {
    readonly kind: 'strategy' | 'indicator' | null;
    readonly version: number | null;
    readonly title: string | null;
    readonly inputs: readonly InputSpec[];
    readonly declaredProps: readonly { name: string; value: unknown; mutable: boolean }[];
  };
  /** Warnings split out, since the Compatibility panel shows them separately from errors. */
  readonly errorCount: number;
  readonly warningCount: number;
}

@Injectable()
export class PineService {
  private readonly engine: PineTsEngine;

  constructor(@Inject(DB_CLIENT) db: DbClient) {
    // compile() never touches bars, but the engine's constructor wants a source. Wiring the
    // real one anyway means this same instance could run a dry-run later without a second
    // construction path that might diverge.
    this.engine = new PineTsEngine({
      m1: {
        readM1: async (symbolCode, fromMs, toMs) => {
          const { findSymbolByCode } = await import('@edgelab/db');
          const symbol = await findSymbolByCode(db, symbolCode);
          return symbol === null ? [] : readM1Bars(db, symbol.id, fromMs, toMs);
        },
      },
      lookupSymbol: (code) => {
        try {
          return getSeedSymbol(code);
        } catch {
          return undefined;
        }
      },
    });
  }

  compile(source: string): CompileResponse {
    const result = this.engine.compile(source);
    const errorCount = result.diagnostics.filter((d) => d.severity === 'error').length;

    return {
      ok: result.ok,
      diagnostics: result.diagnostics,
      meta: {
        kind: result.meta.kind,
        version: result.meta.version,
        title: result.meta.title,
        // Keyed on varId by construction — see the InputSpec note in docs/pinets-notes.md on
        // why title is not usable as a key.
        inputs: result.meta.inputs,
        declaredProps: result.meta.declaredProps,
      },
      errorCount,
      warningCount: result.diagnostics.length - errorCount,
    };
  }
}

@Controller('pine')
export class PineController {
  constructor(@Inject(PineService) private readonly pine: PineService) {}

  /**
   * A script that fails to compile is NOT an HTTP error: the editor calls this constantly
   * while you are mid-word, and 422-ing every keystroke would make the client treat normal
   * typing as failure. The diagnostics are the payload.
   */
  @Post('compile')
  compile(@Body(new ZodPipe(CompileRequestSchema)) body: CompileRequest): CompileResponse {
    return this.pine.compile(body.source);
  }

  /**
   * The shipped example strategies, for the Studio dropdown.
   *
   * GET, not POST. It was POST, and the web client has always called it with GET — so the route
   * 404'd, the dropdown was permanently empty, and the Studio could not load an example at all.
   * Invisible until the browser tests were first run against a live API.
   */
  @Get('fixtures')
  fixtures(): { id: string; name: string; description: string; source: string }[] {
    return STRATEGY_FIXTURES.map((f) => ({
      id: f.id,
      name: f.name,
      description: f.description,
      source: f.source,
    }));
  }
}

@Module({
  controllers: [PineController],
  providers: [PineService],
  exports: [PineService],
})
export class PineModule {}
