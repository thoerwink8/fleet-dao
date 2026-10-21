// 引擎拉单（#632 S2-2、S2-4b-3；packages/engine/src/jobs/intake.ts）要从库里读的两样：受管的仓（带「让 AI 接活」开关）、
// 一张单有没有任务行、在什么状态。任务行的创建走 api 的 pg-store（createTaskFromIssue：和操作记录同一事务，按仓加单号唯一）。
import {
  type CiPolicy,
  ciPolicyOf,
  parseRepoProfile,
  type TaskExecutor,
  type TaskState,
} from '@fleet-dao/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../client.ts';
import { auditLog, repos, tasks } from '../schema/index.ts';
import { lastLocalReturnAt } from './local-claims.ts';

export interface IntakeRepoRow {
  id: string;
  owner: string;
  name: string;
  defaultBranch: string;
  testCommand: string;
  /** 仓档案原文（只存显式写了的项）；缺项、补默认值由引擎接活时判。 */
  profile: unknown;
  /** 「让 AI 接活」打开的时刻；null＝关着。 */
  autoDispatchSince: Date | null;
  /** 合并方式。库的默认是强制；列出来的是库里的原文，认不认由调用方用 ciPolicyOf。 */
  ciPolicy: CiPolicy;
  /** 仓之间分名额的相对份额；旧档案按 shared 的默认值 1。 */
  weight: number;
}

/** 受管的所有仓（开关关着的也列：全关是正常的空闲，不是没扫到东西）。 */
export async function listIntakeRepos(db: Db): Promise<IntakeRepoRow[]> {
  const rows = await db
    .select({
      id: repos.id,
      owner: repos.owner,
      name: repos.name,
      defaultBranch: repos.defaultBranch,
      testCommand: repos.testCommand,
      profile: repos.profile,
      autoDispatchSince: repos.autoDispatchSince,
      ciPolicy: repos.ciPolicy,
    })
    .from(repos);
  return rows.map((r) => ({
    ...r,
    ciPolicy: ciPolicyOf(r.ciPolicy),
    weight: parseRepoProfile(r.profile).weight,
  }));
}

/** 这张单的任务行（没有是 null）。派出过没有不在这里判。 */
export async function taskStateByIssue(
  db: Db,
  repoId: string,
  issueNumber: number,
): Promise<{ id: string; state: TaskState } | null> {
  const [row] = await db
    .select({ id: tasks.id, state: tasks.state })
    .from(tasks)
    .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
  return row ?? null;
}

/**
 * 拉单判「派出过没有」要的任务行：编号、状态、执行方，加上最近一次退回法国队列的时刻（只有 stopped + engine 的行才去操作记录里找，
 * 别的行不可能是「退回后没人接」，不多读；从没退回过是 null）。
 */
export async function intakeTaskRow(
  db: Db,
  repoId: string,
  issueNumber: number,
): Promise<{ id: string; state: TaskState; executor: TaskExecutor; returnedAt: Date | null } | null> {
  const [row] = await db
    .select({ id: tasks.id, state: tasks.state, executor: tasks.executor })
    .from(tasks)
    .where(and(eq(tasks.repoId, repoId), eq(tasks.issueNumber, issueNumber)));
  if (!row) return null;
  const returnedAt =
    row.state === 'stopped' && row.executor === 'engine' ? await lastLocalReturnAt(db, row.id) : null;
  return { ...row, returnedAt };
}

/** 一个仓的档案原文，连同认它要用的几样（fleet-api project show / set-profile 读写的就是这些）。 */
export interface RepoProfileRow {
  id: string;
  owner: string;
  name: string;
  /** GitHub 上的仓号；老行没填是 null。 */
  githubId: number | null;
  defaultBranch: string;
  testCommand: string;
  ciPolicy: CiPolicy;
  autoDispatchSince: Date | null;
  /** 库里的原文（只存显式写了的项）；补默认值、校验用 shared 的 parseRepoProfile。 */
  profile: unknown;
}

/** 按 owner/仓名找（不分大小写，和 store 的 findRepoByName 同一个判法）；没有回 null。 */
export async function findRepoProfile(db: Db, owner: string, name: string): Promise<RepoProfileRow | null> {
  const [row] = await db
    .select({
      id: repos.id,
      owner: repos.owner,
      name: repos.name,
      githubId: repos.githubId,
      defaultBranch: repos.defaultBranch,
      testCommand: repos.testCommand,
      ciPolicy: repos.ciPolicy,
      autoDispatchSince: repos.autoDispatchSince,
      profile: repos.profile,
    })
    .from(repos)
    .where(and(sql`lower(${repos.owner}) = lower(${owner})`, sql`lower(${repos.name}) = lower(${name})`))
    .limit(1);
  return row ? { ...row, ciPolicy: ciPolicyOf(row.ciPolicy) } : null;
}

/** 公开策略桥只按已登记的数字仓号找同一行，不接受 caller 自报模式。 */
export async function findRepoPolicyByGithubId(db: Db, githubId: number) {
  const [row] = await db
    .select({
      id: repos.id,
      owner: repos.owner,
      name: repos.name,
      githubId: repos.githubId,
      ciPolicy: repos.ciPolicy,
    })
    .from(repos)
    .where(eq(repos.githubId, githubId))
    .limit(1);
  return row ? { ...row, ciPolicy: ciPolicyOf(row.ciPolicy) } : null;
}

