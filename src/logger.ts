export type LogLevel = "debug" | "info" | "warn" | "error";

const LogLevelPriority: Readonly<Record<LogLevel, number>> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface ConsoleLoggerOptions {
  minimumLevel?: LogLevel;
}

export type LogContext = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

export class ConsoleLogger implements Logger {
  private readonly minimumLevel: LogLevel;

  public constructor(options: ConsoleLoggerOptions = {}) {
    this.minimumLevel = options.minimumLevel ?? "debug";
  }

  public debug(message: string, context?: LogContext): void {
    this.write("debug", message, context);
  }

  public info(message: string, context?: LogContext): void {
    this.write("info", message, context);
  }

  public warn(message: string, context?: LogContext): void {
    this.write("warn", message, context);
  }

  public error(message: string, context?: LogContext): void {
    this.write("error", message, context);
  }

  private write(level: LogLevel, message: string, context?: LogContext): void {
    if (LogLevelPriority[level] < LogLevelPriority[this.minimumLevel]) {
      return;
    }
    const entry: Record<string, unknown> = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };
    if (context !== undefined) {
      entry.context = context;
    }
    console.error(JSON.stringify(entry));
  }
}

export const noopLogger: Logger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
};
