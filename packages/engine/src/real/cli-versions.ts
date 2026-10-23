// 命令行工具版本的真接线（#1969）：经 fleet-agent-scope probe 读在用版本（pilot 只在 probe 白名单里，不走 run），
// 官方最新由引擎进程自己拉发布源。不升级。
import { spawn } from 'node:child_process';
import { type Db, finishScheduleRun, saveCliToolReading, startScheduleRun } from '@fleet-dao/db';
import {
  CLI_NPM_TOOLS,
  CLI_USER_TOOLS,
  matchReclaudeArtifact,
  parseCursorChangelog,
  parseCursorInstallScript,
  parseMirasimChangelog,
  parseMirasimLatest,
  parseNpmRegistry,
  parseReclaudeStable,
  reclaudeOlderTags,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { CliLatestOk, CliVersionsJobDeps } from '../jobs/cli-versions.ts';

const PROBE_TIMEOUT_MS = 25_000;
const FETCH_TIMEOUT_MS = 20_000;
const MAX_OUT = 64 * 1024;

export const CLI_RELEASE_URLS = {
  // .md 后缀是 404。不带后缀、Accept 用 markdown，才是「## vYYYY.MM.DD」正文。
  cursorChangelog: 'https://cursor.com/docs/cli/changelog',
  cursorInstall: 'https://cursor.com/install',
  reclaudeStable: 'https://dl.reclaude.ai/stable.json',
  // 顶层 version 是最新渠道（2026-10-12 是 0.0.481）。更新日志跳号，只在这份读不到时用来认最新版。
  mirasimLatest: 'https://cdn-assets.mirasim.ai/mirasim/releases/latest.json',
  mirasimChangelog: 'https://mirasim.ai/changelog',
} as const;

/**
 * 在用二进制与当前 stable 不符时：落后的话会对上官方某个旧版自己的清单（dl.reclaude.ai/<tag>/stable.json）。
 * 旧版清单取不到、对不上都保持「摘要不符」，不猜版本。
 */
export async function matchReclaudeInstalled(
  stdout: string,
  stableBody: string,
  readOlder: (tag: string) => Promise<string> = (tag) =>
    fetchText(`https://dl.reclaude.ai/${tag}/stable.json`, 'application/json'),
): Promise<{ version: string } | { error: string }> {
  const first = matchReclaudeArtifact(stdout, stableBody);
  if (!('error' in first) || !first.mismatch) return first;
  const latest = parseReclaudeStable(stableBody);
  if ('error' in latest) return latest;
  const bodies = await Promise.all(
    reclaudeOlderTags(latest.latest).map((tag) => readOlder(tag).catch(() => '')),
  );
  const second = matchReclaudeArtifact(stdout, stableBody, bodies);
  return 'error' in second ? { error: second.error } : second;
}

export function cliProbeArgv(
  input: { user: string; tool: string } | { npmTool: string },
  helper = 'fleet-agent-scope',
): string[] {
  if ('npmTool' in input) return ['sudo', '-n', helper, 'probe', '--npm', '--', input.npmTool];
  return ['sudo', '-n', helper, 'probe', '--user', input.user, '--', input.tool];
}

interface ProbeRaw {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  spawnError?: string;
}

export type ProbeRunner = (argv: readonly string[], timeoutMs: number) => Promise<ProbeRaw>;

export function spawnProbe(argv: readonly string[], timeoutMs: number): Promise<ProbeRaw> {
  const [command, ...args] = argv;
  if (!command)
    return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: '命令是空的' });
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflow = false;
    const child = spawn(command, args, {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
      stdio: 'pipe',
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    const take = (buf: Buffer, into: 'out' | 'err') => {
      const text = buf.toString('utf8');
      if (into === 'out') stdout += text;
      else stderr += text;
      if (stdout.length + stderr.length > MAX_OUT) {
        overflow = true;
        child.kill('SIGKILL');
      }
    };
    child.stdout?.on('data', (buf: Buffer) => take(buf, 'out'));
    child.stderr?.on('data', (buf: Buffer) => take(buf, 'err'));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, timedOut, spawnError: errMessage(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (overflow) {
        resolve({ code, stdout, stderr: `${stderr}\n输出超过 ${MAX_OUT} 字节`, timedOut });
        return;
      }
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

function probeOutcome(raw: ProbeRaw): { stdout: string } | { error: string } {
  if (raw.spawnError) return { error: raw.spawnError };
  if (raw.timedOut || raw.code === 124 || raw.code === 137) return { error: '超时被停' };
  if (raw.code !== 0) {
    const tail = (raw.stderr || raw.stdout).trim().split('\n').slice(-3).join(' ');
    return { error: tail || `退出码 ${raw.code}` };
  }
  return { stdout: raw.stdout };
}

async function fetchText(url: string, accept: string): Promise<string> {
  const res = await fetch(url, {
    headers: { accept },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return await res.text();
}

function npmPackage(tool: string): string | null {
  const user = CLI_USER_TOOLS.find((item) => item.id === tool);
  if (user && 'npm' in user && user.npm) return user.npm;
  return CLI_NPM_TOOLS.find((item) => item.id === tool)?.npm ?? null;
}

/** 官方最新。失败回 error，不回空版本。 */
export async function fetchCliLatest(
  tool: string,
  readReclaudeStable = () => fetchText(CLI_RELEASE_URLS.reclaudeStable, 'application/json'),
): Promise<CliLatestOk | { error: string }> {
  const pkg = npmPackage(tool);
  if (pkg) {
    try {
      return parseNpmRegistry(
        await fetchText(`https://registry.npmjs.org/${pkg}`, 'application/vnd.npm.install-v1+json'),
      );
    } catch (err) {
      return { error: errMessage(err) };
    }
  }
  if (tool === 'cursor-agent') {
    let logWhy = '更新日志没抓到';
    try {
      const parsed = parseCursorChangelog(
        await fetchText(CLI_RELEASE_URLS.cursorChangelog, 'text/plain, text/markdown'),
      );
      if (!('error' in parsed)) return parsed;
      logWhy = parsed.error;
    } catch (err) {
      logWhy = errMessage(err);
    }
    try {
      const parsed = parseCursorInstallScript(await fetchText(CLI_RELEASE_URLS.cursorInstall, 'text/plain'));
      if (!('error' in parsed)) return parsed;
      return { error: `更新日志：${logWhy}；安装脚本：${parsed.error}` };
    } catch (err) {
      return { error: `更新日志：${logWhy}；安装脚本：${errMessage(err)}` };
    }
  }
  if (tool === 'reclaude') {
    try {
      return parseReclaudeStable(await readReclaudeStable());
    } catch (err) {
      return { error: errMessage(err) };
    }
  }
  if (tool === 'mirasim-server') {
    let jsonWhy = 'latest.json 没抓到';
    try {
      const parsed = parseMirasimLatest(await fetchText(CLI_RELEASE_URLS.mirasimLatest, 'application/json'));
      if (!('error' in parsed)) return parsed;
      jsonWhy = parsed.error;
    } catch (err) {
      jsonWhy = errMessage(err);
    }
    try {
      const parsed = parseMirasimChangelog(await fetchText(CLI_RELEASE_URLS.mirasimChangelog, 'text/html'));
      // 更新日志跳号，列表不能当「落后几个」。只借用它认得出的最新版。
      if (!('error' in parsed)) return { latest: parsed.latest, versions: null };
      return { error: `latest.json：${jsonWhy}；更新日志：${parsed.error}` };
    } catch (err) {
      return { error: `latest.json：${jsonWhy}；更新日志：${errMessage(err)}` };
    }
  }
  return { error: `不认识的工具：${tool}` };
}

export interface CliVersionsWiring {
  db: Db;
  now?: () => Date;
  log?: CliVersionsJobDeps['log'];
  /** 测试换掉真正的 sudo。默认 spawnProbe。 */
  run?: ProbeRunner;
  helper?: string;
}

export function cliVersionsJob(w: CliVersionsWiring): () => CliVersionsJobDeps {
  const now = w.now ?? (() => new Date());
  const log: CliVersionsJobDeps['log'] =
    w.log ?? ((level, text, fields) => console[level === 'info' ? 'info' : level](text, fields ?? {}));
  const run = w.run ?? spawnProbe;
  const helper = w.helper ?? 'fleet-agent-scope';
  const call = async (argv: string[]) => probeOutcome(await run(argv, PROBE_TIMEOUT_MS));
  return () => {
    // 每轮共用一次官方读取（包括失败），两个用户的安装摘要和 latest 都对同一份清单；下一轮重新取。
    let stable: Promise<string> | undefined;
    const readStable = () => (stable ??= fetchText(CLI_RELEASE_URLS.reclaudeStable, 'application/json'));
    return {
      probeUser: async (user, tool) => {
        const got = await call(cliProbeArgv({ user, tool }, helper));
        if (tool !== 'reclaude' || 'error' in got) return got;
        try {
          return await matchReclaudeInstalled(got.stdout, await readStable());
        } catch (err) {
          return { error: `来源不明：reclaude 官方 artifact 没读成：${errMessage(err)}` };
        }
      },
      probeNpm: (tool) => call(cliProbeArgv({ npmTool: tool }, helper)),
      fetchLatest: (tool) => fetchCliLatest(tool, readStable),
      save: (row) => saveCliToolReading(w.db, row),
      runs: {
        start: (job, at) => startScheduleRun(w.db, job, at),
        finish: (id, result, at) => finishScheduleRun(w.db, id, result, at),
      },
      now,
      log,
    };
  };
}
