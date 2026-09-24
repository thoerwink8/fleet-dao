export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

/** 一行一个 JSON，进 systemd 日志。不许往这里写密钥、通行证；消息正文只记长度。 */
export function jsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
