export interface ILogger {
  info(data: Record<string, unknown>, msg: string): void;
  info(msg: string): void;
  info(dataOrMsg: Record<string, unknown> | string, msg?: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  warn(msg: string): void;
  warn(dataOrMsg: Record<string, unknown> | string, msg?: string): void;
  error(data: Record<string, unknown>, msg: string): void;
  error(msg: string): void;
  error(dataOrMsg: Record<string, unknown> | string, msg?: string): void;
  debug(data: Record<string, unknown>, msg: string): void;
  debug(msg: string): void;
  debug(dataOrMsg: Record<string, unknown> | string, msg?: string): void;
}
