// 全程模式第一期（#2826，单 #2807）：一张单走三段还是全程，在第一次选路之后、第一段动手之前定一次（工作流经活动 decideFlowMode 问，
// 结果进历史，重放不再读配置）。这里是判法（纯函数，chooseFlowMode）和那个活动的实现（读标签、开关、仓档案，写一次分组记录）。
//
// 判法（先后有讲究，原因写进 task_flow_assignments.reason）：
// 1. 贴了「三段」（或两个都贴）→ 三段；
// 2. 没贴「全程」：开关 engine.flowMode 是 three、仓档案没开 flowEligible → 三段；
// 3. 选中的路由不是 Claude 5.5（Sonnet 或 Opus）、已知的模块碰到迁移、合并闸、凭据、权限、任务工作流、发布脚本 → 三段（贴了「全程」也一样）；
// 4. 贴了「全程」→ 全程；开关 full → 全程；split:N → 同一档位里按单号哈希，桶号小于 N 走全程。
//
// 改这里之前必须知道：
// - 同一张单只分一次组（task_flow_assignments 每张单一行）：重做的下一代照原来那一组，不重新抽签，不再写。
// - 标签、仓档案读不到抛错（活动失败），不当成没贴、没开；工作流那一边没定成就按三段走并写明。
import { FULL_FLOW_LABEL, THREE_FLOW_LABEL } from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import {
  FLOW_MODE_SETTING,
  type FlowAssignment,
  FlowAssignmentExistsError,
  type FlowModeSetting,
  type NewFlowAssignment,
  parseRepoProfile,
  readFlowModeSetting,
} from '@fleet-dao/shared';
import type { PortContext } from './ports.ts';
import type { DecideFlowModeInput, DecideFlowModeResult } from './task-contract.ts';

/** 选中的路由是不是 Claude 5.5（Sonnet 或 Opus）：模型 id 形如 claude-opus-5-5、claude-sonnet-5-5[1m]。 */
export function isClaude55(modelId: string): boolean {
  return /^claude-(?:opus|sonnet)-5-5(?![0-9])/.test(modelId.trim().toLowerCase());
}

/** 已知的模块碰到这些一律三段：出了错代价大、或改的就是这套流程本身。 */
export const FULL_FLOW_BLOCKED_MODULES: readonly { what: string; pattern: RegExp }[] = [
  { what: '迁移', pattern: /migrations?\b|迁移|drizzle/i },
  { what: '合并闸', pattern: /merge-gate|合并闸/i },
  { what: '凭据', pattern: /credential|凭据|secret|密钥/i },
  { what: '权限', pattern: /permission|权限|sudoers|polkit/i },
  { what: '任务工作流', pattern: /packages\/engine\/src\/workflows\/|任务工作流/i },
  { what: '发布脚本', pattern: /deploy\/|release\.sh|release-train|发布脚本|发版脚本/i },
];

export interface FlowFacts {
  labels: readonly string[];
  setting: FlowModeSetting;
  repoEligible: boolean;
  modelId: string;
  touches: readonly string[];
  /** 分层（档位）。 */
  stratum: string;
  /** 哈希用的单号：owner/name#号。 */
  issueKey: string;
}

/** 0 到 99 的桶号（FNV-1a 32 位）：同一个键永远同一个桶。 */
export function flowBucket(key: string): number {
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(key)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % 100;
}

const three = (source: DecideFlowModeResult['source'], reason: string | null): DecideFlowModeResult => ({
  mode: 'three',
  source,
  reason,
});

