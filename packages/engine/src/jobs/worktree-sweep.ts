// 工作树对账（每小时对账的一项，design 第十四节「AI 会话」的目录那条）：子任务收尾时删树没成的、工作流被强行终止没收尾的、
// 分诊 / 需求文档 / 方案 / 审查 / 开 PR 前验证的检出副本（没有谁删它们），都会在工作树的根下攒着（旧系统攒到 162 棵，拖慢整机）。
// 一轮：列根下每个仓的每棵树 → 认出是哪张需求的 → 需求工作流和它的子任务工作流都不在跑了、树里也没有没结束的会话，才算
// 残留 → 以会话用户的身份看树里还剩什么 → 什么都不剩就删（fleet-agent-scope remove）；能重新生成的编译和工具缓存
// （*.tsbuildinfo、node_modules/ 这些，名单是 real/user-git.ts 的 DISPOSABLE）不算剩着，只剩这些的树照空树删，是不是 git 仓
// 都一样；还剩没推的提交、没提交的改动、stash、名单以外的文件就不删，报「要人拍」（删数据要人拍），列出前几个、写明
// 一共几个。`_route-probe/<会话用户>` 是路由探针常驻的目录，不算残留。
// 改之前必须知道：「在用」只认任务工作流（task:，含重做后的 :rN）和旧子任务工作流（sub:）；新加一种会在树里起会话的工作流，要在 issueUse
// 里一起认。认漏了还有一道：树里有没结束的会话（session_runs）就不碰。
// 顺带撤提醒：子任务报的「工作树没收掉」（sub:<子任务>:worktree）、Fusion 报的（req:<仓>#<号>:worktree，按这张需求的
// Fusion 树认）树不在了、被删了、改成要人拍了就撤；
// 这里报的「要人拍」（worktree:<仓>/<树>）树没了、清干净删了、又被在跑的任务用上了就撤。
// 读不了、查不了、删不掉的都记「没查成」写明原因（这一轮不算 ok），不当成没事。

import type { SessionUser } from '@fleet-dao/adapters';
import type { AlertRow, IssueWorkFacts, OpenSessionTree, SubtaskTreeRef } from '@fleet-dao/db';
import type { StageKind } from '@fleet-dao/shared';
import { errMessage } from '@fleet-dao/shared/util';
import { subtaskWorkflowId } from '@fleet-dao/shared/workflow-ids';
import { subtaskBranch } from '../contract.ts';
import type { TreeLeftovers } from '../real/user-git.ts';
import { STAGE_NAMES } from '../routing/names.ts';
import {
  type AlertStore,
  clip,
  isStage,
  RECONCILE_ACTOR,
  type ReconcileLog,
  type SweepPart,
  stamp,
  type WorkflowReader,
} from './reconcile-common.ts';
import { runningTaskWorkflowId } from './redo.ts';

/** 「工作树没收掉」：子任务收尾删树没成时报的（workflows/subtask.ts），键是 sub:<子任务编号>:worktree。 */
export const SUBTASK_TREE_ALERT =
  /^sub:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):worktree$/;
/**
 * Fusion 工作流收尾删树没成时报的（workflows/fusion.ts）：键是需求工作流的编号加 :worktree，
 * req:<owner>/<name>#<号>:worktree——里面没有是哪棵树，按这张需求的 Fusion 树认。
 */
