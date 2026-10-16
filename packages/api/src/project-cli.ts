// fleet-api project show|set-profile（#2738）：看、换一个仓的档案（repos.profile，形状见 shared 的 repo-profile.ts）。
//   project show <owner/仓名>：打印一份 JSON（仓号、档案原文、补了默认值的档案、缺哪几项）。只读。
//   project set-profile <owner/仓名> --file <json 文件|->：整份换掉档案。- 读标准输入（本机经 ssh 调时用它，文件不用先传到法国）。
//     形状不对（不是 JSON、认不出的键、值不对）就拒、库不动；存显式写了的项（去掉首尾空白），和操作记录同一事务；
//     和库里一样就不改不记；改完读回对得上才算改好。
//   project register <owner/仓名> --github-id <仓号> [--default-branch <分支>]（#2749，pnpm project add 第一步调）：登记一个仓。
//     认仓认仓号：没有就建一行（接活关着、档案空）；老行没仓号就补上；一样的不改不记；仓号对不上或已在别的名字上（改名）拒。
// 退出码：0 做成了（或本来就是）；1 没做成（库里没有这个仓、库出错、读回对不上、登记冲突）；2 参数、档案形状不对。
import type { RegisterRepoResult, RepoProfileRow } from '@fleet-dao/db';
import { RepoProfileSchema, repoProfileGaps, safeParseRepoProfile } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';

export const PROJECT_USAGE =
  '用法：fleet-api project show <owner/仓名>（打印仓号、档案原文、补了默认值的档案、缺哪几项，JSON）；fleet-api project set-profile <owner/仓名> --file <json 文件|->（整份换掉档案，形状不对就拒；- 读标准输入，经 ssh 调时用它）；fleet-api project register <owner/仓名> --github-id <仓号> [--default-branch <分支>]（登记一个仓，认仓号；已登记的不改）';

export class ProjectCliError extends Error {
  readonly exitCode: 1 | 2;
  constructor(message: string, exitCode: 1 | 2 = 1) {
    super(message);
    this.name = 'ProjectCliError';
    this.exitCode = exitCode;
  }
}

/** 命令要碰库的几下（真的是 db 的 findRepoProfile、setRepoProfile、registerRepo）。 */
export interface ProjectPort {
  register(input: {
    owner: string;
    name: string;
    githubId: number;
    defaultBranch: string;
    actor: { kind: 'ops'; id: string };
    reason: string;
  }): Promise<RegisterRepoResult>;
  find(owner: string, name: string): Promise<RepoProfileRow | null>;
  setProfile(input: {
    repoId: string;
    profile: Record<string, unknown>;
    actor: { kind: 'ops'; id: string };
    reason: string;
  }): Promise<{ changed: boolean; auditId: number | null } | 'not_found'>;
}

export type ProjectArgs =
  | { action: 'show'; owner: string; name: string }
  | { action: 'set-profile'; owner: string; name: string; file: string }
  | { action: 'register'; owner: string; name: string; githubId: number; defaultBranch: string };

/** 分支名：git 认的常见写法，不收空格和以 - 开头的。 */
const BRANCH_ARG = /^[A-Za-z0-9._/-]+$/;

function parseRegister(repo: string | undefined, rest: readonly string[]): ProjectArgs {
  const target = repoArg(repo);
  const usage = `register 要写成 register <owner/仓名> --github-id <仓号> [--default-branch <分支>]。${PROJECT_USAGE}`;
  let githubId: number | undefined;
  let defaultBranch = 'main';
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('-')) throw new ProjectCliError(usage, 2);
    if (flag === '--github-id' && githubId === undefined) {
      githubId = /^\d+$/.test(value) ? Number(value) : Number.NaN;
      if (!Number.isSafeInteger(githubId) || githubId <= 0)
        throw new ProjectCliError(`--github-id 要正整数（GitHub REST 的仓 id）：${value}`, 2);
    } else if (flag === '--default-branch' && BRANCH_ARG.test(value)) {
      defaultBranch = value;
    } else throw new ProjectCliError(usage, 2);
  }
  if (githubId === undefined) throw new ProjectCliError(usage, 2);
  return { action: 'register', ...target, githubId, defaultBranch };
}

/** GitHub 的写法：owner 是字母、数字、连字符，仓名再加 . 和 _。网址、只写仓名、多一段都认不出（和 dispatch 同一个）。 */
const REPO_ARG = /^([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)$/;

function repoArg(raw: string | undefined): { owner: string; name: string } {
  const m = REPO_ARG.exec(raw ?? '');
  if (!m?.[1] || !m[2])
    throw new ProjectCliError(`认不出仓「${raw ?? ''}」：要写成 owner/仓名。${PROJECT_USAGE}`, 2);
  return { owner: m[1], name: m[2] };
}

export function parseProjectArgs(argv: readonly string[]): ProjectArgs {
  const [action, repo, ...rest] = argv;
  if (action === 'show') {
    if (rest.length > 0 || repo === undefined)
      throw new ProjectCliError(`show 只要一个参数：owner/仓名。${PROJECT_USAGE}`, 2);
    return { action, ...repoArg(repo) };
  }
  if (action === 'set-profile') {
    const target = repoArg(repo);
    if (rest.length !== 2 || rest[0] !== '--file' || !rest[1] || (rest[1].startsWith('-') && rest[1] !== '-'))
      throw new ProjectCliError(
        `set-profile 要写成 set-profile <owner/仓名> --file <json 文件|->。${PROJECT_USAGE}`,
        2,
      );
    return { action, ...target, file: rest[1] };
  }
  if (action === 'register') return parseRegister(repo, rest);
  throw new ProjectCliError(
    `认不出「${action ?? ''}」：只收 show、set-profile、register。${PROJECT_USAGE}`,
    2,
  );
}

/** 操作记录里的「谁」：服务器上的管理命令记成 ops 这一类。 */
const OPS_PROJECT = { kind: 'ops', id: 'ops:project' } as const;

/** jsonb 回来键的顺序会变：按键排好再比。 */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === 'object' && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
        )
      : x,
  );
}

