/** 服务端可信 reader 本次读取的进程内凭据；JSON 和结构相同的对象不能冒充。 */
export interface CheckoutSourceRecord {
  namespace: string;
  workflowId: string;
  executionRunId: string;
  taskId: string;
  repo: string;
  issueNumber: number;
  pr: number;
  head: string;
  runId: string;
  runStartedAt: string;
  runEndedAt: string;
  scheduled: string;
  started: string;
  completed: string;
  scheduledAt: string;
  startedAt: string;
  completedAt: string;
  inputHash: string;
  resultHash: string;
  startHash: string;
  closeEvent: string;
}
const sources = new WeakSet<object>();
declare const trusted: unique symbol;
export type CheckoutSource = Readonly<CheckoutSourceRecord> & { readonly [trusted]: true };

/** 仅由服务端读取完整 Temporal history 后调用；不接在命令输入或 HTTP 上。所有字段均为标量。 */
export function observedCheckoutSource(record: CheckoutSourceRecord): CheckoutSource {
  const source = Object.freeze({ ...record }) as CheckoutSource;
  sources.add(source);
  return source;
}
export function isObservedCheckoutSource(value: unknown): value is CheckoutSource {
  return typeof value === 'object' && value !== null && sources.has(value);
}
