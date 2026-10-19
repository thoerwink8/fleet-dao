// fleet-api task correct-merged：预检只读；--apply 才经 Store 的事务纠正。
// 不发信号、不重开 issue、不改 Temporal、不手写 SQL。操作者只认 FLEET_OPS_OPERATOR，不退回本机用户名。

import type { CorrectMergedLedger } from '@fleet-dao/db';
import type { Store } from '@fleet-dao/store';
import { z } from 'zod';
import { TaskCliError } from './task-cli.ts';
import {
  type CorrectionRequest,
  type CorrectMergedSnapshot,
  type ExecutionFacts,
  type IssueFacts,
  operatorAllowed,
  type PullFacts,
  workflowBelongs,
} from './task-correct-merged.ts';
import {
  type CorrectMergedPorts,
  type CorrectMergedReport,
  runCorrectMerged,
} from './task-correct-merged-run.ts';

export const CORRECT_MERGED_USAGE =
  '用法：fleet-api task correct-merged <owner/仓名> <单号> --pr <PR> --head <40位sha> --merge <40位sha> ' +
  '--workflow <任务工作流编号> --run <原 run id> --note "<为什么>" [--apply]' +
  '（不带 --apply 只预检，打印将核对的对象和拟改成的 done/merged，不写库。' +
  '--apply 再读一遍，仍一致才在同一事务里改任务行并写操作记录。' +
  '原 abandoned 结论、原 run、Temporal 历史和待验责任都不改，也不关 GitHub 单。' +
  '操作者只认 FLEET_OPS_OPERATOR。退出码：0 预检通过、已纠正或本来就是；1 拒绝或没查成；2 参数不对）';

const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;
const SHA = /^[a-f\d]{40}$/i;
const MAX_NOTE = 300;
const ID_MAX = 256;

export interface CorrectMergedArgs {
  owner: string;
  name: string;
  issueNumber: number;
  prNumber: number;
  head: string;
  mergeCommit: string;
  workflowId: string;
  runId: string;
  note: string;
  apply: boolean;
}

function usage(message: string): never {
  throw new TaskCliError(`${message}。${CORRECT_MERGED_USAGE}`, 2);
}

function flag(argv: readonly string[], name: string): string {
  const index = argv.indexOf(name);
  if (index < 0) usage(`缺 ${name}`);
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) usage(`${name} 后面要跟值`);
  if (argv.indexOf(name, index + 1) >= 0) usage(`${name} 只能给一次`);
  return value;
}

function positive(raw: string, label: string): number {
  if (!/^[1-9]\d{0,8}$/.test(raw)) usage(`${label}「${raw}」不是正整数`);
  return Number(raw);
}

function identity(raw: string, label: string): string {
  const value = raw.trim();
  if (value !== raw || value.length === 0 || value.length > ID_MAX || /\s/.test(value)) {
    usage(`${label} 不能空、不能有空白，最长 ${ID_MAX}`);
  }
  return value;
}

/** 恰好这些参数。认不出的拒，不猜。 */
export function parseCorrectMergedArgs(argv: readonly string[]): CorrectMergedArgs {
  if (argv.includes('--help') || argv.includes('-h')) usage('帮助');
  const positionals: string[] = [];
  const known = new Set(['--pr', '--head', '--merge', '--workflow', '--run', '--note', '--apply']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg === '--apply') continue;
    if (known.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith('-')) usage(`认不出参数 ${arg.split('=')[0]}`);
    positionals.push(arg);
  }
  if (positionals[0] !== 'correct-merged') usage('动作必须是 correct-merged');
  if (positionals.length !== 3) usage('要 correct-merged、仓、单号');
  const repo = positionals[1] ?? '';
  const matched = REPO_ARG.exec(repo);
  if (!matched?.[1] || !matched[2]) usage(`认不出仓「${repo}」：要写成 owner/仓名`);
  const head = flag(argv, '--head');
  const merge = flag(argv, '--merge');
  if (!SHA.test(head) || !SHA.test(merge)) usage('head 和 merge 都要是完整 sha');
  const note = flag(argv, '--note').trim();
  if (note === '') usage('--note 必填（写进操作记录）');
  if (note.length > MAX_NOTE) usage(`--note 太长（最多 ${MAX_NOTE} 个字）`);
  const workflowId = identity(flag(argv, '--workflow'), '工作流编号');
  return {
    owner: matched[1],
    name: matched[2],
    issueNumber: positive(positionals[2] ?? '', '单号'),
    prNumber: positive(flag(argv, '--pr'), 'PR'),
    head,
    mergeCommit: merge,
    workflowId,
    runId: identity(flag(argv, '--run'), 'run'),
    note,
    apply: argv.includes('--apply'),
  };
}

export function requestOf(args: CorrectMergedArgs): CorrectionRequest {
  return {
    repo: { owner: args.owner, name: args.name },
    issueNumber: args.issueNumber,
    prNumber: args.prNumber,
    head: args.head,
    mergeCommit: args.mergeCommit,
    workflowId: args.workflowId,
    runId: args.runId,
  };
}

const PullBody = z.object({
  number: z.number().int(),
  merged: z.boolean(),
  head: z.object({ sha: z.string() }),
  merge_commit_sha: z.string().nullable(),
  base: z.object({ repo: z.object({ full_name: z.string() }).nullable() }),
});

const IssueBody = z.object({
  number: z.number().int(),
  pull_request: z.unknown().optional(),
});

export interface GitHubGet {
  request(input: {
    method: 'GET';
    path: string;
    auth: { as: 'engine'; repo: { owner: string; name: string } };
    allow?: readonly number[];
  }): Promise<{ status: number; data: unknown }>;
}

function repoOf(fullName: string): { owner: string; name: string } {
  const slash = fullName.indexOf('/');
  const owner = slash < 0 ? '' : fullName.slice(0, slash);
  const name = slash < 0 ? '' : fullName.slice(slash + 1);
  if (!owner || !name || name.includes('/')) throw new Error('GitHub 上的仓名读不全');
  return { owner, name };
}

async function getJson(
  github: GitHubGet,
  repo: { owner: string; name: string },
  path: string,
): Promise<unknown | null> {
  const response = await github.request({
    method: 'GET',
    path,
    auth: { as: 'engine', repo },
    allow: [404],
  });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new Error(`读不到 GitHub（HTTP ${response.status}）`);
  return response.data;
}

/** 只 GET。404 是没有。形状缺字段是读不全，不把缺的 merged 当成 false。不读 issue 的 state。 */
export async function readGitHubCorrection(
  github: GitHubGet,
  repo: { owner: string; name: string },
  issueNumber: number,
  prNumber: number,
): Promise<{ issue: IssueFacts | null; pull: PullFacts | null }> {
  const issueData = await getJson(github, repo, `/repos/${repo.owner}/${repo.name}/issues/${issueNumber}`);
  const pullData = await getJson(github, repo, `/repos/${repo.owner}/${repo.name}/pulls/${prNumber}`);
  let issue: IssueFacts | null = null;
  if (issueData !== null) {
    const parsed = IssueBody.safeParse(issueData);
    if (!parsed.success) throw new Error('GitHub issue 读不全');
    issue = {
      number: parsed.data.number,
      repo,
      isPullRequest: parsed.data.pull_request !== undefined,
    };
  }
  let pull: PullFacts | null = null;
  if (pullData !== null) {
    const parsed = PullBody.safeParse(pullData);
    if (!parsed.success) throw new Error('GitHub PR 读不全');
    if (parsed.data.base.repo === null) throw new Error('GitHub PR 的仓读不全');
    pull = {
      repo: repoOf(parsed.data.base.repo.full_name),
      number: parsed.data.number,
      merged: parsed.data.merged,
      head: parsed.data.head.sha,
      mergeCommit: parsed.data.merge_commit_sha,
    };
  }
  return { issue, pull };
}

export function snapshotFrom(
  ledger: CorrectMergedLedger | null,
  github: { issue: IssueFacts | null; pull: PullFacts | null },
  execution: ExecutionFacts,
): CorrectMergedSnapshot {
  if (!ledger) {
    return {
      task: null,
      sessions: [],
      mirror: null,
      corrections: [],
      issue: github.issue,
      pull: github.pull,
      execution,
    };
  }
  const parsed = ledger.task.updatedAt === null ? null : Date.parse(ledger.task.updatedAt);
  return {
    task: {
      id: ledger.task.id,
      repo: ledger.task.repo,
      issueNumber: ledger.task.issueNumber,
      state: ledger.task.state,
      phase: ledger.task.phase,
      executor: ledger.task.executor,
      updatedAtMs: parsed !== null && Number.isFinite(parsed) ? parsed : null,
      openRunCount: ledger.task.openRunCount,
    },
    sessions: ledger.sessions,
    mirror: ledger.mirror,
    corrections: ledger.corrections,
    issue: github.issue,
    pull: github.pull,
    execution,
  };
}

