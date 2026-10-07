// 任务工作流（#632 S2-4；specs/632-三段总调度/方案.md §五）：一张单从被拉起到合并、关单，一条工作流走完。
// 纯编排：每个副作用（读单子、选路、建树、起会话、推分支、开 PR、等 CI、冷验收、合并、关单）都在活动里；这里只管顺序、
// 几轮、碰到失败怎么办、什么时候停下等人。重放安全：不取随机数、不生成编号（会话编号由活动自己起），判断失败怎么办经 decide('failure')。
//
// 按职责拆在同目录：task-runtime.ts（状态、等待、停下等人、失败分流的底座）、task-session.ts（选路 + 动手会话）、
// task-ci.ts（等 CI）、task-verify.ts（冷验收）、task-merge.ts（查路径、挂自动合并、等合并）、task-support.ts（无状态小零件）。
// 这里的 TaskFlow 只留：读交代、动手一轮（建树、读交付、推分支、开 PR）、推上去之后的顺序、收尾。
//
// 一张单的路：读交代 → [选路 → 建树（第一轮）→ 动手会话 → 读交付 → 推分支 → 开 PR（第一轮）→ 等 CI → 冷验收] 最多 3 轮 →
// 碰没碰「改标准」→ 挂自动合并 → 等合并 → 关单、收树。
// 返工只有这几种：没产生提交、CI 红了、合并冲突、验收没过；返工意见带进下一轮动手会话。验收最多 2 轮（specs/555）。
//
// 停下等人（waiting.kind = human，驾驶舱点「继续」「放弃」发信号）只有这几处，而且每一处都写清卡在哪、要人干什么：
// - 交代不全（缺栏）；没有可用的路由；失败分流判「挂起」（同因连着两次再犯、额度要等很久、登录失效……）；
// - 动手 3 轮、验收 2 轮都没过；验收做不出来（读不到 diff、没有别家模型、会话没跑成）；
// - 改到了「改标准」的路径（人闸第四类，要创始人同意才挂自动合并）；
// - PR 被关了、PR 的头被别人改了。
// 「继续」之后从头再试这一步；「放弃」收尾退出（工作树存档后删，PR 和单子不动，由人处理）。
//
// 改这里之前必须知道：
// - 挂自动合并一定在冷验收通过之后。合并闸认引擎任务流程的 PR（分支 fleet/<单号>-t<8 位>）头上通过的 cold-verify（#555-2、#625），
//   每小时对账的兜底不碰这些分支（jobs/auto-merge-check.ts）；拉单入口在闸或冷验收没接上时不让任何仓接活
//   （jobs/intake.ts 的 MERGE_GATE_REQUIRES_COLD_VERIFY）。头换了（人推过新提交）就对新的头重走 CI 和验收，不原样重新挂：
//   新头上没有 cold-verify，合并闸不会放行。
// - 动手会话只试一次（activity-options.ts 的 segment 档）：基础设施的失败由 task-session.ts 按失败分流重试、换路由、挂起，不靠 Temporal 自动再起一遍。
// - 切号停下的动手会话（码 org_switch，#59）不算失败：失败分流 OS1 马上接着干、不记账、不看上一次的原文（不会凑成「同因连挂」）；
//   选路照常选到切过去的那个池，同一棵树、同一个分支重跑这一段，提示词带上被停下的原因（interrupted）。
// - 暂停（#820 片 3，taskPause 信号）只停这一张单、能「继续」：停在检查点（rt.checkpoint，起新会话、选路、起新一步之前），库里 phase=paused、
//   state 仍是 running，不报警；soft 手上这一段做完，hard 把动手会话取消、继续后在原树原分支上重跑（提示词带「被人暂停」，task-session.ts）。
//   检查点只在收到信号时才多调活动，老历史重放不受影响（patched('task-pause')，test/replay.test.ts 的夹具）。
// - 第 2 轮起、动手会话起之前先把最新主线并进任务分支（#1246，task-sync.ts；patched('sync-mainline-before-implement')）：并上了就推、树跟着快进；
//   并出冲突把文件名记进返工意见交给这一轮的会话；没查成记下照旧往下走。验收前不并（并了头就变）。
// - 推分支并主线撞上内容冲突（MERGE_CONFLICT，patched('conflict-handoff-keeps-tree')）：不在 push 这一步里原地重试。
//   树里留着合并的冲突标记，交回下一轮动手会话；交回时 MERGE_HEAD 还在或 git diff --check 还有冲突标记，不算交活、不推。
//   上一轮没解就在反馈里补一句；反馈和上一轮一字不差才挂起，提醒里写冲突文件和工作树路径。老历史没有这个标记，照旧在 step 里重试。
// - 「放弃」「叫停」都要把正在跑的长活动取消掉（runSegment、coldVerify、waitCi、waitMerged 都心跳，收得到取消）。

