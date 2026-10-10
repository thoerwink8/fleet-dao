// 健康检查：/healthz 逐项探依赖（库、实时推送、Temporal……），任何一项不好就整体 503，如实报红。
// 对外只说「哪一项、好不好、一句不含内部细节的原因」；错误原文（可能带内部地址）只进日志。
import { errMessage } from '@fleet-dao/shared/util';
import type { Context } from 'hono';
import type { HealthCheck, Logger } from './ports.ts';

/**
 * 可以原样告诉外面的失败原因：/healthz 公网打得到，健康页原样显示。只写一句中性的话——不含地址、账号、堆栈，
 * 也不带内部名（频道、表、仓名）和开发进度，这些只进日志。有测试拿公开页禁用词名单（web/src/build/scan.ts）扫每一种公开原因：
 * 新加一种，要补进那条测试。别的错误对外一律只说「连不上」。
 */
export class PublicHealthError extends Error {
  readonly code: string;
  /** 只进日志的细节（队列名、命名空间名这类），不对外。 */
  readonly detail: string | undefined;
  constructor(code: string, message: string, detail?: string) {
    super(message);
    this.name = 'PublicHealthError';
    this.code = code;
    this.detail = detail;
  }
}

/** 单项探活的上限：一项卡住不能把整个健康检查拖死。 */
const CHECK_TIMEOUT_MS = 3_000;

export type HealthReport = {
  ok: boolean;
  checks: Record<
    string,
    | { ok: true }
    /** 好，另带一句说明（比如飞书网关几秒前来过）：检查返回了一句话。和「未接」靠有没有 status 分开。 */
    | { ok: true; message: string }
    | { ok: true; status: 'not_wired'; message: string }
    | { ok: false; code: string; message: string }
  >;
};

