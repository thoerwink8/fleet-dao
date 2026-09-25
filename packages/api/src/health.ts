// 健康检查：/healthz 逐项探依赖（库、实时推送、Temporal……），任何一项不好就整体 503，如实报红。
// 对外只说「哪一项、好不好、一句不含内部细节的原因」；错误原文（可能带内部地址）只进日志。
import type { Context } from 'hono';
import type { HealthCheck, Logger } from './ports.ts';

/**
 * 可以原样告诉外面的失败原因：/healthz 公网打得到，健康页原样显示。只写一句中性的话——不含地址、账号、堆栈，
 * 也不带内部名（频道、表、仓名）和开发进度，这些只进日志。有测试拿演示版打包扫描的名单扫每一种公开原因：
 * 新加一种，要补进那条测试。别的错误对外一律只说「连不上」。
 */
export class PublicHealthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PublicHealthError';
    this.code = code;
  }
}

/** 单项探活的上限：一项卡住不能把整个健康检查拖死。 */
const CHECK_TIMEOUT_MS = 3_000;

export type HealthReport = {
  ok: boolean;
  checks: Record<string, { ok: true } | { ok: false; code: string; message: string }>;
};

export async function runHealthChecks(
  checks: readonly HealthCheck[],
  log: Logger,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async ({ name, check }) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          check(),
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new PublicHealthError('timeout', `${timeoutMs / 1000} 秒没回应`)),
              timeoutMs,
            );
          }),
        ]);
        return [name, { ok: true }] as const;
      } catch (err) {
        log.warn('健康检查没过', { check: name, error: err instanceof Error ? err.message : String(err) });
        return [
          name,
          err instanceof PublicHealthError
            ? { ok: false, code: err.code, message: err.message }
            : { ok: false, code: 'unreachable', message: '连不上' },
        ] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const report: HealthReport = { ok: results.every(([, r]) => r.ok), checks: Object.fromEntries(results) };
  return report;
}

/** 生产要探的几项：库、实时推送（LISTEN）、Temporal、GitHub 事件的去处。main.ts 用它装配，测试也用它，是同一份代码。 */
export function serviceHealthChecks(parts: {
  /** 真去读几张常用表、带自己的超时（pg-store.ts 的 probeDb）；只 select 1 查不出表被锁住。 */
  probeDb: () => Promise<void>;
  /** 真探：发一条 ping 看 LISTEN 那条连接收不收得回来（changes.ts）。只看「接上过」的标记会在库停时照样报好。 */
  feed: { probe(timeoutMs?: number): Promise<void> };
  temporal: { check(): Promise<void> };
  githubEvents: () => Promise<void>;
}): HealthCheck[] {
  return [
    { name: 'database', check: parts.probeDb },
    // 留出余量：比单项上限（CHECK_TIMEOUT_MS）早到点，报出来的是「ping 收不回来」而不是笼统的超时。
    { name: 'realtime', check: () => parts.feed.probe(CHECK_TIMEOUT_MS - 1_000) },
    { name: 'temporal', check: () => parts.temporal.check() },
    { name: 'github_events', check: parts.githubEvents },
  ];
}

export function healthHandler(checks: readonly HealthCheck[], log: Logger) {
  return async (c: Context) => {
    const report = await runHealthChecks(checks, log);
    c.header('Cache-Control', 'no-store');
    return c.json(report, report.ok ? 200 : 503);
  };
}
