// 三段无头会话的生产 Spawner（#632 S2-3）：runner/one-shot.ts 的 OneShotSpawner，真起 Claude Code / cursor-agent / grok。
//
// 不另写一套启动命令：执行方式的驱动（hosts.ts）已经管着各家的参数、会话用户、scope 资源上限、调工具前的钩子、模型核对、
// 额度读数和终帧，生产里跑了很久。这里只做三件事：按路由编号查出执行方式和会话用户（和 Fusion 的 startSession 同一个查法，
// sessionUserOf）→ 备好会话自己的临时目录 → 起驱动、等它收场，把驱动的报告整理成 OneShotSpawner 的结局（退出码、回答正文当
// stdout、用量花费额度当 facts）。
//
// 改这里之前必须知道：
// - 一次性：会话号一律开新的（session.mode = 'new'），不续、不 fork、不脱开引擎进程跑（不传 io）；这是 one-shot.ts 的第 1 条。
// - 成败只认 adapters 的 judgeRun（和 Fusion 同一份判法）：它不是 ok，退出码就不会是 0。「终帧报错」「没有终帧」这些，
//   即使进程自己退出码是 0，这里也报 1，不让 one-shot 把它判成 done。
// - 读不到、认不出一律抛错（路由没给、库里没有这条路由、执行方式没接上、会话用户定不下来），runOneShot 把它记成
//   spawn_failed；不落到某个默认执行体上。
// - 中转路由（Mirasim）的账本没读成时 judgeRun 判 relay_unknown：活可能已经交了，要对账、不能重跑会话——reason 原样带在
//   facts 里，调用方（任务工作流）见到它停下报人，不走自动重试。
// - 总时长比 one-shot 的时限早一分钟到（驱动自己的 wallClock），驱动先收场、报 wall_clock_timeout；one-shot 的时限信号
//   晚一点到，是兜底（驱动卡死了）。
// - 会话的临时目录（TMPDIR）：起之前交给会话用户，收场后删；删不掉只记日志（占盘，下次引擎起来的清理会收），不改结局。

import { judgeRun, type SessionUser } from '@fleet-dao/adapters';
import type { Db, RouteLaunchFacts } from '@fleet-dao/db';
import { routeLaunchFacts } from '@fleet-dao/db';
import type { OneShotSpawner, SpawnFacts, SpawnOutcome } from '../runner/one-shot.ts';
import {
  type HostDriver,
  type HostReport,
  type HostRunSpec,
  isWiredHost,
  sessionUserOf,
  type WiredHost,
  wiredHostNames,
} from './hosts.ts';
import type { WorkTrees } from './worktrees.ts';

/** 总时长比 one-shot 的时限早多久到（毫秒）：驱动先收场，one-shot 的时限信号是兜底。 */
export const SEGMENT_WALL_MARGIN_MS = 60_000;

/** 驱动自己的总时长至少给这么久，免得时限很短（测试）时算出个负数。 */
const MIN_WALL_MS = 10_000;

