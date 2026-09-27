// 会话脱开引擎进程（发布、重启引擎不碰在跑的会话，specs/169 09-28 凌晨拍板）：收发目录的根怎么核，每个会话的接回记录
// （meta.json）怎么写、怎么读。会话的输入输出、退出码走文件（adapters 的 detached.ts），引擎重启后照这份记录和库里那一行接回。
// 改这里之前必须知道：
// - 根目录归引擎（fleet）、0711：会话用户要能按路径进到自己那个收发目录（写输出、读提示词），但列不出别的会话；
//   france.sh 建它。不对（没建、属主或权限不对）引擎照旧接管道起会话、推提醒——明说「这一版发布还会停会话」，不装作脱开了。
// - meta.json 只存接回要的：不存环境、通行证（接回不起进程，用不着；它们也不该落盘）。0600，只有引擎读得了。
// - 认不出的记录不猜：读不成、形状不对就接不回，交回 SESSION_LOST 由工作流续会话（原来的会话按 scope 收掉）。
import { statSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SESSION_USERS, type SessionUser } from '@fleet-dao/adapters';
import type { Db } from '@fleet-dao/db';
import { resolveAlertWithReason, upsertAlert } from '@fleet-dao/db';
import type { StageKind } from '@fleet-dao/shared';
import {
  type ContinueMode,
  type HostRunSpec,
  type HostSession,
  isWiredHost,
  type WiredHost,
} from './hosts.ts';
import type { OomCounters } from './kill-evidence.ts';
import type { OutputKind } from './prompts.ts';

/** 收发目录的根（france.sh 建，fleet:fleet 0711）；引擎配置 FLEET_SESSION_IO_DIR 可以换。 */
export const DEFAULT_SESSION_IO_DIR = '/var/lib/fleet-sessions';
export const META_FILE = 'meta.json';
export const IO_ROOT_ALERT_KEY = 'engine-session-io';

/**
 * 根目录能不能用：在、是目录、归引擎自己、自己能读写进、别人只能进不能读写（0711 这一类）。能用回 undefined，不能用回原因。
 * uid 不给就取这个进程的；null = 认不出（Windows 上没有：一律不能用，开发机走管道）。
 */
export function checkIoRoot(dir: string, uid: number | null = process.getuid?.() ?? null): string | undefined {
  if (!dir.startsWith('/')) return `收发目录的根要写绝对路径：${dir}`;
  // 认不出用 null 表示（显式传 undefined 会被换成默认值）
  if (uid === null) return '这台机器认不出进程的用户号（不是 Linux），不脱开跑';
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dir);
  } catch (error) {
    return `收发目录的根 ${dir} 不在或看不了（${error instanceof Error ? error.message : String(error)}）：france.sh 没跑过这一版？`;
  }
  if (!st.isDirectory()) return `收发目录的根 ${dir} 不是目录`;
  if (st.uid !== uid) return `收发目录的根 ${dir} 不归引擎（属主 uid ${st.uid}，引擎是 ${uid}）`;
  const mode = st.mode & 0o777;
  if ((mode & 0o700) !== 0o700 || (mode & 0o006) !== 0 || (mode & 0o001) === 0) {
    return `收发目录的根 ${dir} 权限是 ${mode.toString(8)}，要 711（引擎读写、会话用户只能按路径进去、谁都列不出）`;
  }
  return undefined;
}

/** 根目录不能用时推一条提醒（能用了撤掉）：驾驶舱看得到「这一版发布还会停会话」。写不进去照抛，调用方记日志。 */
export async function reportIoRoot(
  db: Db,
  machine: string,
  why: string | undefined,
  now: () => Date = () => new Date(),
): Promise<void> {
  if (why === undefined) {
    await resolveAlertWithReason(db, {
      dedupeKey: IO_ROOT_ALERT_KEY,
      by: 'engine:sessions',
      why: '收发目录的根能用了，会话脱开引擎跑',
      at: now(),
    });
    return;
  }
  await upsertAlert(db, {
    dedupeKey: IO_ROOT_ALERT_KEY,
    level: 'alert',
    taskId: null,
    title: `${machine}的引擎会话没脱开跑：发布、重启引擎还会停在跑的会话`,
    body: `${why}。引擎照旧接管道起会话（停机前排空、到点停下再续），在法国重跑一次 deploy/france.sh 建好它、下一次发布起就不停会话了（docs/ops.md 第九节「发布不碰会话」）。`,
  });
}

