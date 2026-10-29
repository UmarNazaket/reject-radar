/** How deep a cause chain is followed; deeper causes are cut off (this also ends a cycle). */
const MAX_CAUSE_DEPTH = 5;
/** Drizzle's `DrizzleQueryError` message is `Failed query: <sql>\nparams: <values>`; everything from here on is values. */
const PARAMS_MARKER = '\nparams:';

/**
 * The error and its cause chain, one line each, with the `code` when there is one (node-postgres's SQLSTATE, or a
 * socket error's). Drizzle's parameter list is cut off and node-postgres's `detail` is never shown: both can hold values.
 */
export function describeError(error: Error): string {
  const lines: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current instanceof Error && depth <= MAX_CAUSE_DEPTH; depth++) {
    const { code, cause } = current as Error & { code?: unknown; cause?: unknown };
    const at = current.message.indexOf(PARAMS_MARKER);
    const message = at === -1 ? current.message : current.message.slice(0, at);
    lines.push(`${depth === 0 ? '' : 'Caused by: '}${typeof code === 'string' ? `[${code}] ` : ''}${message}`);
    current = cause;
  }
  return lines.join('\n');
}