/** 操作记录里写档案这件事的名字；target 是 repo:<仓的编号>。 */
export const REPO_PROFILE_SET = 'repo.profile.set';

/**
 * 整份换掉一个仓的档案（调用方先用 shared 的 RepoProfileSchema 校验过），和操作记录同一事务，带改前改后。
 * 档案里写了 testCommand 的，给人看的 test_command 列一起改成它（两处不各说各的）。
 * 和库里的一样（jsonb 相等）就不改、不记。仓不在回 not_found。
 */
export async function setRepoProfile(
  db: Db,
  input: {
    repoId: string;
    profile: Record<string, unknown>;
    actor: { kind: 'user' | 'ai' | 'engine' | 'agent' | 'ops'; id: string };
    reason: string;
  },
): Promise<{ changed: boolean; auditId: number | null } | 'not_found'> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        profile: repos.profile,
        same: sql<boolean>`${repos.profile} = ${JSON.stringify(input.profile)}::jsonb`,
      })
      .from(repos)
      .where(eq(repos.id, input.repoId))
      .for('update');
    if (!row) return 'not_found' as const;
    if (row.same) return { changed: false, auditId: null };
    const testCommand = input.profile.testCommand;
    await tx
      .update(repos)
      .set({ profile: input.profile, ...(typeof testCommand === 'string' ? { testCommand } : {}) })
      .where(eq(repos.id, input.repoId));
    const [audit] = await tx
      .insert(auditLog)
      .values({
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        action: REPO_PROFILE_SET,
        target: `repo:${input.repoId}`,
        before: row.profile,
        after: input.profile,
        reason: input.reason,
        via: 'ops',
        ok: true,
      })
      .returning({ id: auditLog.id });
    if (!audit) throw new Error('操作记录没写进去：insert 没回行');
    return { changed: true, auditId: audit.id };
  });
}

/** 操作记录里登记仓这件事的名字；target 是 repo:<仓的编号>。 */
export const REPO_REGISTER = 'repo.register';

export type RegisterRepoResult =
  | { outcome: 'created' | 'updated'; repoId: string; auditId: number }
  | { outcome: 'unchanged'; repoId: string }
  | { outcome: 'conflict'; why: string };

/**
 * 登记一个仓（pnpm project add 第一步经 fleet-api project register 调，#2749）。认仓认 GitHub 仓号（design 15.7 第 1 条）：
 * 没有这一行就建（接活关着、档案空、测试命令先填 pnpm check 占位，档案那一步再改）；老行没有仓号就补上；
 * 已经是这个仓号不改不记。仓号对不上，或这个号已经登记在别的名字上（多半改了名），拒、什么都不改，原因写明。
 * 建和补都和操作记录同一事务。
 */
export async function registerRepo(
  db: Db,
  input: {
    owner: string;
    name: string;
    githubId: number;
    defaultBranch: string;
    actor: { kind: 'user' | 'ai' | 'engine' | 'agent' | 'ops'; id: string };
    reason: string;
  },
): Promise<RegisterRepoResult> {
  return db.transaction(async (tx) => {
    const cols = { id: repos.id, owner: repos.owner, name: repos.name, githubId: repos.githubId };
    const [byId] = await tx.select(cols).from(repos).where(eq(repos.githubId, input.githubId)).for('update');
    const [byName] = await tx
      .select(cols)
      .from(repos)
      .where(
        and(
          sql`lower(${repos.owner}) = lower(${input.owner})`,
          sql`lower(${repos.name}) = lower(${input.name})`,
        ),
      )
      .for('update');
    const asked = `${input.owner}/${input.name}`;
    if (byId && byId.id !== byName?.id)
      return {
        outcome: 'conflict' as const,
        why: `仓号 ${input.githubId} 已经登记在 ${byId.owner}/${byId.name} 上（多半改了名或转了主人），没把 ${asked} 再登记一遍`,
      };
    if (byName && byName.githubId !== null && byName.githubId !== input.githubId)
      return {
        outcome: 'conflict' as const,
        why: `库里的 ${byName.owner}/${byName.name} 登记的仓号是 ${byName.githubId}，GitHub 上现在是 ${input.githubId}（多半删了重建）：先核对，没改`,
      };
    if (byName && byName.githubId === input.githubId)
      return { outcome: 'unchanged' as const, repoId: byName.id };

    let repoId: string;
    let outcome: 'created' | 'updated';
    if (byName) {
      await tx.update(repos).set({ githubId: input.githubId }).where(eq(repos.id, byName.id));
      repoId = byName.id;
      outcome = 'updated';
    } else {
      const [row] = await tx
        .insert(repos)
        .values({
          owner: input.owner,
          name: input.name,
          githubId: input.githubId,
          defaultBranch: input.defaultBranch,
          testCommand: 'pnpm check',
        })
        .returning({ id: repos.id });
      if (!row) throw new Error('仓没写进去：insert 没回行');
      repoId = row.id;
      outcome = 'created';
    }
    const [audit] = await tx
      .insert(auditLog)
      .values({
        actorKind: input.actor.kind,
        actorId: input.actor.id,
        action: REPO_REGISTER,
        target: `repo:${repoId}`,
        before: byName ? { githubId: null } : null,
        after: { owner: input.owner, name: input.name, githubId: input.githubId },
        reason: input.reason,
        via: 'ops',
        ok: true,
      })
      .returning({ id: auditLog.id });
    if (!audit) throw new Error('操作记录没写进去：insert 没回行');
    return { outcome, repoId, auditId: audit.id };
  });
}
