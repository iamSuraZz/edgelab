/**
 * Failure modes of an isolated pool task, as distinguishable types.
 *
 * The point of classifying these is that they mean very different things to the user. "Your
 * script has a bug on line 12" and "your script ran for two minutes and we stopped it" and
 * "the thread ran out of memory" all arrive from piscina as plain Errors, and a job that
 * reports them identically is a job that cannot be acted on.
 */

export abstract class TaskFailure extends Error {
  /** Stable code for the API and the UI, so neither has to match on message text. */
  abstract readonly code: string;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The task overran its wall-clock budget and its thread was terminated. */
export class TaskTimeoutError extends TaskFailure {
  readonly code = 'task-timeout';

  constructor(
    readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Task exceeded its ${String(Math.round(timeoutMs / 1000))}s time limit and was stopped. ` +
        'Narrow the date range, use a higher timeframe, or simplify the script.',
      options,
    );
  }
}

/** The task's thread hit its heap limit and was killed by V8. */
export class TaskOutOfMemoryError extends TaskFailure {
  readonly code = 'task-out-of-memory';

  constructor(
    readonly limitMb: number,
    options?: { cause?: unknown },
  ) {
    super(
      `Task exceeded its ${String(limitMb)} MB memory limit and was stopped. This usually means ` +
        'an unbounded array or a var that grows on every bar.',
      options,
    );
  }
}

/** The thread died without a usable error — a hard crash, a process.exit, a native fault. */
export class TaskCrashedError extends TaskFailure {
  readonly code = 'task-crashed';

  constructor(detail: string, options?: { cause?: unknown }) {
    super(`Task crashed its worker thread: ${detail}`, options);
  }
}

/**
 * The task ran and threw. This is the ordinary "your script has a bug" case.
 *
 * `originalName` matters more than it looks. Classification crosses the thread boundary in
 * `Error.name`, because structured clone keeps name/message/stack/cause and drops every own
 * property. Wrapping the error here would rename it to `TaskScriptError` and destroy the one
 * field that carried the meaning — which is how a clean "no data for that range" surfaced as
 * `task-script-error`, i.e. "your script has a bug". Keeping the original name lets the job
 * layer recognise a domain failure without the pool needing to know what one is.
 */
export class TaskScriptError extends TaskFailure {
  readonly code = 'task-script-error';

  constructor(
    message: string,
    readonly originalStack: string | null,
    readonly originalName: string | null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * Turn whatever piscina rejected with into one of the four.
 *
 * `timedOut` comes from the caller's own abort controller rather than being inferred from the
 * error: piscina reports an aborted task as a generic `AbortError` whether we aborted it for
 * a timeout or the user pressed cancel, so the error alone cannot tell them apart.
 */
export function classifyTaskFailure(
  error: unknown,
  context: { timedOut: boolean; timeoutMs: number; memoryLimitMb: number },
): TaskFailure {
  if (error instanceof TaskFailure) return error;

  if (context.timedOut) {
    return new TaskTimeoutError(context.timeoutMs, { cause: error });
  }

  const code = typeof error === 'object' && error !== null ? readCode(error) : null;
  const message = error instanceof Error ? error.message : String(error);

  // Node kills a thread that breaches resourceLimits with this code.
  if (code === 'ERR_WORKER_OUT_OF_MEMORY' || /out of memory/i.test(message)) {
    return new TaskOutOfMemoryError(context.memoryLimitMb, { cause: error });
  }

  // piscina's own wording when it tears a worker down under a running task.
  if (code === 'ERR_WORKER_INIT_FAILED' || /terminating worker thread/i.test(message)) {
    return new TaskCrashedError(message, { cause: error });
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new TaskCrashedError(`aborted: ${message}`, { cause: error });
  }

  return new TaskScriptError(
    message,
    error instanceof Error ? (error.stack ?? null) : null,
    error instanceof Error ? error.name : null,
    { cause: error },
  );
}

function readCode(error: object): string | null {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}