import { CancellationScope, isCancellation, log, workflowInfo } from '@temporalio/workflow';
import type { EngineActivities } from '../activity-options.ts';
import type { Limits } from '../limits.ts';
import type { Worktree } from '../ports.ts';
import type { TaskBrief } from '../runner/task-brief.ts';
import type { TierDecision } from '../runner/tier.ts';
import {
  type AbandonCommand,
  MAX_IMPLEMENT_ROUNDS,
  type TaskRun,
  type TaskWorkflowInput,
  taskBranch,
} from '../task-contract.ts';
import { activitiesFor, limitsFor } from './kit.ts';
import { waitForCi } from './task-ci.ts';
import { armAndWaitMerged, guardedPaths } from './task-merge.ts';
import { TaskRuntime } from './task-runtime.ts';
import { writeSession } from './task-session.ts';
import { Abandoned, ConflictHandoff, conflictHandoffLine } from './task-support.ts';
import { syncMainlineBeforeImplement } from './task-sync.ts';
import { coldVerifyPr } from './task-verify.ts';

class TaskFlow {
  private readonly rt: TaskRuntime;

  constructor(input: TaskWorkflowInput, acts: EngineActivities, limits: Limits) {
    this.rt = new TaskRuntime(input, acts, limits);
  }

  async run(): Promise<TaskRun> {
    const rt = this.rt;
    const { brief, tier } = await this.readBrief();
    rt.status.tier = tier;
    rt.branch = taskBranch(rt.input.issueNumber, workflowInfo().runId);
    await rt.mirror('running');

    for (;;) {
      await rt.checkpoint();
      if (rt.round >= MAX_IMPLEMENT_ROUNDS) {
        await rt.park(
          `动手 ${MAX_IMPLEMENT_ROUNDS} 轮都没过`,
          `最近的返工意见：${rt.feedback.join('；') || '（没有）'}。点「继续」再给一整轮；或「放弃」。`,
        );
        rt.round = 0;
      }
      rt.round += 1;
      if (!(await this.implement(brief, tier))) continue;

      const delivered = await this.deliver(brief);
      if (delivered === 'rework') continue;
      return this.finish(delivered.commit);
    }
  }

  /**
   * 推上去以后的路：等 CI → 冷验收 → 查路径 → 挂自动合并、等合并。回 'rework'＝要回去再动手一轮（意见已记下）。
   * 等合并时 PR 的头被别人改了、人看过点「继续」：新的头上没有验收状态，合并闸（引擎任务流程的 PR 要有通过的 cold-verify）
   * 不会放行，原样重新挂只会永远等下去——所以回到等 CI，对新的头把这条路重走一遍。
   */
  private async deliver(brief: TaskBrief): Promise<'rework' | { commit?: string | undefined }> {
    const rt = this.rt;
    for (;;) {
      await rt.checkpoint();
      const ci = await waitForCi(rt);
      if (ci.kind === 'merged') return { commit: ci.mergeCommit };
      if (ci.kind === 'rework') return 'rework';

      const verdict = await coldVerifyPr(rt, brief);
      if (verdict === 'rework') return 'rework';
      if (verdict === 'head_moved') {
        rt.verifyRound = 0; // 头换了，验收对新的头重新数轮
        continue;
      }

      await guardedPaths(rt);
      const merged = await armAndWaitMerged(rt);
      if (merged.kind === 'merged') return { commit: merged.commit };
      rt.verifyRound = 0; // 头换了，验收对新的头重新数轮
    }
  }

