// pnpm issue:close <号> --note "…"（#241；#654 改过；#3740 收成关单两条路之一）：
//   ① 有 PR 的活：PR 的「需求」栏下面写 Closes #号，合并时 GitHub 自己关，PR 就是交付记录；
//   ② 没有 PR 的收尾（母单、配置、手工操作、做完了没人关的、不做了的）：用这个命令。
// 关成「完成」必须带证据：--note 必填且非空，写一句凭什么算做完，没有就拒关。以前还认「时间线上有合并了的 PR 提到它」和
// 「子单都关了」当证据、不写 note 也能关：那两样是机器猜的，会把「提到过」当「做完了」，#3740 删了，要关就自己写一句。
// 更早要主线上有 specs/<号>-<短名>/结果.md（#654 删了）。
// 经 gh 读写：读不到 GitHub、读回来认不出一律明确报错、不关（CloseUnchecked，退出码 2），条件不够的拒关（CloseRefused，
// 退出码 1），不拿「没读到」当「没有」，也不拿「没报错」当「关上了」（关完回读）。
import type { Gh, GhResult } from './issue-new.ts';
import { managedCloseGate } from './managed-work.ts';

// —— pnpm issue:close <号> ——

export const CLOSE_USAGE =
  '用法：pnpm issue:close <单号> --note "做成了什么" [--reason <completed|not_planned|duplicate>] [--superseded-by <号>]' +
  '（默认走 completed：--note 必填、不能为空，写一句凭什么算做完；有 PR 的活不走这里，PR 写 Closes #号 合并时自动关；' +
  '--superseded-by 关成 not_planned、评论里写「被 #<号> 取代」；' +
  '--reason not_planned|duplicate 只换关成的样子，不要证据，「子单、是 PR」规则照走；--note 的话写进评论）';

/** 拒关：条件不够（没有证据、子单还开着、是 PR、参数不对）。入口退出码 1。 */
export class CloseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseRefused';
  }
}

/** 没查成、没关成：读不到 GitHub、读回来认不出、关单报错、关完回读对不上。入口退出码 2。 */
export class CloseUnchecked extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloseUnchecked';
  }
}

export interface IssueCloseDeps {
  gh: Gh;
  managed?: typeof managedCloseGate;
}

export type IssueCloseResult =
  | {
      outcome: 'closed';
      number: number;
      issueUrl: string;
      /** 关成 completed 时才有：凭什么算做完（合并了的 PR、子单都关了、--note 那一句）。其它关法没有。 */
      evidence?: string;
    }
  | { outcome: 'already'; number: number; issueUrl: string; stateReason: string | null };

/** 子单一次读 100 张，到了就算没读全。 */
const SUB_ISSUES_MAX = 100;

export async function issueClose(argv: readonly string[], deps: IssueCloseDeps): Promise<IssueCloseResult> {
  const args = parseArgs(argv);
  const { gh } = deps;
  const n = args.number;
  const reason = args.supersededBy === undefined ? (args.reason ?? 'completed') : ('not_planned' as const);
  if (args.supersededBy !== undefined && args.reason !== undefined && args.reason !== 'not_planned') {
    throw new CloseRefused(
      `--superseded-by 隐含关成 not_planned（被取代、留史）；想关成 ${args.reason} 就别带 --superseded-by。没关。`,
    );
  }
  const supersededBy = args.supersededBy;
  const isCompleted = reason === 'completed';

  const issue = await readIssue(gh, n, `读 #${n}`);
  if (issue.pull) throw new CloseRefused(`#${n} 是 PR，不是单，没关。`);
  if (issue.state === 'closed') {
    return { outcome: 'already', number: n, issueUrl: issue.url, stateReason: issue.stateReason };
  }

  // 验收责任账不再挡关单（#3630，决定 0113 第二片）：旧行已一次性交回原单，这里只剩受管工作的关单门。
  try {
    await (deps.managed ?? managedCloseGate)(gh, issue.repoUrl, n);
  } catch (e) {
    if (e instanceof CloseRefused) throw e;
    throw new CloseUnchecked(`受管工作没查成，没关：${e instanceof Error ? e.message : String(e)}`);
  }
  const subs = await subIssues(gh, n);
  const openSubs = subs.filter((s) => s.state === 'open').map((s) => s.number);
  if (openSubs.length > 0) {
    throw new CloseRefused(
      `#${n} 下面还有 ${openSubs.length} 张子单开着（${openSubs.map((s) => `#${s}`).join('、')}），没关：子单都做完、各自用 Closes 或 pnpm issue:close --note 关了，再关这张。`,
    );
  }

  // --superseded-by 给的号要真实存在、是一张单——不然评论里写了个死链，留史也没意义。
  if (supersededBy !== undefined) await checkSupersededBy(gh, n, supersededBy);

  // completed 要有证据；superseded-by（或显式 --reason not_planned / duplicate）跳过这一项。
  const done = isCompleted ? completedEvidence(issue, args.note) : undefined;

  const comment =
    supersededBy !== undefined
      ? `被 #${supersededBy} 取代，留史。${noteBlock(args.note)}（pnpm issue:close --superseded-by 关的，不查证据。）`
      : done
        ? done.comment
        : `关成 ${reason}。${noteBlock(args.note)}（pnpm issue:close --reason 关的，「完成」之外的关法走这里。）`;
  // gh 命令行的 --reason 只认带空格的「not planned」（REST 读回来的 state_reason 才是 not_planned）：
  // 原来把 not_planned 原样交给 gh，gh 报 invalid argument，--reason not_planned 和 --superseded-by 一直关不了单（撞到）
  const ghReason = reason === 'not_planned' ? 'not planned' : reason;
  const closed = await gh(['issue', 'close', String(n), '--reason', ghReason, '--comment', comment]);
  if (closed.code !== 0) {
    throw new CloseUnchecked(
      `gh 关单报错（退出码 ${closed.code}）：${detail(closed)}。单可能关了也可能没关：去 GitHub 看一眼 #${n}，没关就重跑。`,
    );
  }
  const after = await readIssue(gh, n, `关完回读 #${n}`);
  const reasonCn =
    reason === 'completed'
      ? '完成'
      : reason === 'not_planned'
        ? '不做了（not_planned）'
        : '重复（duplicate）';
  if (after.state !== 'closed' || after.stateReason !== reason) {
    throw new CloseUnchecked(
      `关完回读 #${n}：state=${after.state}、state_reason=${after.stateReason ?? '（空）'}，不是「关了、${reasonCn}」：去 GitHub 看一眼。`,
    );
  }
  return done
    ? { outcome: 'closed', number: n, issueUrl: after.url, evidence: done.evidence }
    : { outcome: 'closed', number: n, issueUrl: after.url };
}