export const FUSION_TREE_ALERT = /^req:([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+)#([1-9]\d*):worktree$/;
/** Fusion 的树：<需求号>-f<8 位十六进制>（contract.ts 的 fusionBranch 去掉 fleet/）。 */
const FUSION_TREE = /^([1-9]\d*)-f[0-9a-f]{8}$/;
/** 这里报的「树里有没推的东西，删不删要你拍」：键是 worktree:<仓那一层>/<树>。 */
export const KEEP_ALERT_PREFIX = 'worktree:';
/** 一轮最多看几棵残留的树（每棵要以会话用户起几个短命 scope 跑 git）；多的下一轮再看。 */
export const INSPECT_MAX = 80;

export interface WorktreeSweepDeps {
  /** 工作树的根（生产是 /var/lib/fleet-work）。 */
  root: string;
  /** 路由探针常驻的那一层目录名（real/route-probe.ts 的 PROBE_DIR）：下面按会话用户各一个，不算残留。 */
  probeDir: string;
  /** 每个会话自己的临时目录那一层（real/worktrees.ts 的 SESSION_TMP_DIR）：会话收场、工人起来时各自清，这里不碰。 */
  sessionTmpDir: string;
  /** 这台机器给人看的名字（「法国」）：写进要人拍的提醒，说清去哪台看。 */
  machine: string;
  /** 列一个目录（根和仓这两级归 root、755，引擎自己读得了）。读不了照抛。 */
  listDir(dir: string): Promise<{ name: string; isDir: boolean }[]>;
  /** 子任务的树在哪：和建树同一个拼法（real/worktrees.ts 的 treeFor）。 */
  treeFor(repo: { owner: string; name: string }, branch: string): string;
  /** 归哪个会话用户；不在回 null；归了别人、看不了照抛。 */
  ownerOf(dir: string): Promise<SessionUser | null>;
  /**
   * 以会话用户的身份看树里还剩什么（real/user-git.ts 的 treeLeftovers；能重新生成的缓存和结论文件 .fleet-out/ 不算）。
   * scratch = 引擎的检出副本：它检出过的提交算推过——引擎每起一个新会话都把副本清干净重来。
   */
  leftovers(
    dir: string,
    user: SessionUser,
    known: readonly string[],
    scratch: boolean,
  ): Promise<TreeLeftovers>;
  remove(dir: string): Promise<{ gone: boolean }>;
  issue(ref: { owner: string; name: string; issueNumber: number }): Promise<IssueWorkFacts | null>;
  prHeads(ref: { owner: string; name: string; branch: string }): Promise<string[]>;
  subtaskTrees(ids: string[]): Promise<SubtaskTreeRef[]>;
  /** 还没结束的会话起在哪些目录里（session_runs，@fleet-dao/db 的 openSessionTrees）。 */
  openSessions(): Promise<OpenSessionTree[]>;
  workflows: Pick<WorkflowReader, 'state'>;
  alerts: AlertStore;
  log: ReconcileLog;
  inspectMax?: number;
}

/** 仓那一层：<owner>_<name>（GitHub 的用户名、组织名里没有下划线，第一个下划线就是分界）。 */
const REPO_DIR = /^([A-Za-z0-9][A-Za-z0-9-]*)_([A-Za-z0-9._-]+)$/;
/** 子任务的树：<需求号>-<子任务>（分支 fleet/<需求号>-<子任务> 去掉 fleet/）。 */
const SUBTASK_TREE = /^([1-9]\d*)-([A-Za-z0-9._-]+)$/;
/** 检出副本：<需求号>.<阶段>[.<子任务>]。 */
const SCRATCH_TREE = /^([1-9]\d*)\.([a-z]+)(?:\.([A-Za-z0-9._-]+))?$/;

type Repo = { owner: string; name: string };

type TreeKind =
  | { kind: 'subtask'; issue: number; key: string }
  | { kind: 'scratch'; issue: number; stage: StageKind; key: string | null };

export function parseRepoDir(name: string): Repo | null {
  const m = REPO_DIR.exec(name);
  return m?.[1] && m[2] ? { owner: m[1], name: m[2] } : null;
}

export function parseTreeName(name: string): TreeKind | null {
  const sub = SUBTASK_TREE.exec(name);
  if (sub?.[1] && sub[2]) return { kind: 'subtask', issue: Number(sub[1]), key: sub[2] };
  const scratch = SCRATCH_TREE.exec(name);
  if (scratch?.[1] && scratch[2] && isStage(scratch[2])) {
    return { kind: 'scratch', issue: Number(scratch[1]), stage: scratch[2], key: scratch[3] ?? null };
  }
  return null;
}

/**
 * 这棵树推上去的分支（它的提交推过没有，看这条分支的 PR 头）：子任务的树才有。检出副本里的提交都是引擎从镜像检出的
 * （检出记录算推过，见 leftovers 的 scratch）。
 */
function branchOf(t: TreeKind): string | null {
  return t.kind === 'subtask' ? subtaskBranch(t.issue, t.key) : null;
}

function treeWords(t: TreeKind): string {
  if (t.kind === 'subtask') return `需求 #${t.issue} 的子任务「${t.key}」`;
  return `需求 #${t.issue}「${STAGE_NAMES[t.stage]}」的检出副本${t.key ? `（子任务「${t.key}」）` : ''}`;
}

/** 「一共几个」后面接列出来的：列全了直接列，没列全写明是前几个。 */
function listed(items: readonly string[], total: number, unit: string): string {
  return total > items.length
    ? `，前 ${items.length} ${unit}：${items.join('；')}；…`
    : `：${items.join('；')}`;
}

/** 树里还剩的东西，一样一句；什么都不剩回空。 */
export function describeLeftovers(left: TreeLeftovers): string[] {
  if (left.kind === 'empty') return [];
  if (left.kind === 'not-repo') {
    return [
      `这一层不是 git 仓，里面有 ${left.fileCount} 个文件（能重新生成的编译和工具缓存不算）${listed(left.files, left.fileCount, '个')}`,
    ];
  }
  const out: string[] = [];
  if (left.unpushedCount > 0) {
    out.push(`没推的提交 ${left.unpushedCount} 个${listed(left.unpushed, left.unpushedCount, '个')}`);
  }
  if (left.dirtyCount > 0) {
    out.push(`没提交的改动 ${left.dirtyCount} 处${listed(left.dirty, left.dirtyCount, '处')}`);
  }
  if (left.stashes > 0) out.push(`存着 ${left.stashes} 个 stash（git stash list）`);
  return out;
}

type TreeOutcome =
  | { kind: 'in-use'; by: string }
  | { kind: 'gone' }
  | { kind: 'removed' }
  /** 剩着东西，报了（或更新了）要人拍。 */
  | { kind: 'escalated'; title: string }
  /** 剩着东西，人已经看过那条要人拍、点了处理：留着，不再提醒。 */
  | { kind: 'kept' }
  | { kind: 'unchecked'; why: string };

interface IssueUse {
  /** 在跑的工作流编号；null = 需求和它的子任务都不在跑。 */
  runningBy: string | null;
  facts: IssueWorkFacts | null;
}

interface Sweep {
  deps: WorktreeSweepDeps;
  part: SweepPart;
  /** 这一轮看过的树：路径 → 结局。 */
  outcomes: Map<string, TreeOutcome>;
  uses: Map<string, Promise<IssueUse>>;
  /** 没结束的会话在哪些目录里：一轮只查一次（查不成的这一轮每棵树都不碰）。 */
  sessions: Promise<Map<string, OpenSessionTree>> | null;
  /** 根下的仓那一层：这一轮列成了没有（列不了的，和它有关的提醒这一轮不撤）。 */
  repoDirs: Map<string, 'listed' | 'unreadable'>;
  inspected: number;
  deferred: number;
}

/**
 * 这张单的任务工作流在跑，或者它的哪个子任务工作流还在跑（旧的 Fusion 收尾时子任务还在撤合并队列、收树）：这张单的树都算在用。
 * 任务工作流的树名（<号>-t<8 位>）和子任务的树名同一个样子，认的是 task:<仓>#<号>（含重做后的 :rN。#901：以前这里只认已经没有的 req:，
 * 任务工作流等 CI、等合并时没有开着的会话，树会被当残留删掉）。
 */
function issueUse(s: Sweep, repo: Repo, issueNumber: number): Promise<IssueUse> {
  const key = `${repo.owner}/${repo.name}#${issueNumber}`;
  let use = s.uses.get(key);
  if (!use) {
    use = (async () => {
      const facts = await s.deps.issue({ ...repo, issueNumber });
      const workflows = s.deps.workflows;
      const running = await runningTaskWorkflowId(repo, issueNumber, async (id) => {
        const st = await workflows.state(id);
        if (st.state === 'running') return 'running';
        if (st.state === 'missing') return 'missing';
        return 'closed';
      });
      if (running) return { runningBy: running, facts };
      for (const sub of facts?.subtasks ?? []) {
        const id = subtaskWorkflowId(sub.id);
        if ((await workflows.state(id)).state === 'running') return { runningBy: id, facts };
      }
      return { runningBy: null, facts };
    })();
    s.uses.set(key, use);
  }
  return use;
}

async function escalate(
  s: Sweep,
  ctx: {
    rel: string;
    path: string;
    tree: TreeKind;
    user: SessionUser;
    what: string[];
    /** 这一层是不是 git 仓：「看里面」给哪种命令。 */
    repo: boolean;
    taskId: string | null;
  },
): Promise<TreeOutcome> {
  const { deps } = s;
  const dedupeKey = `${KEEP_ALERT_PREFIX}${ctx.rel}`;
  const existing = await deps.alerts.byKey(dedupeKey);
  // 人已经看过、点了处理（不是对账自己撤的）：留着，不再报。树里又清干净了，照样删
  if (existing?.resolvedAt && existing.resolvedBy !== RECONCILE_ACTOR) return { kind: 'kept' };
  const title = clip(`工作树里有没推的东西，删不删要你拍：${ctx.rel}`, 300);
  const body = [
    `${deps.machine}的 ${ctx.path}（${treeWords(ctx.tree)}）已经没有在跑的任务在用了，但里面还有：`,
    ...ctx.what.map((w) => `- ${w}`),
    '删了就没了，所以每小时对账没删它（删数据要人拍）。',
    `要删：在${deps.machine}以 root 跑 /usr/local/sbin/fleet-agent-scope remove ${ctx.path}，下一轮对账看它不在了就撤掉这条。`,
    '要留：点「处理」，之后这棵树不再提醒；里面的东西推走或清掉以后，下一轮对账会自己删。',
    ctx.repo
      ? `看里面：sudo -u ${ctx.user} git -C ${ctx.path} status；sudo -u ${ctx.user} git -C ${ctx.path} log --oneline -5`
      : `看里面：sudo -u ${ctx.user} find ${ctx.path} ! -type d`,
  ].join('\n');
  if (existing && !existing.resolvedAt) {
    if (existing.title !== title || existing.body !== body) {
      await deps.alerts.updateOpen({ dedupeKey, title, body });
    }
  } else {
    // taskId 不挂：需求结束了的「要人拍」照样要算进等你拍的（飞书盘面按需求结束就不算等人）；点提醒直达那张需求
    await deps.alerts.raise({
      dedupeKey,
      level: 'decision',
      taskId: null,
      title,
      body,
      ...(ctx.taskId ? { link: `/tasks/${ctx.taskId}` } : {}),
    });
  }
  return { kind: 'escalated', title };
}

async function sweepTree(s: Sweep, repo: Repo, repoDir: string, name: string): Promise<TreeOutcome> {
  const { deps } = s;
  const rel = `${repoDir}/${name}`;
  const path = `${deps.root}/${rel}`;
  const tree = parseTreeName(name);
  if (!tree) return { kind: 'unchecked', why: `认不出 ${rel} 是哪张需求的树（没碰）` };
  let use: IssueUse;
  try {
    use = await issueUse(s, repo, tree.issue);
  } catch (err) {
    return { kind: 'unchecked', why: `${rel} 有没有在跑的任务在用没查成：${errMessage(err)}` };
  }
  if (use.runningBy) return { kind: 'in-use', by: use.runningBy };
  let live: OpenSessionTree | undefined;
  try {
    s.sessions ??= s.deps.openSessions().then((rows) => new Map(rows.map((r) => [r.path, r])));
    live = (await s.sessions).get(path);
  } catch (err) {
    return { kind: 'unchecked', why: `${rel} 里有没有没结束的会话没查成（没碰）：${errMessage(err)}` };
  }
  if (live) {
    return {
      kind: 'unchecked',
      why: `${rel} 里还有没结束的会话（${live.stage} 阶段，北京时间 ${stamp(live.queuedAt)} 起，会话 ${live.runId.slice(0, 8)}）：需求和子任务的工作流都不在跑了，会话可能还活着（没收的会话见 #247），没碰`,
    };
  }
  if (s.inspected >= (deps.inspectMax ?? INSPECT_MAX)) {
    s.deferred += 1;
    return { kind: 'unchecked', why: '' };
  }
  s.inspected += 1;
  let user: SessionUser | null;
  try {
    user = await deps.ownerOf(path);
  } catch (err) {
    return { kind: 'unchecked', why: `${rel} 看不了归谁（没碰）：${errMessage(err)}` };
  }
  if (!user) return { kind: 'gone' };
  const branch = branchOf(tree);
  let left: TreeLeftovers;
  try {
    const known = branch ? await deps.prHeads({ ...repo, branch }) : [];
    left = await deps.leftovers(path, user, known, tree.kind === 'scratch');
  } catch (err) {
    return { kind: 'unchecked', why: `${rel} 里还剩什么没查成（没删）：${errMessage(err)}` };
  }
  const what = describeLeftovers(left);
  if (what.length === 0) {
    // 看完到删之间要是有新一轮需求起来、在这里建树：它建树时会先删掉同一位置的旧树（github-ports 的 createWorktree），
    // 这里删的是看过、什么都不剩的那一棵
    try {
      await deps.remove(path);
    } catch (err) {
      return { kind: 'unchecked', why: `${rel} 删不掉：${errMessage(err)}` };
    }
    deps.log('info', '每小时对账：删了一棵残留的工作树', { tree: rel });
    return { kind: 'removed' };
  }
  try {
    return await escalate(s, {
      rel,
      path,
      tree,
      user,
      what,
      repo: left.kind === 'repo',
      taskId: use.facts?.taskId ?? null,
    });
  } catch (err) {
    return { kind: 'unchecked', why: `${rel} 里还有没推的东西，报要人拍没报成：${errMessage(err)}` };
  }
}

/** 这一轮看过的一棵树的去向，对「工作树没收掉」来说该不该撤、为什么；不撤回 null。 */
function outcomeWhy(outcome: TreeOutcome, rel: string): string | null {
  switch (outcome.kind) {
    case 'removed':
      return `每小时对账把这棵树删了（${rel}）：里面没有没推的提交、也没有没提交的改动（能重新生成的编译和工具缓存不算）`;
    case 'gone':
      return `树已经不在了（${rel}）`;
    case 'escalated':
      return `树里还有没推、没提交的东西，改成要你拍：看「${outcome.title}」那条`;
    case 'kept':
      return `树里还有没推、没提交的东西，人已经看过那条要人拍、决定留着（${rel}）`;
    case 'in-use':
    case 'unchecked':
      return null;
  }
}

/** 一条「树的去向」该不该撤、为什么；不撤回 null。 */
async function treeGoneWhy(s: Sweep, path: string, rel: string): Promise<string | null> {
  const outcome = s.outcomes.get(path);
  if (outcome) return outcomeWhy(outcome, rel);
  // 这一轮没看到它（仓那一层读不了、根本不在）：直接看在不在
  return (await s.deps.ownerOf(path)) === null ? `树已经不在了（${rel}）` : null;
}

/**
 * Fusion 报的「工作树没收掉」（键里只有需求，没有是哪棵树）：这张需求的 Fusion 树（<号>-f<8 位>）这一轮都有了去向
 * （删了、不在了、改成要人拍、人决定留着）就撤；有一棵还在用、没查成，或者那个仓这一轮列不了，就留着。
 */
function fusionTreesWhy(s: Sweep, owner: string, name: string, issue: string): string | null {
  const repoDir = `${owner}_${name}`;
  if (s.repoDirs.get(repoDir) === 'unreadable') return null;
  const prefix = `${s.deps.root}/${repoDir}/`;
  const trees = [...s.outcomes].filter(
    ([path]) => path.startsWith(prefix) && FUSION_TREE.exec(path.slice(prefix.length))?.[1] === issue,
  );
  if (trees.length === 0) return `这张需求的树已经不在了（${repoDir}/${issue}-f…）`;
  const whys = trees.map(([path, outcome]) => outcomeWhy(outcome, path.slice(s.deps.root.length + 1)));
  return whys.every((w) => w !== null) ? whys.join('；') : null;
}

async function resolveOne(s: Sweep, dedupeKey: string, why: string): Promise<void> {
  const r = await s.deps.alerts.resolve({ dedupeKey, by: RECONCILE_ACTOR, why });
  if (r === 'ok') {
    s.part.found += 1;
    s.deps.log('info', '每小时对账：撤了一条提醒', { dedupeKey, why });
  }
}

/** 和树有关的两种提醒：树的去向定了就撤（写明为什么）。 */
async function settleTreeAlerts(s: Sweep, open: readonly AlertRow[]): Promise<void> {
  const { deps, part } = s;
  const subtaskAlerts = open.flatMap((a) => {
    const id = SUBTASK_TREE_ALERT.exec(a.dedupeKey)?.[1];
    return id ? [{ alert: a, subtaskId: id }] : [];
  });
  if (subtaskAlerts.length > 0) {
    let refs: Map<string, SubtaskTreeRef> | null = null;
    try {
      refs = new Map(
        (await deps.subtaskTrees(subtaskAlerts.map((x) => x.subtaskId))).map((r) => [r.subtaskId, r]),
      );
    } catch (err) {
      part.unchecked.push(`「工作树没收掉」那几条是哪棵树没查成：${errMessage(err)}`);
    }
    for (const { alert, subtaskId } of refs ? subtaskAlerts : []) {
      const ref = refs?.get(subtaskId);
      if (!ref?.key) {
        part.unchecked.push(`提醒 ${alert.dedupeKey} 说的是哪棵树认不出来（库里没有这个子任务或它没有 key）`);
        continue;
      }
      try {
        const repoDir = `${ref.owner}_${ref.name}`;
        const path = deps.treeFor(ref, subtaskBranch(ref.issueNumber, ref.key));
        const rel = path.startsWith(`${deps.root}/`) ? path.slice(deps.root.length + 1) : `${repoDir}/?`;
        const why = await treeGoneWhy(s, path, rel);
        if (why) await resolveOne(s, alert.dedupeKey, why);
      } catch (err) {
        part.unchecked.push(`提醒 ${alert.dedupeKey} 没查成：${errMessage(err)}`);
      }
    }
  }
  for (const alert of open) {
    const m = FUSION_TREE_ALERT.exec(alert.dedupeKey);
    if (!m?.[1] || !m[2] || !m[3]) continue;
    try {
      const why = fusionTreesWhy(s, m[1], m[2], m[3]);
      if (why) await resolveOne(s, alert.dedupeKey, why);
    } catch (err) {
      part.unchecked.push(`提醒 ${alert.dedupeKey} 没查成：${errMessage(err)}`);
    }
  }
  for (const alert of open) {
    if (!alert.dedupeKey.startsWith(KEEP_ALERT_PREFIX)) continue;
    const rel = alert.dedupeKey.slice(KEEP_ALERT_PREFIX.length);
    const path = `${deps.root}/${rel}`;
    try {
      const outcome = s.outcomes.get(path);
      const why =
        outcome?.kind === 'in-use'
          ? `这棵树又被在跑的任务（${outcome.by}）用上了：新一轮会换掉它，不用拍了`
          : outcome?.kind === 'escalated'
            ? null
            : outcome?.kind === 'removed'
              ? `树里已经没有没推、没提交的东西了（能重新生成的编译和工具缓存不算），每小时对账把树删了（${rel}）`
              : await treeGoneWhy(s, path, rel);
      if (why) await resolveOne(s, alert.dedupeKey, why);
    } catch (err) {
      part.unchecked.push(`提醒 ${alert.dedupeKey} 没查成：${errMessage(err)}`);
    }
  }
}

/**
 * 跑工作树这一部分。openAlerts 是这一轮列出的没处理的提醒（列不成是 null：树照删，和树有关的提醒留到下一轮撤）。
 * 读不了根：这一部分整个没跑成（failed）；别的读不了、查不了、删不掉进 unchecked。
 */
export async function sweepWorktrees(
  deps: WorktreeSweepDeps,
  openAlerts: readonly AlertRow[] | null,
): Promise<SweepPart> {
  const s: Sweep = {
    deps,
    part: { scanned: 0, found: 0, unchecked: [] },
    outcomes: new Map(),
    uses: new Map(),
    sessions: null,
    repoDirs: new Map(),
    inspected: 0,
    deferred: 0,
  };
  let top: { name: string; isDir: boolean }[];
  try {
    top = await deps.listDir(deps.root);
  } catch (err) {
    return {
      failed: `工作树的根 ${deps.root} 读不了：${errMessage(err)}`,
      scanned: 0,
      found: 0,
      unchecked: [],
    };
  }
  for (const entry of top) {
    if (entry.name === deps.sessionTmpDir && entry.isDir) continue;
    if (entry.name === deps.probeDir && entry.isDir) {
      try {
        s.part.scanned += (await deps.listDir(`${deps.root}/${entry.name}`)).length;
      } catch (err) {
        s.part.unchecked.push(`路由探针的目录 ${entry.name} 列不了：${errMessage(err)}`);
      }
      continue;
    }
    const repo = entry.isDir ? parseRepoDir(entry.name) : null;
    if (!repo) {
      s.part.unchecked.push(`工作树的根下有认不出的东西（不是「<owner>_<仓名>」目录，没碰）：${entry.name}`);
      continue;
    }
    let trees: { name: string; isDir: boolean }[];
    try {
      trees = await deps.listDir(`${deps.root}/${entry.name}`);
    } catch (err) {
      s.repoDirs.set(entry.name, 'unreadable');
      s.part.unchecked.push(`${entry.name} 列不了：${errMessage(err)}`);
      continue;
    }
    s.repoDirs.set(entry.name, 'listed');
    for (const t of trees) {
      s.part.scanned += 1;
      const outcome = t.isDir
        ? await sweepTree(s, repo, entry.name, t.name)
        : { kind: 'unchecked' as const, why: `${entry.name}/${t.name} 不是目录（没碰）` };
      s.outcomes.set(`${deps.root}/${entry.name}/${t.name}`, outcome);
      if (outcome.kind === 'removed' || outcome.kind === 'escalated') s.part.found += 1;
      if (outcome.kind === 'unchecked' && outcome.why) s.part.unchecked.push(outcome.why);
    }
  }
  if (s.deferred > 0) {
    s.part.unchecked.push(
      `残留的树太多，这一轮只看了 ${s.inspected} 棵，还有 ${s.deferred} 棵下一轮再看（一轮最多 ${deps.inspectMax ?? INSPECT_MAX} 棵）`,
    );
  }
  if (openAlerts) await settleTreeAlerts(s, openAlerts);
  return s.part;
}
