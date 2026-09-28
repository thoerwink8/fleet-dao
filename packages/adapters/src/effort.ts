// 各家插头认的思考档位。引擎起会话时总是显式传（没配就用 high，见 engine 的 DEFAULT_SESSION_EFFORT）；
// 这里只负责「传了的值认不认、这家接不接」。不认识、这家不支持都抛错，调用方不起会话，不许当成 high。

/** 认的写法。不在这里的一律不认识。 */
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type SessionEffort = (typeof SESSION_EFFORTS)[number];

/**
 * Grok 命令行 `--reasoning-effort` 认的档。help 不列取值；`max` 是 Claude Code `--effort` 才有的，
 * Grok 自己的默认是 xhigh。
 */
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const satisfies readonly SessionEffort[];

export function isSessionEffort(value: string): value is SessionEffort {
  return (SESSION_EFFORTS as readonly string[]).includes(value);
}

/** 档位不认识，或这家的参数接不了这个值：抛错。who 写进报错，方便对上是哪一家。 */
export function assertSessionEffort<T extends SessionEffort>(
  value: string,
  allowed: readonly T[],
  who: string,
): T {
  if (!isSessionEffort(value)) {
    throw new Error(
      `思考档位（effort）不认识：${JSON.stringify(value)}（只有 ${SESSION_EFFORTS.join(' / ')}）`,
    );
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${who} 不支持思考档位（effort）${value}（只认 ${allowed.join(' / ')}）`);
  }
  return value as T;
}
