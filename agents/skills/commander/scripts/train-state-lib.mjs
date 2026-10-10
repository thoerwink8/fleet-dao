// 发版车状态文件（~/.fleet-dao/release-train.json）的读法、各步上限、驱动死活的判法。
// 单拆一份：巡查（patrol.mjs，受类型检查）也要读它，而 release-train-lib.mjs 里有真的 ssh 自举脚本、不在类型检查范围内。
// 这里没有任何起进程、连网、睡觉的代码。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scrubText } from './france-lib.mjs';

export const STATE_REL = join('.fleet-dao', 'release-train.json');

export const stateFile = (/** @type {string} */ home) => join(home, STATE_REL);
const minutes = (/** @type {number} */ ms) => Math.round(ms / 60_000);

/**
 * 各阶段的上限（毫秒）和轮询间隔；测试里整份换小。等收尾只等两样：主线 CI 20 分钟、法国在跑的会话 13 分钟（沿用排空上限）；
 * 本机在跑的工人、自动合并的 PR 两项只提示不等（创始人 2026-10-06「不合理的想法你自由决定，都改掉」，母单 #1121：它们和法国发版无关，
 * 会把无关的事卡住；release.sh 自己还会排空一遍）。数值写在 agents/test/release-train.test.ts。
 */
export const DEFAULT_LIMITS = {
  preflightMs: 2 * 60_000,
  pauseMs: 60_000,
  ciMs: 20 * 60_000,
  franceMs: 13 * 60_000,
  releaseMs: 15 * 60_000,
  deployMs: 20 * 60_000,
  verifyMs: 5 * 60_000,
  restoreMs: 60_000,
  pollMs: 30_000,
  /** 判「驱动死了」：心跳比该步上限还老这么久（驱动在长 ssh 里写不了心跳，所以要留余量）。 */
  deadMarginMs: 5 * 60_000,
};

export const PHASES = ['预检', '暂停本机', '暂停法国', '等收尾', '发版', '等部署', '验证', '恢复', '派清单'];

/** @typedef {{ pid?: number, host?: string, heartbeatAt?: string }} Driver */
/** @typedef {{ phase: number, status?: string, updatedAt?: string, driver?: Driver, target?: { kind: string, value: string }, founderOk?: string }} TrainState */

/**
 * 读状态：没有是 { ok: true, state: null }；在但读不了、认不出是 { ok: false, why }（不覆盖它）。
 * @param {{ home: string }} io
 * @returns {{ ok: true, state: any } | { ok: false, why: string }}
 */
export function readState(io) {
  const file = stateFile(io.home);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    const code = e && typeof e === 'object' && 'code' in e ? e.code : undefined;
    if (code === 'ENOENT') return { ok: true, state: null };
    return { ok: false, why: `${file} 读不了（${code ?? (e instanceof Error ? e.message : String(e))}）` };
  }
  try {
    const s = JSON.parse(text);
    if (s === null || typeof s !== 'object' || s.schema !== 1 || !Number.isInteger(s.phase))
      return { ok: false, why: `${file} 认不出（不是这个脚本写的）：确认没有发版在走后删掉它再来` };
    return { ok: true, state: s };
  } catch (e) {
    return {
      ok: false,
      why: `${file} 不是 JSON（${e instanceof Error ? e.message : String(e)}）：确认没有发版在走后删掉它再来`,
    };
  }
}

/** 各步的时间上限（毫秒），判心跳过期用。 */
function phaseBudgetMs(/** @type {number} */ phase, /** @type {typeof DEFAULT_LIMITS} */ L) {
  switch (phase) {
    case 0:
      return L.preflightMs;
    case 1:
    case 2:
      return L.pauseMs;
    case 3:
      return Math.max(L.ciMs, L.franceMs);
    case 4:
      return L.releaseMs;
    case 5:
      return L.deployMs + 5 * 60_000; // 后面还有 release.sh --check，最长 5 分钟
    case 6:
      return L.verifyMs;
    default:
      return L.restoreMs;
  }
}

/**
 * status 是 running 的那一趟，驱动还活着吗：{ dead: true|false, why }。
 * 死＝同一台机器上记下的 pid 不在了，或心跳（没有 driver 的老状态用 updatedAt）比该步上限加余量还老。
 * 心跳时刻认不出不当成死，也不当成活：dead false、unknown true，why 写明。
 * @param {TrainState} s
 * @param {{ now: Date, isAlive?: ((pid: number) => boolean) | undefined, host?: string | undefined, limits?: Partial<typeof DEFAULT_LIMITS> | undefined }} ctx
 * @returns {{ dead: boolean, unknown?: boolean, why: string }}
 */
export function driverVerdict(s, ctx) {
  const L = { ...DEFAULT_LIMITS, ...(ctx.limits ?? {}) };
  const d = s.driver;
  if (
    d &&
    typeof d.pid === 'number' &&
    Number.isInteger(d.pid) &&
    typeof ctx.isAlive === 'function' &&
    (!d.host || !ctx.host || d.host === ctx.host) &&
    !ctx.isAlive(d.pid)
  )
    return { dead: true, why: `驱动进程（pid ${d.pid}）不在了` };
  const beatText = d?.heartbeatAt ?? s.updatedAt ?? '';
  const beat = Date.parse(beatText);
  if (!Number.isFinite(beat))
    return {
      dead: false,
      unknown: true,
      why: `心跳时刻认不出（${scrubText(String(beatText))}），判不了驱动死活`,
    };
  const age = ctx.now.getTime() - beat;
  const budget = phaseBudgetMs(s.phase, L) + L.deadMarginMs;
  if (age > budget)
    return {
      dead: true,
      why: `最后一次心跳是 ${minutes(age)} 分钟前，超过这一步的上限加余量（${minutes(budget)} 分钟）`,
    };
  return { dead: false, why: `最后一次心跳 ${minutes(age)} 分钟前${d?.pid ? `，pid ${d.pid}` : ''}` };
}

/**
 * 巡查报「引擎总开关关着」时附的一句：现读发版车状态，说清开关是不是发版车关的、驱动是不是死了。读不到也写明，不装没事。
 * @param {{ home: string, now: Date, isAlive?: ((pid: number) => boolean) | undefined, host?: string | undefined }} ctx
 * @returns {string}
 */
export function trainAlertNote(ctx) {
  const read = readState({ home: ctx.home });
  if (!read.ok) return `发版车状态读不到（${read.why}）`;
  const s = read.state;
  if (!s) return '没有发版车在走（没有状态文件）';
  const step = `第 ${s.phase} 步「${PHASES[s.phase] ?? '？'}」`;
  if (s.status === 'running') {
    const v = driverVerdict(s, { now: ctx.now, isAlive: ctx.isAlive, host: ctx.host });
    if (v.dead)
      return `发版车驱动死在${step}，没人恢复（${v.why}；node release-train.mjs status 看，同一个目标再 start 接着走）`;
    return `发版车在走（${step}，${v.why}），开关是它关的`;
  }
  if (s.status === 'blocked' || s.status === 'failed')
    return `发版车停在${step}（${s.status === 'blocked' ? '卡住了' : '没成'}），等人处理，没人恢复开关`;
  return `发版车没在走（上一趟${s.status === 'done' ? '做完了' : s.status === 'aborted' ? '已撤销' : s.status}）`;
}