  /** 读交代：缺栏就停下等人补，补了点「继续」再读。 */
  private async readBrief(): Promise<{ brief: TaskBrief; tier: TierDecision }> {
    const rt = this.rt;
    for (;;) {
      rt.set('brief', '读单子和需求文档');
      const got = await rt.step('readTaskBrief', () =>
        rt.acts.readTaskBrief({
          schemaVersion: 1,
          repo: { owner: rt.input.repo.owner, name: rt.input.repo.name },
          issueNumber: rt.input.issueNumber,
        }),
      );
      if (got.ok) return { brief: got.brief, tier: got.brief.tier };
      await rt.park('单子的交代不全，没法动手', got.problems.map((p) => `【${p.field}】${p.why}`).join('\n'));
    }
  }

  /** 一轮动手：选路 → 建树 → 会话 → 读交付 → 推分支 → 开 PR。回 false＝这一轮要返工（意见已记下）。 */
  private async implement(brief: TaskBrief, tier: TierDecision): Promise<boolean> {
    const rt = this.rt;
    rt.set('implement', `动手第 ${rt.round} 轮`);
    const wt = await this.ensureWorktree();
    await syncMainlineBeforeImplement(rt);
    await writeSession(rt, brief, tier, wt);

    const delivery = await rt.step('readDelivery', () =>
      rt.acts.readDelivery({
        schemaVersion: 1,
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        worktreePath: wt.path,
        baseSha: rt.since,
      }),
    );
    // 老历史里读交付的结果没有 leftover、conflicts：当作没有
    const conflicts = delivery.conflicts ?? [];
    if (conflicts.length > 0) return this.conflictStillThere(wt, conflicts);
    const leftover = delivery.leftover ?? [];
    if (delivery.commits === 0 || leftover.length > 0) {
      const left =
        leftover.length > 0 ? `工作树里还有没提交的改动：${leftover.slice(0, 10).join('、')}。` : '';
      rt.feedback = [
        delivery.commits === 0
          ? `上一轮会话跑完了，但没有产生新的提交。改完之后要用 git commit 提交，不提交等于没做。${left}`
          : `${left}只有提交了的才会进 PR：要么 git add 再 git commit，要么删掉不要的文件。`,
      ];
      rt.status.lastProblem =
        delivery.commits === 0 ? '会话跑完没有提交' : '会话跑完工作树里还有没提交的改动';
      return false;
    }
    let pushed: Awaited<ReturnType<typeof rt.acts.pushBranch>>;
    try {
      pushed = await rt.step('pushBranch', () =>
        rt.acts.pushBranch({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          worktreePath: wt.path,
          branch: rt.branch,
          head: delivery.head,
        }),
      );
    } catch (error) {
      if (error instanceof ConflictHandoff) return this.conflictStillThere(wt, error.files);
      throw error;
    }
    rt.head = pushed.head;
    rt.since = delivery.head;
    rt.changedFiles = pushed.changedFiles ?? delivery.changedFiles;
    if (rt.prNumber === null) {
      const pr = await rt.step('openPr', () =>
        rt.acts.openPr({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          branch: rt.branch,
          head: pushed.head,
          title: rt.input.title,
          body: {
            requirement: rt.input.issueNumber,
            did: [
              `按 #${rt.input.issueNumber} 的要求动手（第 ${rt.round} 轮）`,
              `改了 ${rt.changedFiles.length} 个文件`,
            ],
            verified: ['CI 和冷验收的结果看这个 PR 的检查（验收通过才挂自动合并）'],
          },
        }),
      );
      rt.prNumber = pr.prNumber;
    }
    await rt.advance('implement', `第 ${rt.round} 轮推上去了，PR #${rt.prNumber}`);
    rt.feedback = [];
    return true;
  }

