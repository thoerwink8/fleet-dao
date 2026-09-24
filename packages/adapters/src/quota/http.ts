// 读取器共用的一次只读 HTTP 调用：连不上、超时、401/403、非 2xx、回包太大、不是 JSON，各归一种失败。
import type { ReaderContext } from './context.ts';
import { QuotaReadError } from './types.ts';
import { redact } from './util.ts';

const MAX_BODY = 4 * 1024 * 1024;

export interface JsonCall {
  /** 出现在错误信息里的名字，例如「Cursor GetPlanInfo」。 */
  name: string;
  url: string;
  init: RequestInit;
  /** 401/403 时告诉人怎么修，例如「要在这台机器上重新 cursor-agent login」。 */
  authHint: string;
}

export async function fetchJson(
  ctx: Pick<ReaderContext, 'fetch' | 'signal'>,
  call: JsonCall,
): Promise<unknown> {
  const failed = (e: unknown, stage: string) =>
    ctx.signal.aborted
      ? new QuotaReadError('timeout', `${call.name} 超时`)
      : new QuotaReadError(
          'unreachable',
          `${call.name} ${stage}：${redact(String((e as Error)?.message ?? e))}`,
        );
  let res: Response;
  try {
    res = await ctx.fetch(call.url, { ...call.init, redirect: 'error', signal: ctx.signal });
  } catch (e) {
    throw failed(e, '连不上');
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    throw failed(e, '回包没收完');
  }
  if (res.status === 401 || res.status === 403) {
    throw new QuotaReadError('auth', `${call.name} 登录失效（HTTP ${res.status}）：${call.authHint}`);
  }
  if (!res.ok) throw new QuotaReadError('upstream', `${call.name} 回 HTTP ${res.status}：${redact(text)}`);
  if (text.length > MAX_BODY) throw new QuotaReadError('bad_response', `${call.name} 回包太大`);
  try {
    return JSON.parse(text);
  } catch {
    throw new QuotaReadError('bad_response', `${call.name} 回包不是 JSON`);
  }
}