/** 分组（纯函数）。退回三段的都写明原因。 */
export function chooseFlowMode(f: FlowFacts): DecideFlowModeResult {
  const wantFull = f.labels.includes(FULL_FLOW_LABEL);
  const wantThree = f.labels.includes(THREE_FLOW_LABEL);
  if (wantFull && wantThree) {
    return three('label', `「${FULL_FLOW_LABEL}」「${THREE_FLOW_LABEL}」两个标签都贴了，按三段`);
  }
  if (wantThree) return three('label', null);
  if (!wantFull) {
    if (f.setting.kind === 'three') return three('ineligible', `${FLOW_MODE_SETTING} 是 three：都走三段`);
    if (f.setting.kind === 'split' && f.setting.percent === 0) {
      return three('hash', null);
    }
    if (!f.repoEligible) return three('ineligible', '仓档案没开 flowEligible：这个仓的单先都走三段');
  }
  if (!isClaude55(f.modelId)) {
    return three('ineligible', `选中的路由是 ${f.modelId}，不是 Claude 5.5（Sonnet 或 Opus）`);
  }
  const hits = FULL_FLOW_BLOCKED_MODULES.filter((m) => f.touches.some((t) => m.pattern.test(t)));
  if (hits.length > 0) {
    return three('ineligible', `已知的模块碰到${hits.map((m) => m.what).join('、')}：一律三段`);
  }
  if (wantFull) return { mode: 'full', source: 'label', reason: null };
  if (f.setting.kind === 'full') return { mode: 'full', source: 'hash', reason: null };
  const percent = f.setting.kind === 'split' ? f.setting.percent : 0;
  const full = flowBucket(`${f.stratum}:${f.issueKey}`) < percent;
  return full ? { mode: 'full', source: 'hash', reason: null } : three('hash', null);
}

export interface DecideFlowModeDeps {
  /** 这张单现在贴着的标签（现读 GitHub）。读不到抛错。 */
  readLabels(repo: RepoRef, issueNumber: number, signal: AbortSignal): Promise<readonly string[]>;
  /** 设置表里 engine.flowMode 那一行的原值；没设过回 undefined。 */
  readSetting(): Promise<unknown>;
  /** 这个仓的档案原文（库里的，没补默认值）。没有这个受管仓抛错。 */
  readProfile(repo: RepoRef): Promise<unknown>;
  /** 写分组记录（顺带写 tasks.flow_mode）。已经有了抛 FlowAssignmentExistsError。 */
  record(input: NewFlowAssignment): Promise<FlowAssignment>;
  /** 这张单已有的分组记录。 */
  existing(taskId: string): Promise<FlowAssignment | null>;
}

const resultOf = (a: FlowAssignment): DecideFlowModeResult => ({
  mode: a.mode,
  source: a.source,
  reason: a.reason,
});

/** 定模式的活动：已经分过组照原来的；没分过读事实、判、写一次。 */
export function createDecideFlowMode(
  deps: DecideFlowModeDeps,
): (input: DecideFlowModeInput, ctx: PortContext) => Promise<DecideFlowModeResult> {
  return async (input, ctx) => {
    const prior = await deps.existing(input.taskId);
    if (prior) return resultOf(prior);
    const repo: RepoRef = { owner: input.repo.owner, name: input.repo.name };
    const labels = await deps.readLabels(repo, input.issueNumber, ctx.signal);
    const reading = readFlowModeSetting(await deps.readSetting());
    const profile = parseRepoProfile(await deps.readProfile(repo));
    let choice = chooseFlowMode({
      labels,
      setting: reading.setting,
      repoEligible: profile.flowEligible,
      modelId: input.modelId,
      touches: input.touches,
      stratum: input.stratum,
      issueKey: `${repo.owner}/${repo.name}#${input.issueNumber}`.toLowerCase(),
    });
    // 开关的值认不出：按 three，原因写认不出的原话（不悄悄吞）
    if (reading.state === 'unrecognized' && choice.source === 'ineligible' && choice.mode === 'three') {
      choice = { ...choice, reason: reading.problem };
    }
    try {
      await deps.record({
        taskId: input.taskId,
        mode: choice.mode,
        source: choice.source,
        stratum: input.stratum,
        reason: choice.reason,
      });
    } catch (error) {
      if (!(error instanceof FlowAssignmentExistsError)) throw error;
      // 同一张单的上一次尝试已经写下了（活动重试）：照写下的那一组
      const again = await deps.existing(input.taskId);
      if (again) return resultOf(again);
      throw error;
    }
    return choice;
  };
}
