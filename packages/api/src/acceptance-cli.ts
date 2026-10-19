import { userInfo } from 'node:os';
import type { Db } from '@fleet-dao/db';
import { type AcceptanceCoverage, acceptanceDutyState, parseAcceptanceCoverage } from '@fleet-dao/shared';

export const ACCEPTANCE_USAGE =
  '用法：fleet-api acceptance status <owner/仓> <单号> | fleet-api acceptance settle <owner/仓> <单号> --id <责任号> --generation <代次> --pr <PR号，协调责任为0> --head <SHA，协调责任为-> --evidence "验收证据" | fleet-api acceptance merge-plan <owner/仓> <单号> --task <任务UUID> --workflow <原workflowId> --run <原runId> --pr <PR号> --head <最终头SHA> --merge-commit <合并提交SHA> --duties <责任号:代次,…>（只读预检，不写账） | fleet-api acceptance supersede <owner/仓> <单号> --id <旧责任号> --generation <代次> --pr <PR号> --head <旧头SHA> --target-id <最终责任号> --target-generation <代次> --target-pr <PR号> --target-head <最终头SHA> --evidence "替代依据" [--coverage \'[{"source":"源项原文","target":"目标项原文","basis":"覆盖依据"}]\']（源项和目标项措辞不同才写 --coverage，逐条人工审定，原文整串照抄 status 的 items）';

const FLAGS = {
  settle: ['--id', '--generation', '--pr', '--head', '--evidence'],
  supersede: [
    '--id',
    '--generation',
    '--pr',
    '--head',
    '--target-id',
    '--target-generation',
    '--target-pr',
    '--target-head',
    '--evidence',
    '--coverage',
  ],
  'merge-plan': ['--task', '--workflow', '--run', '--pr', '--head', '--merge-commit', '--duties'],
} as const;

export function parseAcceptanceArgs(args: readonly string[]) {
  const [action, repo, issue, ...rest] = args;
  if (
    (action !== 'status' && action !== 'settle' && action !== 'supersede' && action !== 'merge-plan') ||
    !repo ||
    !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ||
    !issue ||
    !Number.isSafeInteger(Number(issue)) ||
    !/^[1-9]\d*$/.test(issue)
  )
    throw new Error(ACCEPTANCE_USAGE);
  if (action === 'status') {
    if (rest.length) throw new Error(ACCEPTANCE_USAGE);
    return { action, repo, issueNumber: Number(issue) } as const;
  }
  const allowed: readonly string[] = FLAGS[action];
  const values: Record<string, string> = {};
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i];
    const value = rest[i + 1];
    if (!key || !allowed.includes(key) || value === undefined || Object.hasOwn(values, key))
      throw new Error(ACCEPTANCE_USAGE);
    values[key] = value;
  }
  const positive = (key: string, zero = false) => {
    const value = values[key] ?? '';
    const n = Number(value);
    if (!(zero ? /^(0|[1-9]\d*)$/ : /^[1-9]\d*$/).test(value) || !Number.isSafeInteger(n))
      throw new Error(ACCEPTANCE_USAGE);
    return n;
  };
  const issueNumber = Number(issue);
  if (action === 'merge-plan') {
    const text = (key: string) => {
      const value = values[key]?.trim() ?? '';
      if (!value || /\s/.test(value)) throw new Error(ACCEPTANCE_USAGE);
      return value;
    };
    const sha = (key: string) => {
      const value = text(key);
      if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(ACCEPTANCE_USAGE);
      return value;
    };
    const taskId = text('--task');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId))
      throw new Error(ACCEPTANCE_USAGE);
    // 责任号:代次，逗号隔开；重复的责任号当格式错，免得同一行被点两次
    const duties = (values['--duties'] ?? '').split(',').map((part) => {
      const m = /^([1-9]\d*):([1-9]\d*)$/.exec(part);
      if (!m) throw new Error(ACCEPTANCE_USAGE);
      return { id: Number(m[1]), generation: Number(m[2]) };
    });
    if (new Set(duties.map((d) => d.id)).size !== duties.length) throw new Error(ACCEPTANCE_USAGE);
    return {
      action,
      repo,
      issueNumber,
      taskId,
      workflowId: text('--workflow'),
      temporalRunId: text('--run'),
      prNumber: positive('--pr'),
      head: sha('--head'),
      mergeCommit: sha('--merge-commit'),
      duties,
    } as const;
  }
  const evidence = values['--evidence']?.trim();
  if (!evidence) throw new Error(ACCEPTANCE_USAGE);
  if (action === 'supersede') {
    const sha = (key: string) => {
      const value = values[key] ?? '';
      if (!/^[a-f0-9]{40}$/.test(value)) throw new Error(ACCEPTANCE_USAGE);
      return value;
    };
    let coverage: AcceptanceCoverage[] = [];
    if (values['--coverage'] !== undefined) {
      try {
        const parsed = parseAcceptanceCoverage(JSON.parse(values['--coverage']));
        if (!parsed?.length) throw new Error(ACCEPTANCE_USAGE);
        coverage = parsed;
      } catch {
        throw new Error(ACCEPTANCE_USAGE);
      }
    }
    return {
      action,
      repo,
      issueNumber,
      source: {
        id: positive('--id'),
        generation: positive('--generation'),
        repo,
        issueNumber,
        prNumber: positive('--pr'),
        head: sha('--head'),
      },
      target: {
        id: positive('--target-id'),
        generation: positive('--target-generation'),
        repo,
        issueNumber,
        prNumber: positive('--target-pr'),
        head: sha('--target-head'),
      },
      evidence,
      coverage,
    } as const;
  }
  const prNumber = positive('--pr', true);
  const head = values['--head'];
  if (!head || (prNumber ? !/^[a-f0-9]{40}$/.test(head) : head !== '-')) throw new Error(ACCEPTANCE_USAGE);
  return {
    action,
    repo,
    issueNumber,
    id: positive('--id'),
    generation: positive('--generation'),
    prNumber,
    head: head === '-' ? '' : head,
    evidence,
  } as const;
}