export async function runHealthChecks(
  checks: readonly HealthCheck[],
  log: Logger,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<HealthReport> {
  const results = await Promise.all(
    checks.map(async ({ name, check, notWired }) => {
      // 功能压根没接上（装配时定的标记）：不跑、不算失败。只看这个标记，check 抛什么都判不成「未接」
      if (notWired !== undefined)
        return [name, { ok: true, status: 'not_wired', message: notWired }] as const;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const note = await Promise.race([
          check(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new PublicHealthError('timeout', `${timeoutMs / 1000} 秒没回应`)),
              timeoutMs,
            );
          }),
        ]);
        // 好的时候检查可以带一句说明（公网看得到：同样只写中性的话）
        const good: { ok: true; message?: string } =
          typeof note === 'string' && note.trim() ? { ok: true, message: note } : { ok: true };
        return [name, good] as const;
      } catch (err) {
        log.warn('健康检查没过', {
          check: name,
          error: errMessage(err),
          ...(err instanceof PublicHealthError && err.detail ? { detail: err.detail } : {}),
        });
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

/**
 * 生产要探的几项：库、实时推送（LISTEN）、Temporal、引擎工人、GitHub 事件的去处、
 * 判断题（接没接、调不调得通）、线上版本跟不跟得上主线、飞书网关还来不来、会话用户切号有没有要人看的、GitHub 两个机器人的
 * 权限够不够、全流程巡检最近一轮的结论、看门狗自己在不在按期跑、快照推没推出去。main.ts 用它装配，测试也用它，是同一份代码。
 */
export function serviceHealthChecks(parts: {
  /** 真去读几张常用表、带自己的超时（pg-store.ts 的 probeDb）；只 select 1 查不出表被锁住。 */
  probeDb: () => Promise<void>;
  /** 真探：发一条 ping 看 LISTEN 那条连接收不收得回来（changes.ts）。只看「接上过」的标记会在库停时照样报好。 */
  feed: { probe(timeoutMs?: number): Promise<void> };
  /** Temporal 本身，和它上面查引擎工人在不在（两项都来自同一份连接，见 temporal.ts 的 TemporalConnection）。 */
  temporal: { check(): Promise<void>; checkEngine(): Promise<void> };
  /**
   * 这台机器按设置没开引擎（temporal.ts 的 ENGINE_OFF，由 config.ts 的 engineEnabled 定）：engine 项报「未接」、不去查任务
   * 队列，不算坏。开着就没有这一项，引擎不在照样红。发版脚本对「没开引擎」的机器另有一条（deploy/release.sh 的 compare_api_items）。
   */
  engineNotWired?: string;
  githubEvents: () => Promise<void>;
  /**
   * 判断题（judge-health.ts）：没配报「未接」；配置起不来、最近一次真调用没成报红。
   * 失败超过 30 分钟没有新调用时，由引擎定时任务 judge-self-check 再探一次。
   */
  judge: { check(): Promise<void>; readonly notWired?: string };
  /** 线上版本跟不跟得上主线（deploy-lag.ts）：只在正式环境查，别处报「未接」。 */
  deployLag: { check(): Promise<void>; readonly notWired?: string };
  /** 飞书网关还来不来（gateway-seen.ts）：没配网关通行证报「未接」。 */
  // biome-ignore lint/suspicious/noConfusingVoidType: 没说明的检查是 async () => {}（Promise<void>），换成 undefined 它们就对不上了
  feishuGateway: { check(): Promise<void | string>; readonly notWired?: string };
  /** 会话用户切号（session-org-health.ts）：引擎切号没成、切完读回不在线、恢复时刻读不到的提醒还开着就报红。 */
  sessionOrg: () => Promise<void>;
  /** GitHub 两个机器人的权限（github-app-health.ts）：引擎每小时对账自检报的缺权限、没查成的提醒还开着就报红。 */
  githubApp: () => Promise<void>;
  /** 全流程巡检（canary-health.ts，#223）：最近一轮的结论和时间；不在正式环境报「未接」。 */
  // biome-ignore lint/suspicious/noConfusingVoidType: 同上，没说明的检查是 async () => {}
  canary: { check(): Promise<void | string>; readonly notWired?: string };
  /**
   * 引擎总开关（engine-master-health.ts，#1732）：关着且不在发版宽限里就红，避免 healthz 全绿掩盖派单停着。
   * 不在正式环境报「未接」。
   */
  // biome-ignore lint/suspicious/noConfusingVoidType: 同上，没说明的检查是 async () => {}
  engineMaster: { check(): Promise<void | string>; readonly notWired?: string };
  /** 看门狗（watchdog-health.ts，#203）：它自己最近一轮几点跑完、有没有过期；不在正式环境报「未接」。 */
  // biome-ignore lint/suspicious/noConfusingVoidType: 同上，没说明的检查是 async () => {}
  watchdog: { check(): Promise<void | string>; readonly notWired?: string };
  /** 往正式环境的看板推快照（node-reporter.ts）：没配推送地址报「未接」；配了，连着没推成、第一轮还没推完都报红。 */
  // biome-ignore lint/suspicious/noConfusingVoidType: 同上，没说明的检查是 async () => {}
  nodeReport: { check(): Promise<void | string>; readonly notWired?: string };
}): HealthCheck[] {
  return [
    { name: 'database', check: parts.probeDb },
    // 留出余量：比单项上限（CHECK_TIMEOUT_MS）早到点，报出来的是「ping 收不回来」而不是笼统的超时。
    { name: 'realtime', check: () => parts.feed.probe(CHECK_TIMEOUT_MS - 1_000) },
    { name: 'temporal', check: () => parts.temporal.check() },
    { name: 'engine', check: () => parts.temporal.checkEngine(), ...notWired(parts.engineNotWired) },
    { name: 'github_events', check: parts.githubEvents },
    // 最近一次调用没成会随上游自己变红（发版脚本对它只标待处理，见 deploy/release.sh 的 DRIFTING_HEALTH_ITEMS）
    { name: 'judge', check: () => parts.judge.check(), ...notWired(parts.judge.notWired) },
    // 主线一动就可能落后，也会自己变红：发版脚本同样只标待处理、不退回
    { name: 'deploy_lag', check: () => parts.deployLag.check(), ...notWired(parts.deployLag.notWired) },
    // 网关、隧道、香港出事就自己变红（后端刚起、网关还没回来时是「没查成」）：发版脚本同样只标待处理、不退回
    {
      name: 'feishu_gateway',
      check: () => parts.feishuGateway.check(),
      ...notWired(parts.feishuGateway.notWired),
    },
    // 切号出了要人看的问题（上游额度、登录这些）会自己变红，人处理好或下一轮切成了自己撤：发版脚本同样只标待处理、不退回
    { name: 'session_org', check: parts.sessionOrg },
    // 机器人权限被人在 GitHub 上改了、新权限在安装处没点接受会自己变红（和这一版好不好无关），好了引擎下一轮撤提醒、跟着回绿：
    // 发版脚本同样只标待处理、不退回
    { name: 'github_app', check: parts.githubApp },
    // 巡检断了、没跑成会跟着巡检的结论自己变红（和这一版好不好无关）：发版脚本同样只标待处理、不退回
    { name: 'canary', check: () => parts.canary.check(), ...notWired(parts.canary.notWired) },
    // 总开关关着（且不在发版宽限）派单停着：自己变红（#1732）；发版暂停中 / 刚发完宽限内报跳过不红
    {
      name: 'engine_master',
      check: () => parts.engineMaster.check(),
      ...notWired(parts.engineMaster.notWired),
    },
    // 看门狗停了、没跑成会跟着引擎自己变红（和这一版好不好无关）：发版脚本同样只标待处理、不退回
    { name: 'watchdog', check: () => parts.watchdog.check(), ...notWired(parts.watchdog.notWired) },
    // 推不成跟着网络、对方自己变红（和这一版好不好无关）：要接上别的环境之前，发版脚本的 DRIFTING_HEALTH_ITEMS 要加上它
    {
      name: 'node_report',
      check: () => parts.nodeReport.check(),
      ...notWired(parts.nodeReport.notWired),
    },
  ];
}

function notWired(message: string | undefined): { notWired?: string } {
  return message === undefined ? {} : { notWired: message };
}

export function healthHandler(checks: readonly HealthCheck[], log: Logger) {
  return async (c: Context) => {
    const report = await runHealthChecks(checks, log);
    c.header('Cache-Control', 'no-store');
    return c.json(report, report.ok ? 200 : 503);
  };
}
