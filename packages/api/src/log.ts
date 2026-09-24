import type { Logger } from './ports.ts';

/** 一行一个 JSON，进 systemd 日志。不许往这里写密钥、令牌、授权码。 */
export function jsonLogger(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
): Logger {
  const emit = (level: string) => (message: string, fields?: Record<string, unknown>) =>
    write(JSON.stringify({ at: new Date().toISOString(), level, message, ...fields }));
  return { info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };
