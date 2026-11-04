import { inspect } from 'node:util';
import { ConsoleLogger, LogLevel } from '@nestjs/common';
import { redactDeep, redactString } from './redact.js';

/**
 * Story 20.2 (AD-95, FR-129, NFR-20.5): the application logger. Every line
 * (messages, objects, errors, stacks, extra params) goes through `redactDeep`
 * before it is formatted, so a cedula in a log argument, a thrown error
 * message or a Prisma error that echoes a value is never written in clear.
 * Mounted in `main.ts` (and the CLI); `Logger.log(...)` static calls use it too.
 */
export class RedactingLogger extends ConsoleLogger {
  protected override printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
    params?: Record<string, unknown>,
  ): void {
    const safe = messages.map((m) =>
      typeof m === 'string' ? redactString(m) : this.safe(m),
    );
    const safeStack =
      typeof errorStack === 'string' ? redactString(errorStack) : errorStack;
    super.printMessages(
      safe,
      context,
      logLevel,
      writeStreamType,
      safeStack,
      params === undefined ? undefined : redactDeep(params),
    );
  }

  /** Stacks are printed by a separate method; they can carry the message of the original error. */
  protected override printStackTrace(stack: string): void {
    super.printStackTrace(
      typeof stack === 'string' ? redactString(stack) : stack,
    );
  }

  /** An `Error` becomes `Name: message\nstack` (redacted) plus its own props (code, meta...) redacted. */
  private safe(m: unknown): unknown {
    if (!(m instanceof Error)) return redactDeep(m);
    const { name, message, stack, ...extra } = redactDeep(
      m,
    ) as unknown as Record<string, unknown>;
    const head = `${String(name)}: ${String(message)}${typeof stack === 'string' && stack ? `\n${stack}` : ''}`;
    return Object.keys(extra).length > 0
      ? `${head}\n${inspect(extra, { depth: 4, breakLength: 120 })}`
      : head;
  }
}