const noteBlock = (note: string | undefined): string => (note === undefined ? '\n\n' : `\n\n${note}\n\n`);

/** completed 的证据只认 --note（#3740）：必填、非空（parseArgs 已拒空串），没有就拒关。 */
function completedEvidence(
  issue: IssueFacts,
  note: string | undefined,
): { evidence: string; comment: string } {
  if (note !== undefined && note !== '') {
    return {
      evidence: `--note：${note}`,
      comment: `做完了：${note}\n\n（pnpm issue:close --note 关的，没有 PR 的收尾。）`,
    };
  }
  throw new CloseRefused(
    `#${issue.number} 没带 --note，没关：关成「完成」要写一句凭什么算做完（pnpm issue:close ${issue.number} --note "做成了什么"）。` +
      `有 PR 的活不走这里：在 PR 的「需求」栏另起一行写 Closes #${issue.number}，合并时 GitHub 自己关。`,
  );
}

/** --superseded-by 给的号要真实存在、是一张单（不能是 PR、不能是被关的这张自己）。读不到、认不出报 CloseUnchecked；指错位置报 CloseRefused。 */
async function checkSupersededBy(gh: Gh, n: number, by: number): Promise<void> {
  if (by === n) {
    throw new CloseRefused(`--superseded-by 不能给这张单自己（#${n}）。被谁取代，写谁的号。`);
  }
  const target = await readIssue(gh, by, `读取代它的 #${by}`);
  if (target.pull) {
    throw new CloseRefused(
      `--superseded-by #${by} 是 PR，不是单。取代关系指向一张单；要给 PR 留史挂链接，直接评论、别用 --superseded-by。`,
    );
  }
}

interface ParsedCloseArgs {
  number: number;
  reason: 'completed' | 'not_planned' | 'duplicate' | undefined;
  supersededBy: number | undefined;
  note: string | undefined;
}

