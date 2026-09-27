// 开 PR 前别家验证（docs/decisions/0003-fusion-flow.md 第 5 条第 5 步，specs/213-开PR前验证/方案.md）：给 #214 的 Fusion
// 工作流调的一块，自己不是工作流。一轮 = 读默认分支上需求文档的「怎么算做完」→ 查写这张单的会话用过哪几族 → 只派别家起
// 验证会话（检出送检的头、只读；整份提示词先过卫生检查，在会话端口里）→ 经 decide 判结论（core 的 decideVerdict）→ 记进库。
// Lead 拿证据驳回：rebutRound 再经 decide 判一次、改写同一行记录。几轮、挡了回哪一步由调用方照 core 的 nextFlow 走
// （验证默认 1 轮、最多 2 轮）。写进 PR 正文的几行：verifyLines。
// 这里是工作流代码：判断只经 judge、编号只经 newId；改调度顺序要 patched()（kit.ts 头注释）。

import type { Rebuttal, VerdictDecision, VerifiedRound, VerifyReport } from '@fleet-dao/core';
import type { Repo } from '@fleet-dao/shared';
import type { RouteChoice, VerificationRecord } from '../ports.ts';
import { attempt, judge, type Kit, newId, park, runStage } from './kit.ts';

/** 过了或挡住（作废的不会交给调用方：作废就挂起等人，人点「继续」重验这一轮）。 */
export type RoundVerdict = Extract<VerdictDecision, { verdict: 'pass' | 'block' }>;

export interface VerifyRequest {
  /** 第几轮，从 1 起。最多几轮不在这里管：调用方照 core 的 nextFlow（FLOW_LIMITS.verifyRounds）。 */
  round: number;
  repo: Repo;
  /** 需求文档目录：单子正文里指的那个（core 的 specDirOf 认出来的，specs/<号>-<短名>），不按标题拼。 */
  specDir: string;
  /**
   * 这张单的需求文档还没进主线（正文写全了需求、收单时照正文写的，#295）：「怎么算做完」照库里这张单此刻的正文核
   * （GitHub 上改了正文由接活跟着改；分支上那份写这张单的会话能改，不读）。
   */
  criteriaFromBody?: boolean | undefined;
  /** 送检的头：已经推上去（过了推前卫生检查）的完整提交号。 */
  head: string;
  /** 单子标题和原话（提示词的「任务」一段）。 */
  title: string;
  request: string;
  branch?: string | undefined;
  /** Lead 写的方案摘要。 */
  planSummary: string;
  /** 这次改到的文件（相对主线）。 */
  changedFiles: string[];
  /** 改到了页面代码：禁令按界面类判（GPT 不派，含审界面）。 */
  uiWork?: boolean | undefined;
  /** 流程配置里验证这一步的模型顺序（0003 第 9 条）；不给照调度台。 */
  models?: string[] | undefined;
}

export interface VerifyRound {
  /** 库里 verify_rounds 这一行的编号：Lead 驳回后改写同一行。 */
  id: string;
  round: number;
  head: string;
  /** 验证会话（session_runs.id）和派给的路由。 */
  runId: string;
  route: RouteChoice;
  /** 写这张单的会话用过的族（验证派的一定不在里面）。 */
  authorFamilies: string[];
  /** 「怎么算做完」读自哪份文档、逐条原文。 */
  criteriaPath: string;
  criteria: string[];
  report: VerifyReport;
  /** 验证模型判的（驳回之前）。 */
  verdict: RoundVerdict;
  /** Lead 拿证据驳回的（这一轮的全部）。 */
  rebuttals: Rebuttal[];
  /** 驳回之后的结论（没驳回就是 verdict）：调用方拿 final.verdict 给 nextFlow 报 { kind: 'verified', verdict }。 */
  final: RoundVerdict;
}

/** PR 正文、挂起卡片上给人看的验证模型：模型和族（不写账号池）。 */
export function verifierLabel(route: Pick<RouteChoice, 'modelId' | 'family'>): string {
  return `${route.modelId}（${route.family} 族）`;
}

/**
 * 需求文档还没进主线的单（#295）：「怎么算做完」照库里这张单此刻的正文逐条读。读不到、正文里没有或空了：挂起等人补，
 * 不验、也不当成验过了；人补好点「继续」再读。
 */
async function bodyCriteria(kit: Kit): Promise<{ path: string; criteria: string[] }> {
  for (;;) {
    const { rawRequest } = await attempt(kit, 'taskRequest', () => kit.acts.taskRequest({ ...kit.scope }));
    const got = await judge(kit, 'bodyCriteria', { body: rawRequest });
    if ('ok' in got) return { path: '这张单的正文（需求文档随 PR 进主线）', criteria: got.ok };
    await park(
      kit,
      `开 PR 前验证没法逐条核：${got.error}`,
      `这张单还没有需求文档，「怎么算做完」照单子正文核：${got.error}。在单子正文里补上写了字的「## 怎么算做完」，再点「继续」`,
    );
  }
}

async function record(kit: Kit, row: Omit<VerificationRecord, keyof Kit['scope']>): Promise<void> {
  await attempt(kit, 'recordVerification', () => kit.acts.recordVerification({ ...kit.scope, ...row }));
}