export interface SegmentSpawnerDeps {
  /** 路由编号 → 执行方式、池、会话用户、上游模型串。不给就用库里的（routeLaunchFacts）。 */
  routeFacts?: (routeId: string) => Promise<RouteLaunchFacts | null>;
  db?: Db;
  drivers: Record<WiredHost, HostDriver>;
  /** 会话临时目录的管理（real/worktrees.ts）：只用这三样。 */
  trees: Pick<WorkTrees, 'tmpFor' | 'adopt' | 'remove'>;
  /** 宿主环境，一般传 process.env；只会抄白名单里的键（adapters 的 buildSessionEnv），凭据类的键进不去。 */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** 一个会话的内存软上限、硬上限、swap 上限（MB）：照 limits.ts 的 SESSION_MEMORY_*，swap 一般给 0。 */
  resources: { memoryHighMb: number; memoryMaxMb: number; swapMaxMb: number };
  /** 帮手脚本、sudo 前缀（测试里给假帮手）。 */
  helper?: string;
  sudo?: readonly string[];
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

function sizeArg(name: string, mb: number): string {
  if (!Number.isSafeInteger(mb) || mb < 0) {
    throw new Error(`会话的资源上限 ${name} 要是非负整数（MB）：${mb}`);
  }
  return mb === 0 ? '0' : `${mb}M`;
}

/**
 * 驱动的报告 → one-shot 要的结局。判法只有 adapters 的 judgeRun 一份：不是 ok 就不是 0。
 * 我们自己的看守杀掉的（killed）：one-shot 按它自己的信号分是超时还是被叫停。
 */
export function outcomeOfReport(report: HostReport): SpawnOutcome {
  const verdict = judgeRun(report.facts);
  const ok = verdict.outcome === 'ok';
  const killed = report.facts.killed !== undefined;
  const facts: SpawnFacts = {
    usage: report.usage,
    ...(report.sessionCostUsd !== undefined ? { costUsd: report.sessionCostUsd } : {}),
    ...(report.actualModel !== undefined ? { actualModel: report.actualModel } : {}),
    quotaExhausted: report.facts.quotaExhausted,
    ...(report.resetsAt !== undefined ? { resetsAt: report.resetsAt } : {}),
    ...(report.httpStatus !== undefined ? { httpStatus: report.httpStatus } : {}),
    reason: verdict.reason,
    detail: verdict.detail,
    ...(report.rawError !== undefined ? { rawError: report.rawError } : {}),
  };
  const nonzero =
    typeof report.facts.exitCode === 'number' && report.facts.exitCode !== 0 ? report.facts.exitCode : 1;
  return {
    exitCode: killed ? null : ok ? 0 : nonzero,
    stdout: report.answer ?? '',
    stderr: [ok ? '' : verdict.detail, report.stderrTail].filter(Boolean).join('\n'),
    killed,
    facts,
  };
}

/**
 * 路由编号 → 库里的路由、执行方式的驱动、会话用户。Spawner 起会话和调用方起会话之前备工作树（要知道树归谁）用同一个查法。
 * 查不到、没接上、定不下会话用户一律抛错（带白话原因），不落到某个默认执行体上。
 */
export async function resolveSegmentRoute(
  deps: Pick<SegmentSpawnerDeps, 'routeFacts' | 'db' | 'drivers'>,
  routeId: string | undefined,
): Promise<{ route: RouteLaunchFacts; driver: HostDriver; user: SessionUser }> {
  if (!routeId) {
    throw new Error('这一段没给路由编号（routeId）：生产 Spawner 不知道该起哪家执行体，也不落到默认的上');
  }
  const lookup =
    deps.routeFacts ??
    (deps.db
      ? (id: string) => routeLaunchFacts(deps.db as Db, id)
      : () => {
          throw new Error('生产 Spawner 没装路由查询：要给 routeFacts 或 db');
        });
  const route = await lookup(routeId);
  if (!route) throw new Error(`库里没有路由 ${routeId}`);
  if (!isWiredHost(route.hostId)) {
    throw new Error(
      `执行方式 ${route.hostId} 引擎还没接上（现在接了 ${wiredHostNames()}）：路由 ${route.routeId}`,
    );
  }
  const driver = deps.drivers[route.hostId];
  const who = sessionUserOf(driver, route.runAsUser);
  if ('missing' in who) throw new Error(`账号池 ${route.poolId} ${who.missing}，起不了会话`);
  return { route, driver, user: who.user };
}

export function hostSegmentSpawner(deps: SegmentSpawnerDeps): OneShotSpawner {
  const log = deps.log ?? (() => undefined);

  return async (cmd) => {
    const { input } = cmd;
    const runId = input.runId;
    const { route, driver, user } = await resolveSegmentRoute(deps, input.routeId);

    const tmpDir = deps.trees.tmpFor(runId);
    await deps.trees.adopt(tmpDir, user);
    const spec: HostRunSpec = {
      runId,
      user,
      cwd: cmd.cwd,
      prompt: cmd.stdin,
      // 一次性段不用 fleet 命令（只认 stdout / 退出码 / 提交）：不发通行证，命令连不上后端是预期
      env: { base: deps.baseEnv, fleetApi: '', fleetToken: '', pathPrepend: [], tmpDir },
      limits: { wallClockMs: Math.max(MIN_WALL_MS, cmd.timeoutMs - SEGMENT_WALL_MARGIN_MS) },
      testCommands: [],
      cgroup: {
        id: runId,
        user,
        limits: {
          memoryHigh: sizeArg('memoryHighMb', deps.resources.memoryHighMb),
          memoryMax: sizeArg('memoryMaxMb', deps.resources.memoryMaxMb),
          memorySwapMax: sizeArg('swapMaxMb', deps.resources.swapMaxMb),
        },
        ...(deps.helper ? { helper: deps.helper } : {}),
        ...(deps.sudo ? { sudo: deps.sudo } : {}),
      },
      model: route.upstreamModel ?? route.modelId,
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      session: { mode: 'new', id: driver.newSessionId(runId).id },
      purpose: 'work',
    };
    try {
      const report = await driver.run(spec, { signal: cmd.signal });
      return outcomeOfReport(report);
    } finally {
      await deps.trees.remove(tmpDir).catch((err: unknown) => {
        log('一次性段会话的临时目录没删掉（引擎下次起来时的清理会收）', {
          runId,
          tmpDir,
          error: message(err),
        });
      });
    }
  };
}
