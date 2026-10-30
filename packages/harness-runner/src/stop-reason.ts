// 叫停会话时传的原因：abort(new StopReason(kind, detail))，运行层读 signal.reason 记进 killed.detail。
// 查不出谁停的、为什么停的，就没法判断该不该停、能不能少停（#2366）。从旧 adapters/src/stop-reason.ts 复制。

export type StopKind =
  | 'release-pause' // 发版暂停 / 排空 / 引擎要走了
  | 'user-stop' // 人点了停，或关了总开关
  | 'route-swap' // 换路由 / 切号
  | 'watchdog' // 看门狗
  | 'lease-lost' // 租约过期
  | 'wall-clock' // 引擎这边的时限到了
  | 'other';

export const STOP_KIND_TEXT: Record<StopKind, string> = {
  'release-pause': '发版暂停',
  'user-stop': '人点了停',
  'route-swap': '换路由',
  watchdog: '看门狗',
  'lease-lost': '租约过期',
  'wall-clock': '时限到了',
  other: '其他',
};

export interface StopCause {
  kind: StopKind;
  detail: string;
}

/** 叫停的原因：当 AbortController.abort() 的参数传。仍是 Error，没认它的地方照旧能读到 message。 */
export class StopReason extends Error {
  readonly kind: StopKind;
  readonly detail: string;
  constructor(kind: StopKind, detail: string) {
    super(detail);
    this.name = 'StopReason';
    this.kind = kind;
    this.detail = detail;
  }
}

/** 读 signal.reason：带种类的原样取；别的 Error / 字符串算「其他」；没传（默认的 AbortError、undefined）返回 undefined。 */
export function stopCauseOf(reason: unknown): StopCause | undefined {
  if (reason instanceof StopReason) return { kind: reason.kind, detail: reason.detail };
  if (reason instanceof Error) {
    if (reason.name === 'AbortError' || reason.name === 'TimeoutError') return undefined;
    return reason.message.trim() ? { kind: 'other', detail: reason.message } : undefined;
  }
  if (typeof reason === 'string' && reason.trim()) return { kind: 'other', detail: reason };
  return undefined;
}

/** 展开进 killed：信号带了原因就写 cause，没带就不写。 */
export function abortCause(signal: AbortSignal | undefined): { cause?: StopCause } {
  const cause = signal ? stopCauseOf(signal.reason) : undefined;
  return cause ? { cause } : {};
}
