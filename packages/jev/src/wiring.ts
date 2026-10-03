// 本机的判断题接没接、接了用哪个后端、调不调得通：引擎（提问）和驾驶舱后端（/healthz 的 judge 项）共用这一份，两边判法才一致。
// 只有一种算「未接」：没写 FLEET_JEV_CONFIG、默认位置上也没有配置文件。别的一律算坏了、要报出来，不许当成没配悄悄不问：
// FLEET_JEV_CONFIG 明写的文件不在、文件在却读不到（权限不够、是个目录）、内容认不出、路由两层里判断用途派不出路由、钥匙读不到。
// 用哪条路由按路由两层读（db 的 routingLayers，和选路、驾驶舱「路由」页同一份，#574）：判断用途下模型的先后、再是模型下路由的
// 先后，取第一条不是死的。改这里之前必须知道：「接得上」是不知道（unknown）的照样取——Jev 是按量计费的渠道，路由探针按规矩
// 不探（写 skipped，design 第九节「路由探针」），接得上一直是「不知道」；这里要活的，Jev 就永远问不到。问不通会记成没判出来，
// 照默认走。
import { type Stats, statSync } from 'node:fs';
import { type Db, type RoutingLayers, type RoutingLiveness, routes, routingLayers } from '@fleet-dao/db';
import { eq } from 'drizzle-orm';
import type { JevBackend } from './backend.ts';
import {
  backendForRoute,
  JevConfigError,
  type JevConfigLocation,
  type JevMachineConfig,
  type JudgeRoute,
  loadJevConfig,
} from './config.ts';
import { lastSentCall, type SentCall } from './store.ts';

export type JevPresence =
  | { state: 'absent'; path: string }
  | { state: 'present'; path: string }
  | { state: 'broken'; problem: string };

const errnoOf = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

/**
 * 配置文件在不在。不用 existsSync：它碰上权限不够也回 false，读不到就被当成了「没配」。
 * 只有 ENOENT、而且不是 FLEET_JEV_CONFIG 明写的，才是「未接」。
 */
export function jevConfigPresence(
  where: JevConfigLocation,
  stat: (path: string) => Stats = statSync,
): JevPresence {
  let st: Stats;
  try {
    st = stat(where.path);
  } catch (err) {
    const code = errnoOf(err);
    if (code === 'ENOENT' && !where.explicit) return { state: 'absent', path: where.path };
    if (code === 'ENOENT') {
      return { state: 'broken', problem: `FLEET_JEV_CONFIG 写的 ${where.path} 不存在` };
    }
    return { state: 'broken', problem: `查不了 ${where.path}：${code ?? problemOf(err)}` };
  }
  if (!st.isFile()) return { state: 'broken', problem: `${where.path} 不是文件` };
  return { state: 'present', path: where.path };
}

export type JevSetup =
  | { state: 'absent'; path: string }
  | { state: 'broken'; problem: string }
  | { state: 'ready'; backend: JevBackend; routeId: string };

export type JudgeRoutePick =
  | { state: 'picked'; routeId: string; route: JudgeRoute }
  /** 一条都派不出：problem 写明为什么（用途没配模型顺序、模型下没有路由、每条路由死在哪），不回空当成「没配」。 */
  | { state: 'none'; problem: string };

const deadReasons = (l: RoutingLiveness) =>
  [l.connect, l.quota, l.ban]
    .filter((f) => f.verdict === 'dead')
    .map((f) => f.reason)
    .join('、');

function noJudgeRoute(layers: RoutingLayers): string {
  const dead = layers.models.flatMap((m) =>
    m.routes.map((r) => `${r.candidate.routeId} 死了：${deadReasons(r.liveness)}`),
  );
  return `路由两层里判断用途没有派得出去的路由：${[...layers.problems, ...dead].join('；')}`;
}

/**
 * 路由两层里判断用途排第一、不是死的那条路由；型号用插头实际发给上游的（没填就用目录里的模型号）。
 * 读库出错照常抛（调用方写「读不到」），不当成派不出。
 */
export async function judgeRouteFromDb(db: Db, now: Date): Promise<JudgeRoutePick> {
  const layers = await routingLayers(db, 'judge', { now });
  const pick = layers.models.flatMap((m) => m.routes).find((r) => r.verdict !== 'dead');
  if (!pick) return { state: 'none', problem: noJudgeRoute(layers) };
  const routeId = pick.candidate.routeId;
  const [row] = await db
    .select({ modelId: routes.modelId, upstreamModel: routes.upstreamModel })
    .from(routes)
    .where(eq(routes.id, routeId));
  if (!row) throw new Error(`路由 ${routeId} 在路由两层里排着，routes 里却查不到`);
  return {
    state: 'picked',
    routeId,
    route: { hostId: pick.candidate.hostId, model: row.upstreamModel ?? row.modelId },
  };
}

export interface ResolveOptions extends JevConfigLocation {
  /** 测试里换掉：TypeSafe 后端在测试里不出网。 */
  makeBackend?: (route: JudgeRoute, config: JevMachineConfig) => Promise<JevBackend>;
  stat?: (path: string) => Stats;
  /** 判路由活不活用的「现在」（额度窗、下架、过期都按它算）；不给就是墙钟。 */
  now?: () => Date;
}

function problemOf(err: unknown): string {
  if (err instanceof JevConfigError) return err.problems.join('；');
  if (err instanceof Error) return err.cause instanceof Error ? err.cause.message : err.message;
  return String(err);
}

/** 不抛：读不到、认不出、起不来都变成 broken，原因写明（原因里只有路径、字段名和报错，没有钥匙的值）。 */
export async function resolveJevBackend(db: Db, options: ResolveOptions): Promise<JevSetup> {
  const presence = jevConfigPresence(options, options.stat);
  if (presence.state !== 'present') return presence;
  let config: JevMachineConfig;
  try {
    config = await loadJevConfig(options.path);
  } catch (err) {
    return { state: 'broken', problem: problemOf(err) };
  }
  let picked: JudgeRoutePick;
  try {
    picked = await judgeRouteFromDb(db, (options.now ?? (() => new Date()))());
  } catch (err) {
    return { state: 'broken', problem: `读不到路由两层里判断用途的路由：${problemOf(err)}` };
  }
  if (picked.state === 'none') return { state: 'broken', problem: picked.problem };
  try {
    const make = options.makeBackend ?? ((route, c) => backendForRoute(route, c));
    return { state: 'ready', backend: await make(picked.route, config), routeId: picked.routeId };
  } catch (err) {
    return { state: 'broken', problem: `判断路由 ${picked.routeId} 起不了后端：${problemOf(err)}` };
  }
}

export type JudgeHealth =
  | { state: 'absent'; path: string }
  | { state: 'broken'; problem: string }
  /** 最近一次真发给后端的调用没成（连不上、超时、钥匙不对、回包认不出、答了题面外的……）：下一次调成了自动好。 */
  | { state: 'failing'; call: SentCall }
  | { state: 'ok'; routeId: string; call?: SentCall };

/**
 * /healthz 的 judge 项：先看配置起不起得来（和引擎每次提问同一个 resolveJevBackend），再看最近一次真调用成没成。
 * 查判断记录出错照样抛（交给健康检查报「连不上」），不当成「还没调过」。
 */
export async function judgeHealth(db: Db, options: ResolveOptions): Promise<JudgeHealth> {
  const setup = await resolveJevBackend(db, options);
  if (setup.state !== 'ready') return setup;
  const call = await lastSentCall(db);
  if (call && !call.ok) return { state: 'failing', call };
  return { state: 'ok', routeId: setup.routeId, ...(call ? { call } : {}) };
}
