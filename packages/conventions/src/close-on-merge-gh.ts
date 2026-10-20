import { setTimeout } from 'node:timers/promises';
import type { Gh, GhResult } from './issue-new.ts';

export interface CloseGhOptions {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}

const BUDGET_MS = 30_000;
const FIELDS = {
  'retry-after': 'retryAfterSeconds',
  'x-ratelimit-limit': 'limit',
  'x-ratelimit-remaining': 'remaining',
  'x-ratelimit-used': 'used',
  'x-ratelimit-reset': 'resetEpochSeconds',
  'x-ratelimit-resource': 'resource',
  'x-github-request-id': 'requestId',
} as const;
type Field = (typeof FIELDS)[keyof typeof FIELDS];
type Diagnostic = { httpStatus: number | 'unknown' } & Partial<Record<Field, string | number>>;

// 只认本入口实际使用的两种无payload REST GET；未知形状、GraphQL和写命令一律不改写/重放。
function readArgs(args: string[]): string[] | undefined {
  if (args[0] !== 'api') return;
  const endpoint = (value: string | undefined) => /^\/?(?:repos|repositories|users)\//.test(value ?? '');
  if (args.length === 2 && endpoint(args[1])) return [...args, '--include', '--method', 'GET'];
  if (
    args.length === 4 &&
    ['--method', '-X'].includes(args[1] ?? '') &&
    args[2] === 'GET' &&
    endpoint(args[3])
  )
    return [...args, '--include'];
}

function parse(text: string) {
  const boundary = /\r?\n\r?\n/.exec(text);
  if (!boundary || boundary.index === undefined) return;
  const lines = text.slice(0, boundary.index).split(/\r?\n/);
  const status = /^HTTP\/(?:1\.[01]|2(?:\.0)?|3(?:\.0)?) ([1-5]\d{2})(?: [^\r\n]*)?$/.exec(
    lines.shift() ?? '',
  );
  if (!status) return;
  const diagnostic: Diagnostic = { httpStatus: Number(status[1]) };
  let invalid = false;
  for (const line of lines) {
    const header = /^([\w-]+):[ \t]*(.*)$/.exec(line);
    if (!header) return;
    const name = header[1]?.toLowerCase() ?? '';
    if (!Object.hasOwn(FIELDS, name)) continue;
    const field = FIELDS[name as keyof typeof FIELDS];
    const value = header[2]?.trim() ?? '';
    if (diagnostic[field] !== undefined) {
      diagnostic[field] = 'invalid';
      invalid = true;
    } else if (field === 'requestId' || field === 'resource') {
      const valid =
        field === 'requestId' ? /^[A-Za-z0-9:_-]{1,200}$/.test(value) : /^[a-z_]{1,50}$/.test(value);
      diagnostic[field] = valid ? value : 'invalid';
      invalid ||= !valid;
    } else {
      const number = Number(value);
      const valid = /^\d+$/.test(value) && Number.isSafeInteger(number);
      diagnostic[field] = valid ? number : 'invalid';
      invalid ||= !valid;
    }
  }
  return { diagnostic, invalid, body: text.slice(boundary.index + boundary[0].length) };
}

/** 本入口独享一次只读重试；不改变通用ghRunner及关单/验收判法，不换身份。 */
export function closeOnMergeGh(gh: Gh, options: CloseGhOptions = {}): Gh {
  const now = options.now ?? Date.now;
  const wait = options.wait ?? ((ms: number) => setTimeout(ms));
  const log = options.log ?? ((line: string) => console.error(line));
  const started = now();
  let retryUsed = false;
  const fail = (code: number, reason: string, diagnostic: Diagnostic): GhResult => {
    const stderr = `close-on-merge GitHub请求没查成：${reason} ${JSON.stringify(diagnostic)}`;
    log(stderr);
    return { code: code || 2, stdout: '', stderr };
  };
  return async (args) => {
    const readonly = readArgs(args);
    const request = async (): Promise<GhResult> => {
      let result: GhResult;
      try {
        result = await gh(readonly ?? args);
      } catch {
        return fail(2, '运输异常，安全重试时点未知；未重放', { httpStatus: 'unknown' });
      }
      if (!readonly) {
        return result.code === 0
          ? { ...result, stderr: '' }
          : fail(result.code, '写请求或未知命令失败，未重放；安全重试时点未知', { httpStatus: 'unknown' });
      }
      const parsed = parse(result.stdout);
      if (!parsed) return fail(2, 'HTTP响应头缺失或认不出，安全重试时点未知', { httpStatus: 'unknown' });
      const { diagnostic, body, invalid } = parsed;
      if (invalid) return fail(2, '限流响应头无效，安全重试时点未知', diagnostic);
      const status = diagnostic.httpStatus;
      if (result.code === 0 && typeof status === 'number' && status >= 200 && status < 300) {
        try {
          JSON.parse(body);
        } catch {
          return fail(2, 'HTTP成功但JSON无效，未获完整读取；未重放', diagnostic);
        }
        return { code: 0, stdout: body, stderr: '' };
      }
      if (status !== 403 && status !== 429)
        return fail(result.code, '非限流或未知失败，安全重试时点未知；未重放', diagnostic);
      let rateMessage = false;
      try {
        const message = JSON.parse(body)?.message;
        rateMessage =
          typeof message === 'string' &&
          /\b(?:api rate limit exceeded|exceeded (?:a )?secondary rate limit|abuse detection mechanism)\b/i.test(
            message,
          );
      } catch {
        /* 私有响应正文不进入诊断。 */
      }
      if (status === 403 && !rateMessage)
        return fail(result.code, '权限拒绝或未知403，未确认限流；安全重试时点未知；未重放', diagnostic);
      const primary = diagnostic.remaining === 0;
      const secondary = typeof diagnostic.retryAfterSeconds === 'number' && (status === 429 || rateMessage);
      if ((!primary && !secondary) || (primary && typeof diagnostic.resetEpochSeconds !== 'number'))
        return fail(result.code, '未知失败或限流恢复头不足，安全重试时点未知；未重放', diagnostic);
      const current = now();
      // reset是UTC秒；等待到该秒之后，两个提示同时存在时取较晚值。
      const safeAt = Math.max(
        current,
        primary ? (Number(diagnostic.resetEpochSeconds) + 1) * 1000 : current,
        typeof diagnostic.retryAfterSeconds === 'number'
          ? current + diagnostic.retryAfterSeconds * 1000
          : current,
      );
      if (!Number.isSafeInteger(safeAt) || safeAt > 8.64e15)
        return fail(2, '限流时点无效，安全重试时点未知；未重放', diagnostic);
      const point = new Date(safeAt).toISOString();
      if (retryUsed) return fail(result.code, `本轮一次重试已用完；不早于${point}`, diagnostic);
      if (current < started || safeAt - started > BUDGET_MS)
        return fail(result.code, `超过本轮30秒预算，不等待；不早于${point}`, diagnostic);
      retryUsed = true;
      log(
        `close-on-merge GitHub只读${primary ? '主' : '次'}限流，唯一重试不早于${point} ${JSON.stringify(diagnostic)}`,
      );
      try {
        await wait(safeAt - current);
      } catch {
        return fail(2, `限流等待失败，未重放；不早于${point}`, diagnostic);
      }
      if (now() < safeAt || now() - started > BUDGET_MS)
        return fail(2, `等待未到服务端时点或已超预算，未重放；不早于${point}`, diagnostic);
      return request();
    };
    return request();
  };
}
