// 测试用的宿主工作流：#214 的 Fusion 工作流接上之前，在真 Temporal（测试服务端）里把 src/workflows/verify.ts 这一块
// 照 core 的 nextFlow 跑起来——第 5 步验证：挡了回第 4 步（这里当作 Lead 已经改好、收下），最多 2 轮；
// 挡住的那一轮 Lead 按输入拿证据驳回。和真工作流一样经 decide 判、经 newId 取编号，用引擎的活动（假端口）。
import type { FlowState, Rebuttal } from '@fleet-dao/core';
import type { Repo } from '@fleet-dao/shared';
import { CancellationScope, defineQuery, isCancellation, setHandler } from '@temporalio/workflow';
import {
  activitiesFor,
  installControl,
  judge,
  type Kit,
  limitsFor,
  newKit,
  type View,
} from '../../../src/workflows/kit.ts';
import { rebutRound, type VerifyRound, verifyLines, verifyRound } from '../../../src/workflows/verify.ts';

export interface VerifyHostInput {
  taskId: string;
  repo: Repo;
  specDir: string;
  /** 第 n 轮送检的头（下标 n - 1）。 */
  heads: string[];
  /** 第 n 轮挡住之后 Lead 拿证据驳回的（键是轮次）。 */
  rebuttals?: Record<string, Rebuttal[]>;
  uiWork?: boolean;
}

export interface VerifyHostResult {
  rounds: VerifyRound[];
  lines: { verified: string[]; owed: string[] };
  /** 验证之后 nextFlow 给的下一步（open-pr 或 wait-human）和那时的状态。 */
  action: string;
  state: FlowState;
  /** Lead 的驳回没成立的原因（驳的不是能挡的、没带证据）。 */
  leadRefused: string[];
  stopped: boolean;
}

export type VerifyHostStatus = View & { parked: boolean };

export const verifyHostStatusQuery = defineQuery<VerifyHostStatus>('status');

const AT_VERIFY: FlowState = {
  mode: 'fusion',
  step: 'verify',
  mother: false,
  blocks: 1,
  block: 0,
  reworks: 0,
  takeover: false,
  verifyRounds: 0,
  ciRounds: 0,
  small: false,
  highRisk: false,
};

export async function verifyHost(input: VerifyHostInput): Promise<VerifyHostResult> {
  const view: View = { waiting: null, lastProblem: null, route: null, runId: null, sessionId: null };
  const main = new CancellationScope();
  const control = installControl(undefined, { onStop: () => main.cancel(), mainStages: ['verify'] });
  setHandler(verifyHostStatusQuery, () => ({ ...view, parked: control.parked }));
  const limits = await limitsFor(undefined);
  const kit: Kit = newKit({
    acts: activitiesFor(limits),
    limits,
    control,
    scope: { taskId: input.taskId },
    view,
    onChange: () => undefined,
  });

  const rounds: VerifyRound[] = [];
  const leadRefused: string[] = [];
  let state = AT_VERIFY;
  let action = 'verify';
  try {
    await main.run(async () => {
      for (let n = 1; action === 'verify'; n += 1) {
        const head = input.heads[n - 1];
        if (!head) throw new Error(`第 ${n} 轮没给送检的头`);
        let round = await verifyRound(kit, {
          round: n,
          repo: input.repo,
          specDir: input.specDir,
          head,
          title: '登录页加验证码',
          request: '给登录页加手机验证码',
          planSummary: '登录表单加验证码输入，后端校验五分钟过期',
          changedFiles: ['src/login/form.ts', 'src/login/code.ts'],
          ...(input.uiWork ? { uiWork: true } : {}),
        });
        const rebuttals = input.rebuttals?.[String(n)];
        if (round.final.verdict === 'block' && rebuttals) {
          const rebutted = await rebutRound(kit, round, rebuttals);
          if (rebutted.ok) round = rebutted.round;
          else leadRefused.push(rebutted.why);
        }
        rounds.push(round);
        const decided = await judge(kit, 'fusionFlow', {
          state,
          event: { kind: 'verified', verdict: round.final.verdict },
        });
        if (!decided.ok) throw new Error(decided.why);
        state = decided.state;
        action = decided.action;
        if (action === 'dispatch') {
          // 挡了回第 4 步：Lead 照挡的理由派副手改好、收下，再送检下一轮
          const accepted = await judge(kit, 'fusionFlow', { state, event: { kind: 'accepted' } });
          if (!accepted.ok) throw new Error(accepted.why);
          state = accepted.state;
          action = accepted.action;
        }
      }
    });
  } catch (error) {
    if (!isCancellation(error)) throw error;
    return { rounds, lines: { verified: [], owed: [] }, action, state, leadRefused, stopped: true };
  }
  const lines = await verifyLines(kit, rounds);
  return { rounds, lines, action, state, leadRefused, stopped: false };
}