type MergePlanInput = Extract<ReturnType<typeof parseAcceptanceArgs>, { action: 'merge-plan' }>;

/** 目标责任某一项的来源：哪条原责任（精确身份和代次）带来的；已有的最终头行也算一个来源。 */
export interface MergePlanItemSource {
  id: number;
  generation: number;
  head: string;
  existingTarget: boolean;
}

/**
 * 历史验收责任归并的只读预检（#3207 第 1 片）：只读库，不写任何表。
 * 旧头是否合并过只认同仓 PR 镜像对最终头 / 合并提交的回执，不拿责任行自己的 merge 列证明；
 * 有任何拒绝原因 ok 就是 false、不出验收项（不是可用的计划）；点名的责任行读不全直接抛，不出空计划。
 */
export async function planAcceptanceMerge(db: Db, input: MergePlanInput) {
  const { readAcceptanceMergeFacts } = await import('@fleet-dao/db');
  const facts = await readAcceptanceMergeFacts(db, {
    taskId: input.taskId,
    workflowId: input.workflowId,
    temporalRunId: input.temporalRunId,
    prNumber: input.prNumber,
    head: input.head,
    dutyIds: input.duties.map((d) => d.id),
  });
  const missing = input.duties.filter((d) => !facts.duties.some((r) => r.id === d.id));
  if (missing.length)
    throw new Error(`读取不全：读不到责任 ${missing.map((d) => `#${d.id}`).join('、')}，不出计划`);
  const rejections: { scope: 'input' | 'duty'; dutyId?: number; reason: string }[] = [];
  const reject = (reason: string, dutyId?: number) =>
    rejections.push(dutyId === undefined ? { scope: 'input', reason } : { scope: 'duty', dutyId, reason });
  const { task, pr } = facts;
  if (!task) reject('错任务：任务读不到');
  else {
    if (`${task.owner}/${task.name}` !== input.repo) reject(`错仓：任务属于 ${task.owner}/${task.name}`);
    if (task.issueNumber !== input.issueNumber) reject(`错单：任务是 #${task.issueNumber}`);
  }
  if (!facts.runs.some((r) => r.taskId === input.taskId))
    reject(
      facts.runs.length
        ? '错 run：该 workflow / run 属于别的任务'
        : '错 run：按原 workflow ID 和 run ID 读不到这个任务的运行',
    );
  if (task) {
    if (!pr) reject(`回执未知：同仓 PR 镜像里读不到 #${input.prNumber}`);
    else {
      if (pr.headSha !== input.head) reject(`头对不上：PR 当前头是 ${pr.headSha}`);
      if (pr.state !== 'merged') reject(`PR 未合：状态 ${pr.state}`);
      if (pr.state === 'merged' && !pr.mergeSha) reject('回执未知：PR 已合但没有合并提交');
      else if (pr.state !== 'merged' && pr.mergeSha) reject('回执矛盾：PR 未合却有合并提交');
      else if (pr.mergeSha && pr.mergeSha !== input.mergeCommit)
        reject(`回执矛盾：PR 合并提交是 ${pr.mergeSha}`);
    }
  }
  for (const want of input.duties) {
    const row = facts.duties.find((r) => r.id === want.id);
    if (!row) continue;
    if (row.generation !== want.generation) reject(`代次已变：现在是 ${row.generation}`, row.id);
    if (row.repo !== input.repo) reject(`错仓：责任属于 ${row.repo}`, row.id);
    if (row.issueNumber !== input.issueNumber) reject(`错单：责任属于 #${row.issueNumber}`, row.id);
    if (row.taskId !== input.taskId) reject('错任务：责任挂在别的任务上', row.id);
    if (row.prNumber !== input.prNumber) reject(`不是同一个 PR：责任是 PR ${row.prNumber}`, row.id);
    if (row.head === input.head) reject('已经是最终头的责任，不用归并', row.id);
    if (row.settledAt != null) reject('已最终验收，不是未结责任', row.id);
    if (row.supersededAt != null) reject('已有替代记录，不是未结责任', row.id);
  }
  const ok = rejections.length === 0;
  const from = (r: { id: number; generation: number; head: string }, existingTarget = false) => ({
    id: r.id,
    generation: r.generation,
    head: r.head,
    existingTarget,
  });
  const byItem = new Map<string, MergePlanItemSource[]>();
  const contributors = [
    ...facts.duties.map((row) => ({ row, existing: false })),
    ...(facts.target ? [{ row: facts.target, existing: true }] : []),
  ];
  if (ok)
    for (const { row, existing } of contributors)
      for (const item of row.items) byItem.set(item, [...(byItem.get(item) ?? []), from(row, existing)]);
  return {
    ok,
    repo: input.repo,
    issueNumber: input.issueNumber,
    taskId: input.taskId,
    workflowId: input.workflowId,
    temporalRunId: input.temporalRunId,
    duties: facts.duties.map((r) => from(r)),
    target: {
      prNumber: input.prNumber,
      head: input.head,
      mergeCommit: input.mergeCommit,
      existing: facts.target ? from(facts.target) : null,
      items: [...byItem].sort(([a], [b]) => (a < b ? -1 : 1)).map(([item, sources]) => ({ item, sources })),
    },
    rejections,
  };
}

export async function runAcceptance(args: readonly string[], db: Db, now: Date) {
  const input = parseAcceptanceArgs(args);
  if (input.action === 'merge-plan') {
    const plan = await planAcceptanceMerge(db, input);
    if (!plan.ok) throw new Error(`归并预检不通过，没有可用计划：${JSON.stringify(plan)}`);
    return plan;
  }
  const { readAcceptanceDutyRows, settleAcceptanceDuty, supersedeAcceptanceDuty } = await import(
    '@fleet-dao/db'
  );
  const by = `ops:acceptance:${userInfo().username}`;
  if (input.action === 'status') {
    const rows = await readAcceptanceDutyRows(db, input);
    return rows.map((r) => ({ ...r, state: acceptanceDutyState(r, rows) }));
  }
  if (input.action === 'supersede')
    return supersedeAcceptanceDuty(
      db,
      { source: input.source, target: input.target, by, evidence: input.evidence, coverage: input.coverage },
      now,
    );
  const { action: _, ...identity } = input;
  return settleAcceptanceDuty(db, { ...identity, by }, now);
}
