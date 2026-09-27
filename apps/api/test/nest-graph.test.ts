import 'reflect-metadata';

import {
  MODULE_METADATA,
  OPTIONAL_DEPS_METADATA,
  SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';
import { ConfigService } from '../src/config/config.service';
import { ZodPipe } from '../src/common/zod.pipe';

/**
 * The boot guard.
 *
 * This exists because the API once could not start AT ALL and nothing noticed. Seven constructors
 * took a class-typed dependency with no `@Inject`, and `StrategiesModule` never imported the module
 * providing `PineService`; Nest aborted the process on startup. `pnpm typecheck` cannot see it —
 * the types are perfectly correct, it is the RUNTIME metadata that is missing — and no test built
 * the Nest graph, so the defect survived every green suite until the e2e run was first executed
 * against a live stack.
 *
 * TWO INDEPENDENT ASSERTIONS, because neither alone is sufficient:
 *
 *  1. `bootsTheWholeGraph` constructs AppModule for real. This catches a missing module import and
 *     an unprovidable token.
 *
 *  2. `everyDependencyIsExplicit` walks the graph statically and demands that every constructor
 *     parameter of every DI-constructed class carries an explicit `@Inject`.
 *
 * Assertion 2 is not belt-and-braces; it is the one that catches the original bug reliably.
 * Measured: with decorator metadata ABSENT — which is what `tsx` gives dev, because esbuild
 * silently ignores `emitDecoratorMetadata` — Nest reads `design:paramtypes` as empty, concludes the
 * class has no dependencies, and constructs it with `undefined` arguments. `init()` SUCCEEDS. The
 * service then explodes later at the first property access, far from the cause.
 *
 * And the mirror image is just as bad: under vitest the transform is oxc, which DOES honour
 * `emitDecoratorMetadata` from `apps/api/tsconfig.json`. So a boot-only test would resolve
 * `PineService` from type metadata that dev does not have, pass happily, and certify a broken app.
 *
 * Assertion 2 sidesteps the whole question. `self:paramtypes` is written by the `@Inject` decorator
 * itself, so it is present under every transform, and the test behaves identically whichever one
 * runs it.
 */

/**
 * Classes that carry `@Injectable()` but are constructed BY HAND, so their parameters are arguments
 * rather than dependencies and must not be required to have `@Inject`.
 *
 * `ConfigService` is built by a `useFactory` with a parsed env object; `ZodPipe` is always
 * `new ZodPipe(SomeSchema)` at the call site.
 */
const HAND_CONSTRUCTED: readonly unknown[] = [ConfigService, ZodPipe];

interface ClassLike {
  readonly name: string;
  readonly length: number;
}

/** A provider entry that Nest constructs itself, i.e. a bare class rather than a custom provider. */
function isDiConstructedClass(entry: unknown): entry is ClassLike {
  if (typeof entry !== 'function') return false;
  // `useFactory` / `useValue` / `useClass` providers are objects, already excluded by the above.
  return !HAND_CONSTRUCTED.includes(entry);
}

function readModuleMetadata(mod: unknown, key: string): unknown[] {
  const value: unknown = Reflect.getMetadata(key, mod as object);
  return Array.isArray(value) ? value : [];
}

/**
 * Every DI-constructed class reachable from a root module, following `imports` transitively.
 *
 * Derived from the module graph rather than by scanning files for `@Injectable()`, because the
 * graph is what Nest actually instantiates — and scanning would pick up the hand-constructed
 * classes above and anything else decorated but unregistered.
 */
function collectGraphClasses(root: unknown): ClassLike[] {
  const seenModules = new Set<unknown>();
  const classes = new Map<string, ClassLike>();

  const walk = (mod: unknown): void => {
    if (mod === undefined || mod === null || seenModules.has(mod)) return;
    seenModules.add(mod);

    for (const key of [MODULE_METADATA.PROVIDERS, MODULE_METADATA.CONTROLLERS]) {
      for (const entry of readModuleMetadata(mod, key)) {
        if (isDiConstructedClass(entry)) classes.set(entry.name, entry);
      }
    }

    for (const imported of readModuleMetadata(mod, MODULE_METADATA.IMPORTS)) {
      walk(imported);
    }
  };

  walk(root);
  return [...classes.values()];
}

/** Parameter indices the class declares an explicit `@Inject` (or `@Optional`) for. */
function explicitlyInjectedIndices(cls: ClassLike): Set<number> {
  const declared: unknown = Reflect.getMetadata(SELF_DECLARED_DEPS_METADATA, cls as object);
  const optional: unknown = Reflect.getMetadata(OPTIONAL_DEPS_METADATA, cls as object);

  const indices = new Set<number>();
  for (const source of [declared, optional]) {
    if (!Array.isArray(source)) continue;
    for (const item of source as { index?: unknown }[]) {
      if (typeof item.index === 'number') indices.add(item.index);
    }
  }
  return indices;
}

describe('the Nest module graph', () => {
  let close: (() => Promise<void>) | null = null;

  afterEach(async () => {
    // Redis and BullMQ providers dial out at construction (`lazyConnect: false`), leaving reconnect
    // timers behind. `app.close()` is what clears them; without it the run can hang.
    if (close !== null) {
      await close();
      close = null;
    }
  });

  it('boots the whole graph, catching a missing module import', async () => {
    /*
     * `abortOnError: false` is mandatory, not tidiness. Nest 12's default error handler calls
     * `process.abort()`, which kills the vitest worker with exit code 134 and a native V8 stack
     * instead of a failed assertion — you get "Worker exited unexpectedly" and no idea why.
     * With it, a DI failure rejects with a readable UnknownDependenciesException naming the class,
     * the parameter index and the module.
     */
    const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    close = () => app.close();

    await app.init();

    // Reaching here IS the assertion: every module resolved and every token was providable.
    expect(app).toBeDefined();
  });

  it('requires an explicit @Inject on every constructor parameter', () => {
    const classes = collectGraphClasses(AppModule);

    // Guard the guard: if the graph walk silently found nothing, the rest of this test would pass
    // vacuously forever.
    expect(
      classes.length,
      'the module walk found no classes — the walk itself is broken',
    ).toBeGreaterThan(8);

    const offenders: string[] = [];

    for (const cls of classes) {
      const injected = explicitlyInjectedIndices(cls);
      for (let index = 0; index < cls.length; index += 1) {
        if (!injected.has(index)) {
          offenders.push(`${cls.name} parameter ${String(index)}`);
        }
      }
    }

    expect(
      offenders,
      'These constructor parameters have no @Inject token. The apps run under tsx/esbuild, which ' +
        'does not emit design:paramtypes, so Nest has nothing to infer the dependency from and ' +
        'will inject undefined without complaint. Add @Inject(Token).\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });

  it('finds the classes it claims to, including ones only reachable via imports', () => {
    // PineService is provided by PineModule, which is reachable ONLY through
    // `imports: [PineModule]` on two modules. If the transitive walk broke, this is what notices.
    const names = collectGraphClasses(AppModule).map((c) => c.name);

    expect(names).toContain('PineService');
    expect(names).toContain('StrategiesService');
    expect(names).toContain('BacktestsService');
    expect(names).toContain('JobsService');
    expect(names).toContain('CandlesService');

    // And it must NOT include the hand-constructed ones, or the check above would demand @Inject
    // on plain constructor arguments.
    expect(names).not.toContain('ConfigService');
    expect(names).not.toContain('ZodPipe');
  });
});