export function portsFromParts(parts: {
  ledger: Pick<Store, 'readCorrectMergedLedger' | 'casCorrectMerged'>;
  github: GitHubGet;
  execution(req: CorrectionRequest): Promise<ExecutionFacts>;
}): CorrectMergedPorts {
  return {
    execution: (req) => parts.execution(req),
    async read(req) {
      const ledger = await parts.ledger.readCorrectMergedLedger({
        owner: req.repo.owner,
        name: req.repo.name,
        issueNumber: req.issueNumber,
        prNumber: req.prNumber,
      });
      const github = await readGitHubCorrection(parts.github, req.repo, req.issueNumber, req.prNumber);
      const execution = await parts.execution(req);
      return snapshotFrom(ledger, github, execution);
    },
    cas(input) {
      return parts.ledger.casCorrectMerged(input);
    },
  };
}

export interface OpenedCorrectMerged {
  ports: CorrectMergedPorts;
  close(): Promise<void>;
}

/** 真端口：库、GitHub 只读、Temporal 只 describe/result。测试换掉这一层，不在这里打生产。 */
export async function openCorrectMerged(
  env: Readonly<Record<string, string | undefined>>,
): Promise<OpenedCorrectMerged> {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new TaskCliError(
      '没有 DATABASE_URL：要带上 /etc/fleet-dao/api.env 跑（用 packages/api/bin/fleet-api）',
      2,
    );
  }
  const { createDb } = await import('@fleet-dao/db');
  const { createPgStore, pgLedger, pgLocker, withStatementTimeout } = await import('@fleet-dao/store');
  const { createGitHub } = await import('@fleet-dao/github');
  const { connectTemporal, readCorrectMergedExecution } = await import('./temporal.ts');
  const { temporalSettings } = await import('./config.ts');
  const { db, close } = createDb({ url: withStatementTimeout(url) });
  const settings = temporalSettings(env);
  const temporal = connectTemporal({
    address: settings.temporalAddress,
    namespace: settings.temporalNamespace,
    taskQueue: settings.fleetTaskQueue,
  });
  const github = createGitHub({ ledger: pgLedger(db), locker: pgLocker(db) }).client;
  const store = createPgStore(db);
  try {
    return {
      ports: portsFromParts({
        ledger: store,
        github,
        execution: (req) =>
          readCorrectMergedExecution(temporal.correctMerged, {
            repo: req.repo,
            issueNumber: req.issueNumber,
            workflowId: req.workflowId,
            runId: req.runId,
          }),
      }),
      close: async () => {
        await temporal.close().catch(() => undefined);
        await close();
      },
    };
  } catch (error) {
    await temporal.close().catch(() => undefined);
    await close();
    throw error;
  }
}

export interface CorrectMergedCliDeps {
  env: Readonly<Record<string, string | undefined>>;
  out(text: string): void;
  err(text: string): void;
  openCorrectMerged?: (env: Readonly<Record<string, string | undefined>>) => Promise<OpenedCorrectMerged>;
}

function reportLine(report: CorrectMergedReport): string {
  return JSON.stringify(report);
}

/** 参数不对不连库。拒绝打一行 JSON 到标准输出，退出码 1。连不上打到标准错误。 */
export async function runCorrectMergedCommand(
  rest: readonly string[],
  deps: CorrectMergedCliDeps,
): Promise<number> {
  if (rest.includes('--help') || rest.includes('-h')) {
    deps.out(CORRECT_MERGED_USAGE);
    return 0;
  }
  let args: CorrectMergedArgs;
  try {
    args = parseCorrectMergedArgs(rest);
  } catch (err) {
    if (err instanceof TaskCliError && err.message.startsWith('帮助')) {
      deps.out(CORRECT_MERGED_USAGE);
      return 0;
    }
    if (err instanceof TaskCliError) {
      deps.err(err.message);
      return err.exitCode;
    }
    throw err;
  }
  const req = requestOf(args);
  const operator = deps.env.FLEET_OPS_OPERATOR?.trim() ?? '';
  const mode = args.apply ? 'apply' : 'precheck';
  if (!operatorAllowed(operator) || !workflowBelongs(req.workflowId, req.repo, req.issueNumber)) {
    const report = await runCorrectMerged(req, operator, args.note, mode, {
      read: () => Promise.reject(new Error('前置不成立，不应读取')),
      execution: () => Promise.reject(new Error('前置不成立，不应读取')),
      cas: () => Promise.reject(new Error('前置不成立，不应写入')),
    });
    deps.out(reportLine(report));
    return 1;
  }
  let opened: OpenedCorrectMerged | undefined;
  try {
    opened = await (deps.openCorrectMerged ?? openCorrectMerged)(deps.env);
    const report = await runCorrectMerged(req, operator, args.note, mode, opened.ports);
    deps.out(reportLine(report));
    return report.status === 'refused' ? 1 : 0;
  } finally {
    await opened?.close().catch(() => undefined);
  }
}
