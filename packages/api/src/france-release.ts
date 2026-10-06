// 法国发版一键（/france 页 #618）：这一台后端自己替页面做两件事——
// 1. GET /api/france/release-state：读 ~/.fleet-dao/release-train.json 和 ~/.fleet-dao/release-train.paused，
//    判断 release-train 此刻在走 / 暂停 / 没在走。读不到一律回 unreadable，不拿「没在走」顶（机底线）。
// 2. POST /api/france/preflight：起子进程跑 `pnpm release:onekey preflight`，命令写死、不收参数（#618 的红色就是「不开放任意 CLI」）。
//    60 秒超时、512KB maxBuffer（溢出的截掉、truncated=true）；起进程都没起来时回 unreadable + 原因。stdout/stderr 原样回给页面分块 show。
//
// 这两个能力都包成一个 port（FranceReleasePort），deps 里给。这样：
// - 单测（france-release.test.ts）换假的读文件、起子进程，不真起 pnpm、不真靠 home；
// - 开发、内存版后端 deps 没给时接口照样回，写明「没接上」，不拿「没在走」「预检过了」顶。
//
// 形状约定见 packages/shared/src/web-api/france-release.ts。

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type FrancePreflightResponse,
  FrancePreflightResponseSchema,
  type FranceReleaseState,
  FranceReleaseStateSchema,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { Hono } from 'hono';
import type { Deps } from './deps.ts';
import { reply } from './http.ts';
import type { Logger } from './ports.ts';
import type { CockpitEnv } from './session.ts';

const execFileAsync = promisify(execFile);

// 命令固定写死：这就是「不开放任意 CLI」的实现——页面和后端之间只走 POST /france/preflight 召唤，
// 起什么、带什么参数都写在这份文件里，前端不给任何口子（#618 的红色）。
const PREFLIGHT_TIMEOUT_MS = 60_000;
const PREFLIGHT_MAX_BUFFER = 512 * 1024;

const STATE_REL = join('.fleet-dao', 'release-train.json');
const MARKER_REL = join('.fleet-dao', 'release-train.paused');

/**
 * 一台后端的「读 release-train 状态 + 跑预检」接口。生产（main.ts 正式装配）给真实现：
 * home 用当前用户的 ~、cwd 用进程自己启动的工作目录（release.sh 是 cd 到发布目录起的），
 * 起 pnpm 经 spawnSync（Windows 下 pnpm 是 .cmd 套壳，走 shell:true 同 release-onekey.mjs 的做法）。
 */
