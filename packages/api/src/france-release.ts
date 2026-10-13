// 法国发版一键（/france 页 #618）的进度：GET /api/france/release-state 读 release-train 的记录和暂停标记，
// 判断这一趟在走 / 暂停 / 没在走。读不到一律回 unreadable，不拿「没在走」顶。
// 「发版预检」不在这里起进程：见 france-preflight.ts，进程内读事实，不读 home。
//
// 读进度包成 FranceReleasePort，deps 里给。单测换假的读文件。开发、内存版没给时接口回没接上。
// 形状约定见 packages/shared/src/web-api/france-release.ts。

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type FranceReleaseState, FranceReleaseStateSchema } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { reply } from './http.ts';
import type { CockpitEnv } from './session.ts';

const STATE_REL = join('.fleet-dao', 'release-train.json');
const MARKER_REL = join('.fleet-dao', 'release-train.paused');
/** 法国上驾驶舱按钮那一趟（root 的 fleet-release-request 单元）写进度的地方（归 root，后端只读）：有就读它，没有才读本机 ~。 */
export const TRAIN_DIR = '/srv/fleet-dao-releases/.train';

/**
 * 一台后端的「读 release-train 状态」接口。生产（main.ts 正式装配）给真实现：
 * 法国上 root 写的进度目录优先；没有才看当前用户的 ~（指挥官在本机跑 release-train 的）。
 * 发版预检不走这里：那条会碰到 home，法国后端 ProtectHome 读不了。
 */
export interface FranceReleasePort {
  /** 读两个状态文件、拼出这一刻那一趟的状态。读不到抛错，由 readFranceReleaseState 包成 unreadable。 */
  readStateFiles(): Promise<{ stateJson: string | null; marker: boolean }>;
}

interface ReleaseTrainStateFile {
  /** release-train-lib.mjs 写的是 number（0..N，PHASES 数组下标）；按 number 收，转成人话。 */
  schema?: number;
  /** running 在走；blocked 卡住；failed 没成；done 做完了；aborted 撤销了。 */
  status?: string;
  why?: string | null;
  updatedAt?: string;
  phase?: number;
  target?: { kind?: string; value?: string };
  /** 九步时间线（#2026，法国接活脚本写）：这一趟开始、每一步开始的时间、此刻在等什么、拖后腿的。老记录没有。 */
  startedAt?: string;
  steps?: unknown;
  waiting?: unknown;
  laggards?: unknown;
  /** 发版前记下的总开关状态（第 2 步写）：恢复引擎开关、撤掉暂停按它判断（#2027）。 */
  before?: { master?: unknown } | null;
  // 真文件里字段不止这些（marker、france、release、verify、restore、changes、warn 等），但页面现在只用这几样；
  // 少写没用到的字段，将来的字段自然装进 extra，不在这里约束。
}

/** phase 下标翻人话：release-train-lib 的 PHASES 数组顺序；写下标 + 名（免得 release-train 改顺序时这句话过时）。 */
const PHASE_NAMES = [
  '预检',
  '暂停本机',
  '暂停法国',
  '等收尾',
  '发版',
  '等部署',
  '验证',
  '恢复',
  '派清单',
] as const;

function describePhase(phase: ReleaseTrainStateFile['phase']): string {
  if (typeof phase !== 'number' || !Number.isInteger(phase)) return '（没写走到第几步）';
  const name = PHASE_NAMES[phase];
  return name === undefined ? `第 ${phase} 步（认不出是哪步）` : `第 ${phase} 步「${name}」`;
}

function describeTarget(target: ReleaseTrainStateFile['target']): string {
  if (!target || typeof target !== 'object') return '（没写目标）';
  if (target.kind === 'tag' && typeof target.value === 'string') return target.value;
  if (typeof target.value === 'string' && target.value.length > 0) {
    return `提交 ${target.value.slice(0, 12)}`;
  }
  return '（没写目标）';
}

const TRAIN_STATUSES = ['running', 'blocked', 'failed', 'done', 'aborted'] as const;
export type TrainStatus = (typeof TRAIN_STATUSES)[number];

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const isoOrNull = (v: unknown): string | null => (typeof v === 'string' && ISO.test(v) ? v : null);

