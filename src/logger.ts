export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

export interface Logger {
  error(msg: string, meta?: object): void;
  warn(msg: string, meta?: object): void;
  info(msg: string, meta?: object): void;
  debug(msg: string, meta?: object): void;
}

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

/** Structured JSON logs, one line per entry. */
export function createLogger(level: LogLevel): Logger {
  const write = (at: Exclude<LogLevel, "silent">, msg: string, meta?: object) => {
    if (RANK[at] > RANK[level]) return;
    const line = JSON.stringify({ level: at, time: new Date().toISOString(), msg, ...meta });
    if (at === "error") console.error(line);
    else console.log(line);
  };
  return {
    error: (msg, meta) => write("error", msg, meta),
    warn: (msg, meta) => write("warn", msg, meta),
    info: (msg, meta) => write("info", msg, meta),
    debug: (msg, meta) => write("debug", msg, meta),
  };
}

export function errMeta(err: unknown) {
  if (err instanceof Error) return { name: err.name, message: err.message, stack: err.stack };
  return { message: String(err) };
}