  /** 冲突还在：交给下一轮会话。反馈和上一轮一字不差就挂起，提醒里写冲突文件和树的位置。 */
  private async conflictStillThere(wt: Worktree, files: readonly string[]): Promise<boolean> {
    const rt = this.rt;
    const line = conflictHandoffLine(files, rt.feedback);
    if (rt.feedback.includes(line)) {
      const names = files.join('、') || '（没读到冲突文件名）';
      const where = `冲突文件：${names}。工作树：${wt.path}`;
      await rt.park(`和上一次的原文一字不差，原路再试不会变。${where}`, where);
      return false;
    }
    rt.feedback = [line];
    rt.status.lastProblem = '和主线有冲突';
    return false;
  }

  private async ensureWorktree(): Promise<Worktree> {
    const rt = this.rt;
    if (rt.worktree) return rt.worktree;
    const wt = await rt.step('createWorktree', () =>
      rt.acts.createWorktree({
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        branch: rt.branch,
      }),
    );
    rt.worktree = wt;
    rt.since = wt.baseSha;
    return wt;
  }

  /** 收尾：关单、收工作树、写库。 */
  private async finish(commit?: string): Promise<TaskRun> {
    const rt = this.rt;
    rt.set('done', `PR #${rt.prNumber} 已合并`);
    rt.status.lastProblem = null;
    await rt.step('closeIssue', () =>
      rt.acts.closeIssue({
        taskId: rt.input.taskId,
        repo: rt.input.repo,
        issueNumber: rt.input.issueNumber,
        reason: 'completed',
        comment: `已合并：PR #${rt.prNumber}${commit ? `（${commit.slice(0, 7)}）` : ''}`,
      }),
    );
    await this.cleanup(false);
    await rt.mirror('done');
    return {
      outcome: 'merged',
      prNumber: rt.prNumber,
      head: rt.head,
      rounds: rt.round,
      verifyRounds: rt.verifyRound,
    };
  }

  /** 收工作树。没合并就收（放弃、叫停）的先存档。收不掉只记日志：占盘，每小时对账的工作树清扫会收。 */
  async cleanup(archive: boolean): Promise<void> {
    const rt = this.rt;
    const wt = rt.worktree;
    if (!wt) return;
    try {
      await CancellationScope.nonCancellable(() =>
        rt.acts.removeWorktree({
          taskId: rt.input.taskId,
          repo: rt.input.repo,
          path: wt.path,
          branch: rt.branch,
          archive,
        }),
      );
      rt.worktree = null;
    } catch (error) {
      log.warn('工作树没收掉（每小时对账的工作树清扫会收）', { error: String(error) });
    }
  }

  async abandoned(command: AbandonCommand): Promise<TaskRun> {
    const rt = this.rt;
    rt.set('abandoned', `被 ${command.by} 放弃：${command.reason}`);
    await this.cleanup(true);
    await rt.mirror('stopped');
    return {
      outcome: 'abandoned',
      prNumber: rt.prNumber,
      head: rt.head,
      rounds: rt.round,
      verifyRounds: rt.verifyRound,
    };
  }

  /** 工作流自己被取消（叫停）：先存档收树，再让取消往外抛。 */
  async cancelled(): Promise<void> {
    const rt = this.rt;
    rt.set('abandoned', '工作流被取消');
    await this.cleanup(true);
    await CancellationScope.nonCancellable(() => rt.mirror('stopped'));
  }
}

export async function taskWorkflow(input: TaskWorkflowInput): Promise<TaskRun> {
  const limits = await limitsFor(undefined);
  const flow = new TaskFlow(input, activitiesFor(limits), limits);
  try {
    return await flow.run();
  } catch (error) {
    if (error instanceof Abandoned) return flow.abandoned(error.command);
    if (isCancellation(error)) await CancellationScope.nonCancellable(() => flow.cancelled());
    throw error;
  }
}