function describeRow(row: RepoProfileRow): Record<string, unknown> {
  const parsed = safeParseRepoProfile(row.profile);
  return {
    repo: `${row.owner}/${row.name}`,
    id: row.id,
    githubId: row.githubId,
    defaultBranch: row.defaultBranch,
    testCommand: row.testCommand,
    ciPolicy: row.ciPolicy,
    autoDispatchSince: row.autoDispatchSince ? row.autoDispatchSince.toISOString() : null,
    profile: row.profile,
    effective: parsed.ok ? parsed.profile : null,
    gaps: repoProfileGaps(row.profile),
    ...(parsed.ok ? {} : { error: parsed.error }),
  };
}

/** 读进来的档案原文 → 要存的那份：校验过、只留显式写了的项（值取校验后的，去掉了首尾空白）。形状不对抛退出码 2。 */
export function profileToStore(text: string, from: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ProjectCliError(`${from} 不是 JSON：${errMessage(err)}`, 2);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new ProjectCliError(`${from} 的档案形状不对：要一个 JSON 对象`, 2);
  const parsed = RepoProfileSchema.safeParse(raw);
  if (!parsed.success) {
    const r = safeParseRepoProfile(raw);
    throw new ProjectCliError(`${from} 的档案形状不对：${r.ok ? '认不出' : r.error}`, 2);
  }
  const data = parsed.data as Record<string, unknown>;
  return Object.fromEntries(Object.keys(raw).map((k) => [k, data[k]]));
}

export async function runProject(
  args: ProjectArgs,
  deps: {
    port: ProjectPort;
    operator: string;
    readFile(path: string): Promise<string>;
    readStdin(): Promise<string>;
  },
): Promise<string> {
  const asked = `${args.owner}/${args.name}`;
  if (args.action === 'show') {
    const row = await deps.port.find(args.owner, args.name);
    if (!row) throw new ProjectCliError(`没查成：库里没有仓 ${asked}（受管的仓就是 repos 表的行）`);
    return JSON.stringify(describeRow(row), null, 2);
  }
  if (args.action === 'register') {
    const r = await deps.port.register({
      owner: args.owner,
      name: args.name,
      githubId: args.githubId,
      defaultBranch: args.defaultBranch,
      actor: OPS_PROJECT,
      reason: `服务器上 ${deps.operator} 跑的 fleet-api project register ${asked} --github-id ${args.githubId}`,
    });
    if (r.outcome === 'conflict') throw new ProjectCliError(`没登记（什么都没改）：${r.why}`);
    if (r.outcome === 'unchanged') return `没改：${asked} 已经登记，仓号 ${args.githubId}`;
    const back = await deps.port.find(args.owner, args.name);
    if (back?.githubId !== args.githubId)
      throw new ProjectCliError(
        `已经写了（操作记录 ${r.auditId}），但读回来仓号对不上：跑 project show 核对`,
      );
    return r.outcome === 'created'
      ? `已登记：${asked}，仓号 ${args.githubId}，默认分支 ${args.defaultBranch}，让 AI 接活关着（操作记录 ${r.auditId}）`
      : `已登记：${asked} 补上了仓号 ${args.githubId}（操作记录 ${r.auditId}）`;
  }

  // 先认档案再连库：形状不对的不碰库
  const from = args.file === '-' ? '标准输入' : args.file;
  let text: string;
  try {
    text = args.file === '-' ? await deps.readStdin() : await deps.readFile(args.file);
  } catch (err) {
    throw new ProjectCliError(`读不到档案文件 ${args.file}：${errMessage(err)}`, 2);
  }
  const profile = profileToStore(text, from);

  const row = await deps.port.find(args.owner, args.name);
  if (!row)
    throw new ProjectCliError(`没改成（什么都没改）：库里没有仓 ${asked}（受管的仓就是 repos 表的行）`);
  const label = `${row.owner}/${row.name}`;
  const change = await deps.port.setProfile({
    repoId: row.id,
    profile,
    actor: OPS_PROJECT,
    reason: `服务器上 ${deps.operator} 跑的 fleet-api project set-profile ${label}`,
  });
  if (change === 'not_found') throw new ProjectCliError(`没改成：仓 ${label} 刚刚不在库里了，什么都没改`);
  if (!change.changed) return `没改：${label} 的档案本来就是这一份`;

  const wrote = `已经写了（操作记录 ${change.auditId ?? '没给编号'}），但`;
  const back = await deps.port.find(row.owner, row.name);
  if (!back) throw new ProjectCliError(`${wrote}读回时库里没有这个仓了：跑 project show 核对`);
  if (canonical(back.profile) !== canonical(profile))
    throw new ProjectCliError(`${wrote}读回来的档案对不上（多半刚被别处改过）：跑 project show 核对`);
  return `已改：${label} 的档案（操作记录 ${change.auditId ?? '没给编号'}）\n${JSON.stringify(describeRow(back), null, 2)}`;
}
