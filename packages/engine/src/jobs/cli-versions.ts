// 命令行工具版本（#1969）：每小时读一遍在用版本和官方最新，写进 cli_tool_readings。
// 改这里之前必须知道：
// - 只读。不跑安装、不跑升级。升级是另一张单。
// - 读不到把原因写进 installed_error / latest_error，不写成 0、ok，也不拿上一次的成功顶掉这一次的失败。
// - 不存「落后」。版本列表原样存；源没给列表就存 null，不许存成只含最新版的数组。
// - 任一工具没读成，这一轮记 partial（原因写进 why）。整轮抛了（库写不进）记 failed。不另推提醒。
// - 不标 needsMaster：不拉单、不起会话，总开关关着也读。

import type { ScheduleResult } from '@fleet-dao/db';
import {
  CLI_NPM_TOOLS,
  CLI_SESSION_USERS,
  CLI_USER_TOOLS,
  type CliToolId,
  cliUserToolsOf,
  parseInstalledOutput,
  parseNpmGlobal,
} from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import type { ScheduleRunLog } from './github-reconcile.ts';

export const CLI_VERSIONS_EVERY_MINUTES = 60;
/** 和每小时对账（41 分）、读额度（4 分）错开。 */
export const CLI_VERSIONS_OFFSET_MINUTES = 11;

export const CLI_VERSIONS_JOB = {
  id: 'cli-versions',
  name: '命令行工具版本',
  schedule: '每小时（11 分起）',
  // 连着三轮没跑成才算过期。
  expectEveryMinutes: 180,
} as const;

export interface CliToolReadingSave {
  scope: 'user' | 'npm';
  owner: string;
  tool: string;
  installedVersion: string | null;
  installedError: string | null;
  latestVersion: string | null;
  latestError: string | null;
  releaseVersions: string[] | null;
  checkedAt: Date;
}

export interface CliLatestOk {
  latest: string;
  versions: string[] | null;
}

export interface CliVersionsJobDeps {
  /** 以这个用户跑写死的版本探测。失败回 error，不许回空串冒充成功。 */
  probeUser(user: string, tool: string): Promise<CliUserProbe>;
  /** 全局 npm 清单（npm ls -g）。一次一个写死的包名，清单可以是整份。 */
  probeNpm(tool: string): Promise<{ stdout: string } | { error: string }>;
  /** 这个工具的官方最新。两个用户共用一次结果。失败回 error。 */
  fetchLatest(tool: string): Promise<CliLatestOk | { error: string }>;
  save(row: CliToolReadingSave): Promise<void>;
  runs: ScheduleRunLog;
  now: () => Date;
  log: (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>) => void;
}

/** version 仅由真接线把受管安装摘要与官方 artifact 核对后返回，不是 CLI stdout。 */
export type CliUserProbe = { stdout: string } | { error: string } | { version: string };

export class CliVersionsFailedError extends Error {
  readonly runId: number;
  constructor(runId: number, message: string) {
    super(message);
    this.name = 'CliVersionsFailedError';
    this.runId = runId;
  }
}

function clip(text: string): string {
  const one = text.trim().replace(/\s+/g, ' ');
  return one.length > 200 ? `${one.slice(0, 200)}…` : one;
}

function installedFrom(
  tool: string,
  probe: CliUserProbe,
): {
  installedVersion: string | null;
  installedError: string | null;
} {
  if ('error' in probe) return { installedVersion: null, installedError: probe.error || '探测没有给出原因' };
  if ('version' in probe)
    return probe.version
      ? { installedVersion: probe.version, installedError: null }
      : { installedVersion: null, installedError: '安装摘要核对没有给出版本' };
  const version = parseInstalledOutput(tool, probe.stdout);
  if (version) return { installedVersion: version, installedError: null };
  const shown = clip(probe.stdout);
  // reclaude 自身版本只认安装摘要核对；万一仍有旧帮手 stdout，不拿里面的数当版本。
  if (tool === 'reclaude')
    return {
      installedVersion: null,
      installedError: `来源不明：reclaude 没有经证实的自身版本输出${shown ? `（输出：${shown}）` : ''}`,
    };
  return {
    installedVersion: null,
    installedError: shown ? `认不出版本：${shown}` : '认不出版本：输出是空的',
  };
}

async function latestOf(
  deps: CliVersionsJobDeps,
  tool: string,
): Promise<{ latestVersion: string | null; latestError: string | null; releaseVersions: string[] | null }> {
  try {
    const got = await deps.fetchLatest(tool);
    if ('error' in got) {
      return { latestVersion: null, latestError: got.error || '官方最新没有给出原因', releaseVersions: null };
    }
    return { latestVersion: got.latest, latestError: null, releaseVersions: got.versions };
  } catch (err) {
    return { latestVersion: null, latestError: errMessage(err), releaseVersions: null };
  }
}

