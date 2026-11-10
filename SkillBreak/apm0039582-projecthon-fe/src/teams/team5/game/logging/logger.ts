/** Only these keys are written, so input, passwords and tokens cannot reach the console. */
interface LogContext { sessionId?: string; commandId?: string; puzzleKey?: string; status?: number | string }

function write(level: 'info' | 'warn', event: string, { sessionId, commandId, puzzleKey, status }: LogContext) {
  const context = Object.fromEntries(Object.entries({ sessionId, commandId, puzzleKey, status }).filter(([, value]) => value !== undefined));
  console[level](`[team5] ${event}`, context);
}

export const logger = {
  info: (event: string, context: LogContext = {}) => write('info', event, context),
  warn: (event: string, context: LogContext = {}) => write('warn', event, context),
};
