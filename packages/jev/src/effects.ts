// Jev 的结论最多能把流程带到哪。只有收紧的方向：让一件事停下、退回、换路，或者提醒人看。
// 这里没有、也不许加「放行」「批准合并」「动账号」「删除」这类值——设计文档第十一节「能拦不能放」。
// 题库里每个选项只能挂这几种之一，调用方拿到的 act 也只会是这几种之一，所以 Jev 的答案在类型上就表达不出放行。

export const EFFECTS = ['none', 'flag', 'reroute', 'send_back', 'stop'] as const;

/**
 * none = 不改流程，照默认走；flag = 提醒人看（日报、驾驶舱标出），不改流程；
 * reroute = 换路（换阶段类型、换路由、换模型、换处理方）；send_back = 退回上一步重做；stop = 停下（追问、挂起、等人）。
 */
export type Effect = (typeof EFFECTS)[number];

type Releasing =
  | 'approve'
  | 'merge'
  | 'allow'
  | 'pass'
  | 'proceed'
  | 'unblock'
  | 'account'
  | 'delete'
  | 'remove';
type CannotRelease<T> = [Extract<T, Releasing>] extends [never] ? true : { forbidden: Extract<T, Releasing> };

/** 编译期闸：谁往 EFFECTS 里加了放行、合并、动账号、删除一类的值，tsc 当场报错。 */
export const EFFECTS_CANNOT_RELEASE: CannotRelease<Effect> = true;

export const EFFECT_TEXT: Record<Effect, string> = {
  none: '不改流程',
  flag: '提醒人看',
  reroute: '换路',
  send_back: '退回重做',
  stop: '停下',
};

export function isEffect(value: unknown): value is Effect {
  return typeof value === 'string' && (EFFECTS as readonly string[]).includes(value);
}