async function round(deps: CliVersionsJobDeps): Promise<ScheduleResult> {
  const now = deps.now();
  const problems: string[] = [];
  const latest = new Map<CliToolId, Awaited<ReturnType<typeof latestOf>>>();
  const tools = [...CLI_USER_TOOLS.map((t) => t.id), ...CLI_NPM_TOOLS.map((t) => t.id)];
  for (const tool of tools) {
    const got = await latestOf(deps, tool);
    latest.set(tool, got);
    if (got.latestError) problems.push(`${tool} 官方最新没查成：${got.latestError}`);
  }

  const save = async (row: CliToolReadingSave) => {
    await deps.save(row);
  };

  for (const user of CLI_SESSION_USERS) {
    for (const tool of cliUserToolsOf(user)) {
      let installed: { installedVersion: string | null; installedError: string | null };
      try {
        installed = installedFrom(tool.id, await deps.probeUser(user, tool.id));
      } catch (err) {
        installed = { installedVersion: null, installedError: errMessage(err) };
      }
      if (installed.installedError)
        problems.push(`${user} 的 ${tool.name} 没读成：${installed.installedError}`);
      const off = latest.get(tool.id) ?? {
        latestVersion: null,
        latestError: '官方最新没读',
        releaseVersions: null,
      };
      await save({
        scope: 'user',
        owner: user,
        tool: tool.id,
        ...installed,
        latestVersion: off.latestVersion,
        latestError: off.latestError,
        releaseVersions: off.releaseVersions,
        checkedAt: now,
      });
    }
  }

  for (const tool of CLI_NPM_TOOLS) {
    let installed: { installedVersion: string | null; installedError: string | null };
    try {
      const probe = await deps.probeNpm(tool.id);
      if ('error' in probe)
        installed = { installedVersion: null, installedError: probe.error || '探测没有给出原因' };
      else {
        const parsed = parseNpmGlobal(probe.stdout, tool.npm);
        installed =
          'error' in parsed
            ? { installedVersion: null, installedError: parsed.error }
            : { installedVersion: parsed.version, installedError: null };
      }
    } catch (err) {
      installed = { installedVersion: null, installedError: errMessage(err) };
    }
    if (installed.installedError)
      problems.push(`全局 npm 的 ${tool.name} 没读成：${installed.installedError}`);
    const off = latest.get(tool.id) ?? {
      latestVersion: null,
      latestError: '官方最新没读',
      releaseVersions: null,
    };
    await save({
      scope: 'npm',
      owner: '',
      tool: tool.id,
      ...installed,
      latestVersion: off.latestVersion,
      latestError: off.latestError,
      releaseVersions: off.releaseVersions,
      checkedAt: now,
    });
  }

  const scanned =
    CLI_SESSION_USERS.reduce((n, user) => n + cliUserToolsOf(user).length, 0) + CLI_NPM_TOOLS.length;
  if (problems.length > 0) {
    const shown = problems.slice(0, 8).join('；');
    return {
      outcome: 'partial',
      why: `${problems.length} 处没读成：${shown}${problems.length > 8 ? '……' : ''}`,
      scanned,
      found: problems.length,
    };
  }
  return { outcome: 'ok', scanned, found: 0 };
}

/**
 * 跑一轮。记开始就失败：原样抛出，这一轮在库里没有记录。
 * 没跑成（库写不进）：记成 failed 再抛，不当成跑成了。
 */
export async function runCliVersionsJob(deps: CliVersionsJobDeps): Promise<ScheduleResult> {
  const runId = await deps.runs.start(CLI_VERSIONS_JOB.id, deps.now());
  let result: ScheduleResult;
  try {
    result = await round(deps);
  } catch (err) {
    result = { outcome: 'failed', why: `命令行工具版本没跑成：${errMessage(err)}` };
  }
  await deps.runs.finish(runId, result, deps.now());
  if (result.outcome === 'failed') {
    deps.log('error', '命令行工具版本这一轮没跑成', { runId, why: result.why });
    throw new CliVersionsFailedError(runId, result.why);
  }
  if (result.outcome === 'ok') deps.log('info', '命令行工具版本读完了', { runId, scanned: result.scanned });
  else deps.log('warn', '命令行工具版本这一轮没读全', { runId, why: result.why });
  return result;
}
