import v8 from 'node:v8';

/**
 * Per-stage memory measurement for a backtest run.
 *
 * Exists because "unbounded array or a var that grows on every bar" was a GUESS printed by the pool
 * when a task hit its limit, and it pointed at the script. A measurement that names the stage is the
 * difference between fixing the cause and raising the ceiling.
 *
 * `heapUsed` alone is not enough. Bars read from postgres arrive as JS objects on the heap, but typed
 * arrays and Buffers live in EXTERNAL memory, and the pool's limit is on the heap — so a fix that
 * moves bars off the heap has to be visible as heap falling and external rising, not as one number
 * getting smaller.
 */

export interface MemorySample {
  readonly stage: string;
  /** Bars the stage was holding or produced, when the caller knows. */
  readonly bars: number | null;
  readonly heapUsedBytes: number;
  readonly externalBytes: number;
  readonly rssBytes: number;
  readonly elapsedMs: number;
}

export interface ProbeOptions {
  /**
   * Force a major GC before sampling, so the number is RETAINED memory rather than garbage that
   * happens not to have been collected yet.
   *
   * Needs `--expose-gc`. Without it the samples still show the shape of the problem, but a stage can
   * look worse than it is. The probe says which mode it ran in rather than leaving that to be
   * guessed from the numbers.
   */
  readonly forceGc?: boolean;
}

export class MemoryProbe {
  private readonly samples: MemorySample[] = [];
  private readonly startedAt = Date.now();
  private readonly gc: (() => void) | undefined;

  constructor(private readonly options: ProbeOptions = {}) {
    const maybeGc = (globalThis as { gc?: () => void }).gc;
    this.gc = options.forceGc === true && typeof maybeGc === 'function' ? maybeGc : undefined;
  }

  get gcAvailable(): boolean {
    return this.gc !== undefined;
  }

  /** Sample after a stage completes. `bars` is what that stage was holding, when known. */
  mark(stage: string, bars: number | null = null): MemorySample {
    if (this.gc !== undefined) {
      // Twice: the first pass can leave objects that only become unreachable once finalizers run.
      this.gc();
      this.gc();
    }

    const usage = process.memoryUsage();
    const sample: MemorySample = {
      stage,
      bars,
      heapUsedBytes: usage.heapUsed,
      externalBytes: usage.external,
      rssBytes: usage.rss,
      elapsedMs: Date.now() - this.startedAt,
    };

    this.samples.push(sample);
    return sample;
  }

  all(): readonly MemorySample[] {
    return this.samples;
  }

  /** Peak heap across the run, which is the figure the pool's limit is compared against. */
  peakHeapBytes(): number {
    return this.samples.reduce((max, s) => Math.max(max, s.heapUsedBytes), 0);
  }

  /**
   * A table, with the DELTA per stage and bytes per bar.
   *
   * The delta is what identifies the culprit: a stage whose own heap growth is 300 MB is the problem
   * even if a later stage happens to show a higher total.
   */
  format(): string {
    const lines: string[] = [];
    lines.push(
      `  ${'stage'.padEnd(22)} ${'bars'.padStart(10)} ${'heap'.padStart(10)} ` +
        `${'Δheap'.padStart(10)} ${'external'.padStart(10)} ${'rss'.padStart(10)} ${'B/bar'.padStart(8)}`,
    );

    let previousHeap = 0;
    for (const s of this.samples) {
      const delta = s.heapUsedBytes - previousHeap;
      previousHeap = s.heapUsedBytes;

      const perBar = s.bars !== null && s.bars > 0 ? delta / s.bars : null;

      lines.push(
        `  ${s.stage.padEnd(22)} ${fmtCount(s.bars).padStart(10)} ${mb(s.heapUsedBytes).padStart(10)} ` +
          `${mbSigned(delta).padStart(10)} ${mb(s.externalBytes).padStart(10)} ` +
          `${mb(s.rssBytes).padStart(10)} ${(perBar === null ? '—' : perBar.toFixed(0)).padStart(8)}`,
      );
    }

    lines.push(
      `  peak heap ${mb(this.peakHeapBytes())}, heap limit ` +
        `${mb(v8.getHeapStatistics().heap_size_limit)}` +
        (this.gcAvailable
          ? ' (forced GC before each sample)'
          : ' (NO forced GC — run with --expose-gc)'),
    );

    return lines.join('\n');
  }
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

function mbSigned(bytes: number): string {
  const v = bytes / 1024 / 1024;
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}MB`;
}

function fmtCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US');
}