function parseArgs(argv: readonly string[]): ParsedCloseArgs {
  const args = argv[0] === '--' ? argv.slice(1) : [...argv];
  let number: number | undefined;
  let reason: ParsedCloseArgs['reason'];
  let supersededBy: number | undefined;
  let note: string | undefined;
  const seen = new Set<string>();
  const FLAGS = ['--reason', '--superseded-by', '--note'];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === undefined) throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
    const bad = (): never => {
      throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
    };
    let flag: string | null = null;
    let value: string | undefined;
    const eq = FLAGS.find((f) => a.startsWith(`${f}=`));
    if (FLAGS.includes(a)) {
      flag = a;
      value = args[++i];
    } else if (eq !== undefined) {
      flag = eq;
      value = a.slice(eq.length + 1);
    }
    if (flag !== null) {
      if (seen.has(flag)) bad();
      seen.add(flag);
      if (value === undefined || value.trim() === '') {
        throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
      }
      if (flag === '--reason') {
        if (value !== 'completed' && value !== 'not_planned' && value !== 'duplicate') {
          throw new CloseRefused(
            `--reason 只认 completed / not_planned / duplicate（读到：${value}）。${CLOSE_USAGE}`,
          );
        }
        reason = value;
      } else if (flag === '--note') {
        note = value.trim();
      } else {
        const m = /^#?([1-9]\d*)$/.exec(value.trim());
        if (!m?.[1]) {
          throw new CloseRefused(`--superseded-by 要给存在的单号（读到：${value}）。${CLOSE_USAGE}`);
        }
        supersededBy = Number(m[1]);
      }
      continue;
    }
    if (a.startsWith('-') || number !== undefined) bad();
    const m = /^#?([1-9]\d*)$/.exec(a.trim());
    if (!m?.[1]) {
      throw new CloseRefused(`参数不对（${args.join(' ')}）。${CLOSE_USAGE}`);
    }
    number = Number(m[1]);
  }
  if (number === undefined) throw new CloseRefused(`没给单号。${CLOSE_USAGE}`);
  return { number, reason, supersededBy, note };
}

interface IssueFacts {
  number: number;
  state: 'open' | 'closed';
  stateReason: string | null;
  pull: boolean;
  url: string;
  /** 这张单所在仓的 API 地址：时间线里「谁提到了它」要和它比，别的仓提到的不算。 */
  repoUrl: string;
}

async function readIssue(gh: Gh, n: number, what: string): Promise<IssueFacts> {
  const raw = asObject(await readJson(gh, ['api', `repos/{owner}/{repo}/issues/${n}`], what), `#${n}`);
  const {
    number,
    state,
    state_reason: reason,
    pull_request: pull,
    html_url: url,
    repository_url: repoUrl,
  } = raw;
  if (number !== n)
    throw new CloseUnchecked(`gh ${what}：要的是 #${n}，读回来的是 ${String(number)}，没关。`);
  if ((state !== 'open' && state !== 'closed') || typeof url !== 'string') {
    throw new CloseUnchecked(`gh ${what}：读回来的 state、html_url 认不出，没关。`);
  }
  if (typeof repoUrl !== 'string' || !repoUrl) {
    throw new CloseUnchecked(`gh ${what}：读回来的 repository_url 认不出，没关。`);
  }
  if (reason !== null && reason !== undefined && typeof reason !== 'string') {
    throw new CloseUnchecked(`gh ${what}：读回来的 state_reason 认不出，没关。`);
  }
  return {
    number,
    state,
    stateReason: typeof reason === 'string' ? reason : null,
    pull: pull !== undefined && pull !== null,
    url,
    repoUrl,
  };
}

interface SubIssue {
  number: number;
  state: 'open' | 'closed';
}

/** 下面的子单（GitHub 自带的子议题），开着的、关了的都要。读不到、认不出、没读全都抛 CloseUnchecked。 */
async function subIssues(gh: Gh, n: number): Promise<SubIssue[]> {
  const subs = await readJson(
    gh,
    ['api', `repos/{owner}/{repo}/issues/${n}/sub_issues?per_page=${SUB_ISSUES_MAX}`],
    `读 #${n} 的子单`,
  );
  if (!Array.isArray(subs)) throw new CloseUnchecked(`gh 读 #${n} 的子单：读回来的不是列表，没关。`);
  if (subs.length >= SUB_ISSUES_MAX) {
    throw new CloseUnchecked(`#${n} 的子单有 ${SUB_ISSUES_MAX} 张以上，这里只读一页，没读全，没关。`);
  }
  const out: SubIssue[] = [];
  for (const s of subs) {
    const o = isObject(s) ? s : {};
    if (typeof o.number !== 'number' || (o.state !== 'open' && o.state !== 'closed')) {
      throw new CloseUnchecked(`gh 读 #${n} 的子单：有一张认不出（没有 number、state），没关。`);
    }
    out.push({ number: o.number, state: o.state });
  }
  return out.sort((a, b) => a.number - b.number);
}

async function readJson(gh: Gh, args: string[], what: string): Promise<unknown> {
  const r = await gh(args);
  if (r.code !== 0) throw new CloseUnchecked(`gh ${what}失败（退出码 ${r.code}）：${detail(r)}，没关。`);
  try {
    return JSON.parse(r.stdout);
  } catch (e) {
    throw new CloseUnchecked(
      `gh ${what}读回来的不是 JSON（${e instanceof Error ? e.message : String(e)}），没关。`,
    );
  }
}

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!isObject(v)) throw new CloseUnchecked(`gh 读回来的${what}认不出（不是一个对象），没关。`);
  return v;
}

function detail(r: GhResult): string {
  return (r.stderr.trim() || r.stdout.trim() || '（gh 什么也没说）').replace(/\s+/g, ' ');
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