export interface FranceReleasePort {
  /** 读两个状态文件、拼出这一刻那一趟的状态。读不到抛错，由 readFranceReleaseState 包成 unreadable。 */
  readStateFiles(): Promise<{ stateJson: string | null; marker: boolean }>;
  /** 起子进程跑预检，返回退出码 / 信号 / stdout / stderr。起进程自己抛错（pnpm 不在 PATH、不能 fork）。 */
  runPreflight(): Promise<{
    code: number | null;
    signal: string | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>;
}

interface ReleaseTrainStateFile {
  /** release-train-lib.mjs 写的是 number（0..N，PHASES 数组下标）；按 number 收，转成人话。 */
  schema?: number;
  phase?: number;
  target?: { kind?: string; value?: string };
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
  let parsed: ReleaseTrainStateFile;
  try {
    parsed = JSON.parse(files.stateJson) as ReleaseTrainStateFile;
  } catch {
    return { state: 'unreadable', why: '状态文件不是合法 JSON（不猜、不拿它当没在走）', asOf };
  }
  return {
    state: 'running',
    phase: describePhase(parsed.phase),
    target: describeTarget(parsed.target),
    marker: files.marker,
    asOf,
  };
}

export async function runFrancePreflight(
  port: FranceReleasePort | undefined,
  now: () => Date,
): Promise<FrancePreflightResponse> {
  const asOf = now().toISOString();
  if (!port) {
    return {
      state: 'unreadable',
      why: '这台后端没接上 release:onekey 的执行（开发、内存版）；到法国那台的驾驶舱开才有这颗按钮',
      asOf,
    };
  }
  const startedAt = now().getTime();
  let r: Awaited<ReturnType<FranceReleasePort['runPreflight']>>;
  try {
    r = await port.runPreflight();
  } catch (err) {
    return { state: 'unreadable', why: `起 pnpm release:onekey preflight 没成：${errMessage(err)}`, asOf };
  }
  const durationMs = Math.max(0, now().getTime() - startedAt);
  // 输出已经按 maxBuffer 截断（node 的 execFile 到 maxBuffer 自己就截掉并设 error.code='ERR_CHILD_PROCESS_STDIO_MAXBUFFER_EXCEEDED'，
  // 但起子进程那一层把它当作完成、stdout/stderr 是截好的内容）。truncated 由 port 自己报更准确。
  const stdout = r.stdout.length > PREFLIGHT_MAX_BUFFER ? r.stdout.slice(0, PREFLIGHT_MAX_BUFFER) : r.stdout;
  const stderr = r.stderr.length > PREFLIGHT_MAX_BUFFER ? r.stderr.slice(0, PREFLIGHT_MAX_BUFFER) : r.stderr;
  const truncated = r.stdout.length > PREFLIGHT_MAX_BUFFER || r.stderr.length > PREFLIGHT_MAX_BUFFER;
  return {
    state: 'done',
    // 命令原样 show：让人看到这次跑的是哪条。命令固定写死，show 出来也不漏参数（没有参数可注）。
    command: 'pnpm release:onekey preflight',
    code: r.code,
    signal: r.signal,
    stdout,
    stderr,
    durationMs,
    timedOut: r.timedOut,
    truncated,
    asOf,
  };
}

export function registerFranceReleaseRoutes(app: Hono<CockpitEnv>, deps: Deps): void {
  // WebRoutes 写在前端共享里，路径都在 /api 之下
  app.get('/france/release-state', async (c) =>
    reply(c, FranceReleaseStateSchema, await readFranceReleaseState(deps.franceRelease, deps.now)),
  );
  app.post('/france/preflight', async (c) =>
    reply(c, FrancePreflightResponseSchema, await runFrancePreflight(deps.franceRelease, deps.now)),
  );
}

// —— 生产装配（main.ts 挂）用到的真实现 ——

/**
 * 真 port：home 是当前用户的 ~；cwd 是 process.cwd()（release.sh 把驾驶舱后端在发布目录里起）；pnpm 走 shell:true 以便 Windows 下 .cmd 起得来。
 * 这和 release-onekey.mjs 里 run 的「Windows 下 pnpm 走 cmd.exe」等价——execFile 的 shell:true 在 Windows 上会让 cmd.exe 解析。
 */
export function liveFranceReleasePort(log: Logger): FranceReleasePort {
  const home = homedir();
  const statePath = join(home, STATE_REL);
  const markerPath = join(home, MARKER_REL);
  return {
    async readStateFiles() {
      const stateJson = existsSync(statePath) ? await readFile(statePath, 'utf8') : null;
      return { stateJson, marker: existsSync(markerPath) };
    },
    async runPreflight() {
      // env 用 process.env 原样过（带上代理变量，让 pnpm 找得到网络；release-onekey.mjs 里 gh 自己有直连再代理的两条路）。
      // shell：Windows 下 pnpm 是 .cmd 套壳，要 cmd.exe 来解析；POSIX 下 shell:true 走 /bin/sh，pnpm 在 PATH 里就行。
      // cwd：不发参数（继承 process.cwd()）——release.sh 是在发布目录里起的，预检读到的状态（在跑会话、落后主线）就是这台后端自己看到的那份。
      try {
        const r = await execFileAsync('pnpm', ['release:onekey', 'preflight'], {
          encoding: 'utf8',
          timeout: PREFLIGHT_TIMEOUT_MS,
          maxBuffer: PREFLIGHT_MAX_BUFFER,
          windowsHide: true,
          shell: true,
        });
        return {
          code: 0,
          signal: null,
          stdout: r.stdout ?? '',
          stderr: r.stderr ?? '',
          timedOut: false,
        };
      } catch (err: unknown) {
        // 非零退出码、超时被杀、stdio 截断：node 都走 reject。这种是「起得来、跑完了但没过」，不是「起不来」——
        // 照样回 done 让页面 show 输出和退出码。起不来（pnpm 不在 PATH、fork 失败）的 err 没有 stdout/stderr 字段，往上抛。
        const e = err as {
          code?: number | string | null;
          signal?: string | null;
          stdout?: string;
          stderr?: string;
          killed?: boolean;
        };
        if (typeof e.stdout === 'string' || typeof e.stderr === 'string') {
          const timedOut = e.signal === 'SIGTERM' && e.killed === true;
          return {
            code: typeof e.code === 'number' ? e.code : null,
            signal: typeof e.signal === 'string' ? e.signal : null,
            stdout: e.stdout ?? '',
            stderr: e.stderr ?? '',
            timedOut,
          };
        }
        log.warn('发版预检起子进程没成', { error: errMessage(err) });
        throw err;
      }
    },
  };
}