function recordOf(r: VerifyRound): Omit<VerificationRecord, keyof Kit['scope']> {
  return {
    id: r.id,
    round: r.round,
    head: r.head,
    runId: r.runId,
    routeId: r.route.routeId,
    family: r.route.family,
    authorFamilies: r.authorFamilies,
    criteria: r.criteria,
    report: r.report,
    verdict: r.verdict.verdict,
    rebuttals: r.rebuttals,
    finalVerdict: r.final.verdict,
    reasons: r.final.verdict === 'block' ? r.final.reasons : [],
    notes: r.final.notes,
  };
}

/**
 * 验一轮。读不到需求文档或「怎么算做完」、查不到作者是哪一族（失败分流 VF1）、没有别家可派、材料没过卫生检查（HY4）：
 * 都挂起等人，不验也不当成验过了。验证模型交回的不算数（作废：审错了头、漏答、派成了同族……）：记一笔、挂起，人点「继续」
 * 从读文档起重验这一轮。只交回过了或挡住的。
 */
export async function verifyRound(kit: Kit, req: VerifyRequest): Promise<VerifyRound> {
  for (;;) {
    const read = req.criteriaFromBody
      ? await bodyCriteria(kit)
      : await attempt(kit, 'readCriteria', () =>
          kit.acts.readCriteria({ ...kit.scope, repo: req.repo, specDir: req.specDir }),
        );
    const authors = await attempt(kit, 'authorFamilies', () => kit.acts.authorFamilies({ ...kit.scope }));
    // 每一轮都是全新会话：不续上一轮的验证，免得带着上一轮的结论看这一轮
    const stage = await runStage(kit, {
      stage: 'verify',
      expect: 'verify',
      brief: {
        title: req.title,
        request: req.request,
        specDir: req.specDir,
        acceptance: [],
        touches: [],
        feedback: [],
        answers: [],
        head: req.head,
        ...(req.branch ? { branch: req.branch } : {}),
        verify: {
          criteria: read.criteria,
          specPath: read.path,
          planSummary: req.planSummary,
          changedFiles: req.changedFiles,
        },
      },
      avoidFamilies: authors.families,
      uiWork: req.uiWork,
      models: req.models,
      noRouteTitle: `没有别家可验：写这张单的是 ${authors.families.join('、')} 族，验证只派别家`,
    });
    const decision = await judge(kit, 'verdict', {
      criteria: read.criteria,
      sentHead: req.head,
      report: stage.output.report,
      verifierFamily: stage.route.family,
      authorFamilies: authors.families,
      rebuttals: [],
    });
    const id = await newId(kit);
    const common = {
      id,
      round: req.round,
      head: req.head,
      runId: stage.runId,
      routeId: stage.route.routeId,
      family: stage.route.family,
      authorFamilies: authors.families,
      criteria: read.criteria,
      report: stage.output.report,
      rebuttals: [],
    };
    if (decision.verdict === 'invalid') {
      await record(kit, { ...common, verdict: 'invalid', invalidWhy: decision.why, reasons: [], notes: [] });
      await park(
        kit,
        `验证作废：${decision.why}`,
        `第 ${req.round} 轮开 PR 前验证（${verifierLabel(stage.route)}，送检的头 ${req.head}）交回的不算数，没当成过了：${decision.why}。点「继续」从读需求文档起重验这一轮`,
      );
      continue;
    }
    const round: VerifyRound = {
      id,
      round: req.round,
      head: req.head,
      runId: stage.runId,
      route: stage.route,
      authorFamilies: authors.families,
      criteriaPath: read.path,
      criteria: read.criteria,
      report: stage.output.report,
      verdict: decision,
      rebuttals: [],
      final: decision,
    };
    await record(kit, recordOf(round));
    return round;
  }
}

/**
 * Lead 拿证据驳回（这一轮的全部驳回，覆盖上一次的）：经 decide 再判一次（core 的 decideVerdict，只认驳回能挡的、带证据的）。
 * 驳回不成立（驳的不是能挡的、没带证据）原样交回原因给 Lead，记录不动；成立就改写这一轮的记录，交回驳回之后的结论。
 */
export async function rebutRound(
  kit: Kit,
  round: VerifyRound,
  rebuttals: Rebuttal[],
): Promise<{ ok: true; round: VerifyRound } | { ok: false; why: string }> {
  const decision = await judge(kit, 'verdict', {
    criteria: round.criteria,
    sentHead: round.head,
    report: round.report,
    verifierFamily: round.route.family,
    authorFamilies: round.authorFamilies,
    rebuttals,
  });
  if (decision.verdict === 'invalid') return { ok: false, why: decision.why };
  const next: VerifyRound = { ...round, rebuttals, final: decision };
  await record(kit, recordOf(next));
  return { ok: true, round: next };
}

export function verifiedRound(r: VerifyRound): VerifiedRound {
  return {
    round: r.round,
    verifier: verifierLabel(r.route),
    criteria: r.criteria.length,
    rebuttals: r.rebuttals,
    final: r.final,
  };
}

/** 写进 PR 正文的几行：verified 进「怎么验证的」，owed 进「还欠什么」（core 的 verificationLines，经 decide）。 */
export async function verifyLines(
  kit: Kit,
  rounds: readonly VerifyRound[],
): Promise<{ verified: string[]; owed: string[] }> {
  return judge(kit, 'verifyLines', rounds.map(verifiedRound));
}