/** 九步时间线（#2026）：phase 不是整数就没有时间线（认不出走到哪，不画）；steps、waiting 认不出的按没写。 */
export function trainTimeline(parsed: ReleaseTrainStateFile): TrainTimeline | null {
  const { phase } = parsed;
  if (typeof phase !== 'number' || !Number.isInteger(phase) || phase < 0 || phase >= PHASE_NAMES.length) {
    return null;
  }
  const raw = Array.isArray(parsed.steps) ? (parsed.steps as unknown[]) : [];
  return {
    phase,
    startedAt: isoOrNull(parsed.startedAt),
    steps: PHASE_NAMES.map((_, i) => isoOrNull(raw[i])),
    waiting: typeof parsed.waiting === 'string' && parsed.waiting !== '' ? parsed.waiting : null,
    laggards: Array.isArray(parsed.laggards)
      ? (parsed.laggards as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
  };
}

export interface TrainTimeline {
  phase: number;
  startedAt: string | null;
  steps: (string | null)[];
  waiting: string | null;
  laggards: string[];
}

/** 一份进度记录读成这一趟的样子；认不出（不是 JSON、没写 status、status 不认识）回 { ok: false }，不猜、不当成没在走。 */
export function parseTrainState(json: string):
  | {
      ok: true;
      status: TrainStatus;
      phase: string;
      /** phase 的下标（0..8）；认不出是 null。 */
      phaseIndex: number | null;
      /** 发版前引擎总开关是开着（true）还是关着（false）；没记下是 null。 */
      beforeMaster: boolean | null;
      target: string;
      /** 目标的 40 位提交号（kind sha 时）；对 last-request.json 里同一趟的体检结论用。 */
      targetSha: string | null;
      why: string | null;
      updatedAt: string | null;
      timeline: TrainTimeline | null;
    }
  | { ok: false; why: string } {
  let parsed: ReleaseTrainStateFile;
  try {
    parsed = JSON.parse(json) as ReleaseTrainStateFile;
  } catch {
    return { ok: false, why: '状态文件不是合法 JSON（不猜、不拿它当没在走）' };
  }
  if (parsed === null || typeof parsed !== 'object') return { ok: false, why: '状态文件不是一个对象' };
  const status = (TRAIN_STATUSES as readonly string[]).includes(parsed.status ?? '')
    ? (parsed.status as TrainStatus)
    : undefined;
  if (status === undefined) {
    return {
      ok: false,
      why: `状态文件里的 status 认不出（${String(parsed.status).slice(0, 20)}）：不猜这一趟是在走还是做完了`,
    };
  }
  return {
    ok: true,
    status,
    phase: describePhase(parsed.phase),
    phaseIndex:
      typeof parsed.phase === 'number' && Number.isInteger(parsed.phase) && parsed.phase >= 0
        ? parsed.phase
        : null,
    beforeMaster: typeof parsed.before?.master === 'boolean' ? parsed.before.master : null,
    target: describeTarget(parsed.target),
    targetSha:
      typeof parsed.target?.value === 'string' && /^[0-9a-f]{40}$/.test(parsed.target.value)
        ? parsed.target.value
        : null,
    why: typeof parsed.why === 'string' ? parsed.why : null,
    updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    timeline: trainTimeline(parsed),
  };
}

export async function readFranceReleaseState(
  port: FranceReleasePort | undefined,
  now: () => Date,
): Promise<FranceReleaseState> {
  const asOf = now().toISOString();
  if (!port) {
    return {
      state: 'unreadable',
      why: '这台后端没接上 release-train 状态文件的读取（开发、内存版），不知道在不在走',
      asOf,
    };
  }
  let files: { stateJson: string | null; marker: boolean };
  try {
    files = await port.readStateFiles();
  } catch (err) {
    return { state: 'unreadable', why: `读状态文件没成：${errMessage(err)}`, asOf };
  }
  if (files.stateJson === null) {
    return files.marker ? { state: 'paused', asOf } : { state: 'idle', asOf };
  }
  const t = parseTrainState(files.stateJson);
  if (!t.ok) return { state: 'unreadable', why: t.why, asOf };
  // 做完了、撤销了的记录还留在盘上，不算「在走」（只有在走、卡住、没成的才是还没了结）
  if (t.status === 'done' || t.status === 'aborted') {
    return files.marker ? { state: 'paused', asOf } : { state: 'idle', asOf };
  }
  return {
    state: 'running',
    status: t.status,
    why: t.why,
    phase: t.phase,
    target: t.target,
    marker: files.marker,
    asOf,
  };
}

export function registerFranceReleaseRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  // WebRoutes 写在前端共享里，路径都在 /api 之下。预检的 POST 在 france-preflight.ts。
  app.get('/france/release-state', async (c) =>
    reply(c, FranceReleaseStateSchema, await readFranceReleaseState(deps.franceRelease, deps.now)),
  );
}

// —— 生产装配（main.ts 挂）用到的真实现 ——

/** 真 port：法国上 root 写的进度目录优先；没有就看当前用户的 ~。发版预检不走这个 port。 */
export function liveFranceReleasePort(trainDir: string = TRAIN_DIR): FranceReleasePort {
  const home = homedir();
  const statePath = join(home, STATE_REL);
  const markerPath = join(home, MARKER_REL);
  const trainState = join(trainDir, 'release-train.json');
  const trainMarker = join(trainDir, 'release-train.paused');
  return {
    async readStateFiles() {
      // 驾驶舱按钮那一趟（法国上 root 写）的进度记录优先；没有就看本机 ~（指挥官在本机跑 release-train 的）
      const statePick = existsSync(trainState) ? trainState : statePath;
      const stateJson = existsSync(statePick) ? await readFile(statePick, 'utf8') : null;
      return { stateJson, marker: existsSync(trainMarker) || existsSync(markerPath) };
    },
  };
}
