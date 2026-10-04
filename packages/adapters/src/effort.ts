// 各家插头认的思考档位。引擎起会话时总是显式传（没配就用 high，见 shared 的 DEFAULT_SESSION_EFFORT）；
// 这里只负责「传了的值认不认、这家接不接」。不认识、这家不支持都抛错，调用方不起会话，不许当成 high。
// 叫法和各家认哪些档只有 shared/effort.ts 一份（驾驶舱、路由骨架、引擎都照它判），这里转出去给插头用。
import { SESSION_EFFORTS, type SessionEffort } from '@fleet-dao/shared';

export { GROK_EFFORTS, isSessionEffort, SESSION_EFFORTS, type SessionEffort } from '@fleet-dao/shared';

/** 档位不认识，或这家的参数接不了这个值：抛错。who 写进报错，方便对上是哪一家。 */
export function assertSessionEffort<T extends SessionEffort>(
  value: string,
  allowed: readonly T[],
  who: string,
): T {
  if (!(SESSION_EFFORTS as readonly string[]).includes(value)) {
    throw new Error(
      `思考档位（effort）不认识：${JSON.stringify(value)}（只有 ${SESSION_EFFORTS.join(' / ')}）`,
    );
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${who} 不支持思考档位（effort）${value}（只认 ${allowed.join(' / ')}）`);
  }
  return value as T;
}