/** 接回一个会话要的全部：看守的状态 + 插头的参数（不含环境、通行证）。 */
export interface SessionMeta {
  v: 1;
  runId: string;
  sessionId: string;
  agentSessionId: string | null;
  hostId: WiredHost;
  taskId: string;
  stage: StageKind;
  kind: OutputKind;
  mode: ContinueMode;
  user: SessionUser;
  poolId: string;
  routeId: string;
  dir: string;
  baseHead: string | null;
  defaultBranch: string;
  reviewHead: string | null;
  verifyCriteria: string[] | null;
  /** 续会话时上一轮的会话累计花费；null = 上一轮没读到；没有这个键 = 不是续会话。 */
  previousCost?: number | null;
  startedAt: number;
  oomBefore: OomCounters;
  limits: HostRunSpec['limits'];
  testCommands: string[];
  cgroupLimits: HostRunSpec['cgroup']['limits'] | null;
  model: string;
  session: HostSession;
  purpose: HostRunSpec['purpose'];
}

const MODES = new Set<string>(['new', 'resume', 'fork', 'relay']);

/** 先写到旁边再改名：引擎写到一半被杀，留下的是没有记录（接不回），不是半截记录。 */
export async function writeSessionMeta(dir: string, meta: SessionMeta): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o711 });
  await chmod(dir, 0o711);
  const tmp = join(dir, `${META_FILE}.tmp`);
  await writeFile(tmp, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  await rename(tmp, join(dir, META_FILE));
}

function need(ok: boolean, what: string): void {
  if (!ok) throw new Error(`接回记录里 ${what} 不对`);
}

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const strOrNull = (v: unknown) => v === null || typeof v === 'string';

/** 认记录：形状不对照实抛（哪一项不对），不补默认值。 */
export function parseSessionMeta(text: string): SessionMeta {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`接回记录不是 JSON（${error instanceof Error ? error.message : String(error)}）`);
  }
  need(typeof raw === 'object' && raw !== null && !Array.isArray(raw), '整体');
  const m = raw as Record<string, unknown>;
  need(m.v === 1, `版本（${String(m.v)}）`);
  for (const k of [
    'runId',
    'sessionId',
    'taskId',
    'stage',
    'kind',
    'poolId',
    'routeId',
    'dir',
    'defaultBranch',
    'model',
  ]) {
    need(str(m[k]), k);
  }
  for (const k of ['agentSessionId', 'baseHead', 'reviewHead']) need(strOrNull(m[k]), k);
  need(typeof m.hostId === 'string' && isWiredHost(m.hostId), 'hostId');
  need(typeof m.mode === 'string' && MODES.has(m.mode), 'mode');
  need((SESSION_USERS as readonly unknown[]).includes(m.user), 'user');
  need(
    m.verifyCriteria === null ||
      (Array.isArray(m.verifyCriteria) && m.verifyCriteria.every((c) => typeof c === 'string')),
    'verifyCriteria',
  );
  need(
    !('previousCost' in m) || m.previousCost === null || typeof m.previousCost === 'number',
    'previousCost',
  );
  need(typeof m.startedAt === 'number' && Number.isFinite(m.startedAt), 'startedAt');
  need(typeof m.oomBefore === 'object' && m.oomBefore !== null, 'oomBefore');
  need(typeof m.limits === 'object' && m.limits !== null, 'limits');
  need(Array.isArray(m.testCommands) && m.testCommands.every((c) => typeof c === 'string'), 'testCommands');
  need(m.cgroupLimits === null || typeof m.cgroupLimits === 'object', 'cgroupLimits');
  const s = m.session as Record<string, unknown> | null;
  need(
    typeof s === 'object' &&
      s !== null &&
      str(s.id) &&
      (s.mode === 'new' || s.mode === 'resume' || (s.mode === 'fork' && str(s.from))),
    'session',
  );
  need(m.purpose === 'work' || m.purpose === 'probe', 'purpose');
  return m as unknown as SessionMeta;
}

/** 读一个收发目录里的记录：读不成、认不出都回原因。 */
export async function readSessionMeta(dir: string): Promise<{ meta: SessionMeta } | { error: string }> {
  let text: string;
  try {
    text = await readFile(join(dir, META_FILE), 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      error:
        code === 'ENOENT' ? '没有接回记录（这个会话不是脱开跑的）' : `接回记录读不成（${String(error)}）`,
    };
  }
  try {
    return { meta: parseSessionMeta(text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
