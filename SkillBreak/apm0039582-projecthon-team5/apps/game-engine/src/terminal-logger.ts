import { ConsoleLogger, type LogLevel } from '@nestjs/common';

export class TerminalLogger extends ConsoleLogger {
  protected colorize(message: string, level: LogLevel): string {
    const interactive = process.stdout.isTTY || process.env.FORCE_COLOR === '1';
    return interactive && process.env.NO_COLOR === undefined ? super.colorize(message, level) : message;
  }
}