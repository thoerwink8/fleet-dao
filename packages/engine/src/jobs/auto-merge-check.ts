// 开着的 PR 由每小时对账兜底挂上自动合并（#242）：同一个坑踩了两次（09-25 一个 PR 全绿却没人合、#163 全绿 12 个小时
// 没人挂自动合并）——「PR 开出来就挂自动合并」只靠开 PR 的人记得跑 `gh pr merge --auto`，漏了没有任何兜底；
// 能不能合本来就只看合并闸，没理由让一个 PR 因为没挂自动合并而干等。
// 一张 PR 挂上自动合并的判法（design 第五节「合并闸」）：开着、作者是我们机器人开的、不是草稿、没挂自动合并、
// 当前头上那几条必过检查绿、不碰改标准的路径（照 main 上的 standard-paths.json 判，@fleet-dao/conventions 的
// parseStandardPaths / standardFiles：支持目录和通配）——挂上 squash 的自动合并（用「引擎」机器人身份：
// GitHub Actions 自带的 GITHUB_TOKEN 挂的不会触发主线上后续工作流，法国自动发布就会一直等不到主线的 CI）。
// 读不到、判不出、挂不上的照实报警、写进这一轮没查成，不当成挂上了；不再开着的（掉了、合了、关了）那条提醒撤掉。
// 改这里之前必须知道：
// - 只挂自动合并，不手动合（`gh pr merge`）。碰到改标准路径的 PR 不挂，留给创始人：同意了由开 PR 的人贴上原话再挂
//   （合并闸认正文里的「创始人原话」，缺了判红，决定 0093）；这里替不了他同意。
// - 任务工作流（#632）起的 PR（分支 fleet/<单号>-t<8 位>）不归这里挂：它们的自动合并只由工作流在冷验收通过之后挂；
//   这里照 CI 绿就挂，会抢在验收之前把没验过的合进主线。判在读文件和清单之前（便宜、也不会因为清单读不出报一堆提醒）。

import { type StandardPath, standardFiles } from '@fleet-dao/conventions';
import type { RepoRef } from '@fleet-dao/github';
import { errMessage } from '@fleet-dao/shared/util';
import { standardPathsList } from '../standard-paths-list.ts';
import { isTaskBranch } from '../task-branch.ts';
import { clip, RECONCILE_ACTOR, type SweepPart } from './reconcile-common.ts';

/** 自动合并兜底用的 PR 的样子（claims 的 PullFacts 简化版）。 */
export interface PrAutoMergeCandidate {
  number: number;
  nodeId: string;
  state: 'open' | 'closed';
  draft: boolean;
  /** 作者是不是「干活的」机器人。 */
  authorIsBot: boolean;
  /** 已经挂上了自动合并。 */
  autoMerge: boolean;
  headSha: string;
  /** PR 的分支名：任务工作流的分支（task-branch.ts）不归兜底挂。 */
  headRef: string;
}

/** 改到的文件（github 包的 pullFiles 那一份）。 */
export interface PrChangedFile {
  filename: string;
  status: string;
  patch?: string;
  previous?: string;
}

/** 受管仓。没给 ciPolicy 当强制，不当成不强制。 */
export type AutoMergeRepo = RepoRef & { ciPolicy?: 'force' | 'off' | undefined };

/** 自动合并兜底要的 GitHub 读法（每仓一次 openPulls、按 PR 走 pullFiles + CI + 清单 + enableAutoMerge）。 */
export interface AutoMergeGitHub {
  /** 开着的 PR，转成这一侧要的形状（翻完页；翻不完抛错，不当成就这几个）。 */
  listPrs(repo: RepoRef): Promise<PrAutoMergeCandidate[]>;
  /** PR 改到的文件（翻完页，带 patch）。 */
  pullFiles(repo: RepoRef, prNumber: number): Promise<PrChangedFile[]>;
  /** 这个头上那几个必过检查的 verdict（绿才算过；不上头跑了的不算）。 */
  checksEvaluate(
    repo: RepoRef,
    sha: string,
    required: string[],
  ): Promise<'green' | 'red' | 'pending' | 'none'>;
  /** 这几个必过检查的名字（取自主线规则集；仓里没有就抛错，不拿空算绿）。 */
  requiredChecks(repo: RepoRef): Promise<string[]>;
  /**
   * 这个仓主线上的改标准路径清单原文。文件不在回 null（空清单，standardPathsList）；
   * 读失败照抛，调用方记没查成。认不认得出由 standardPathsList 判。
   */
  readStandardPathsFile(repo: RepoRef): Promise<string | null>;
  /** 挂上自动合并（「引擎」机器人身份，squash）。 */
  enableAutoMerge(repo: RepoRef, pull: { number: number; nodeId: string }): Promise<void>;
  /**
   * 不强制 CI 的任务分支：直接合并，不挂自动合并。没接上时调用方记没查成，不假装合过。
   * 回 merged:false 同样记没查成。
   */
  mergeNow?(
    repo: RepoRef,
    pull: { number: number; expectedHead: string },
  ): Promise<{ merged: boolean; detail?: string | undefined }>;
}

/** 自动合并兜底那部分要的提醒读写。 */
export interface AutoMergeAlerts {
  raise(input: {
    dedupeKey: string;
    level: 'alert';
    taskId: null;
    title: string;
    body: string;
    link?: string | undefined;
  }): Promise<void>;
  resolve(input: { dedupeKey: string; by: string; why: string }): Promise<string>;
  /** 这个前缀下、还开着的提醒。 */
  listOpenByPrefix(prefix: string): Promise<{ dedupeKey: string }[]>;
}

export interface AutoMergeCheckDeps {
  /** 受管的仓（库里的 repos 表）。ciPolicy 缺省当强制。 */
  repos(): Promise<AutoMergeRepo[]>;
  gh: AutoMergeGitHub;
  autoMergeAlerts: AutoMergeAlerts;
  log(level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

/** 挂在自动合并会等下去了的提醒的前缀（挂在 PR 号上的）。 */
export const AUTO_MERGE_ALERT_PREFIX = 'reconcile:auto-merge:';

/** 一轮看的 PR 上限：整个仓超过它这一轮不查（写进没查成）；不拿看不到的当没事。 */
const SCAN_LIMIT = 100;

function alertKey(repo: RepoRef, prNumber: number): string {
  return `${AUTO_MERGE_ALERT_PREFIX}${repo.owner}/${repo.name}#${prNumber}`;
}

/** 不再挂了（合了、关了、被挂上、不再符合挂上条件）：撤掉那条提醒（没有也照退）。 */
async function resolveOne(
  deps: AutoMergeCheckDeps,
  repo: RepoRef,
  prNumber: number,
  why: string,
): Promise<void> {
  try {
    await deps.autoMergeAlerts.resolve({ dedupeKey: alertKey(repo, prNumber), by: RECONCILE_ACTOR, why });
  } catch {
    // 撤不掉不拦着走（多半是没有这条提醒，好过 throw）；下一轮再来
  }
}

/** 没查成的：报一条提醒（dedupe 到 PR 号上）、记进 unchecked，这一条不挂也不当挂上。 */
async function reportFailure(
  deps: AutoMergeCheckDeps,
  repo: RepoRef,
  prNumber: number,
  why: string,
  part: SweepPart,
): Promise<void> {
  const slug = `${repo.owner}/${repo.name}`;
  const key = alertKey(repo, prNumber);
  try {
    await deps.autoMergeAlerts.raise({
      dedupeKey: key,
      level: 'alert',
      taskId: null,
      title: clip(`查 ${slug}#${prNumber} 要不要挂自动合并未查成`, 300),
      body: `${why}。查成之前不挂；查成了（挂上、或不再符合挂上条件的）这条自己撤。`,
      link: `https://github.com/${slug}/pull/${prNumber}`,
    });
  } catch (err) {
    part.unchecked.push(`提醒 ${key} 报不进：${errMessage(err)}`);
    return;
  }
  part.unchecked.push(`${slug}#${prNumber} ${why}`);
}

/** 一张 PR：判要不要挂、挂；挂上了撤销那条提醒、进 found。每一步读不到、判不出都明确抛错。 */
function repoCiPolicy(repo: AutoMergeRepo): 'force' | 'off' {
  return repo.ciPolicy === 'off' ? 'off' : 'force';
}

/** 这个仓的改标准清单。文件不在＝空清单；读失败、认不出照抛。 */
async function standardList(deps: AutoMergeCheckDeps, repo: AutoMergeRepo): Promise<StandardPath[]> {
  const text = await deps.gh.readStandardPathsFile(repo).catch((e) => {
    throw new Error(`读改标准路径清单没成：${errMessage(e)}`);
  });
  return standardPathsList(text);
}

/** 不强制 CI 的任务分支：改标准照旧不合并，其余由引擎直接合并，不看检查、不挂自动合并。 */
async function mergeOffTaskBranch(
  deps: AutoMergeCheckDeps,
  repo: AutoMergeRepo,
  pr: PrAutoMergeCandidate,
  part: SweepPart,
): Promise<void> {
  const files = await deps.gh.pullFiles(repo, pr.number);
  const risks = standardFiles(files, await standardList(deps, repo));
  if (risks.length > 0) {
    await resolveOne(deps, repo, pr.number, '改到了改标准的路径，不挂：等创始人同意');
    deps.log('info', '每小时对账：不强制 CI 的任务 PR 改到改标准路径，不直接合并', {
      repo: `${repo.owner}/${repo.name}`,
      prNumber: pr.number,
      hits: risks.slice(0, 3).map((r) => r.rule),
    });
    return;
  }
  if (!deps.gh.mergeNow) throw new Error('不强制 CI 的任务 PR 要直接合并，这一轮没接上直接合并');
  const merged = await deps.gh.mergeNow(repo, { number: pr.number, expectedHead: pr.headSha });
  if (!merged.merged) throw new Error(merged.detail ?? '直接合并没成');
  part.found += 1;
  deps.log('info', '每小时对账：不强制 CI 的任务 PR 已直接合并', {
    repo: `${repo.owner}/${repo.name}`,
    prNumber: pr.number,
  });
  await resolveOne(deps, repo, pr.number, '每小时对账直接合并了（这个仓不强制 CI）');
}

async function judgeOne(
  deps: AutoMergeCheckDeps,
  repo: AutoMergeRepo,
  pr: PrAutoMergeCandidate,
  part: SweepPart,
): Promise<void> {
  part.scanned += 1;
  // 草稿不挂（挂了没用，GitHub 也不会给草稿起 CI）；撤掉那条提醒，等下一轮再看
  if (pr.draft) {
    await resolveOne(deps, repo, pr.number, '这张 PR 还是草稿，挂上也没用（做完了点 Ready for review）');
    return;
  }
  if (!pr.authorIsBot) {
    await resolveOne(deps, repo, pr.number, '不是我们机器人开的 PR，自动合并兜底不看它');
    return;
  }
  if (isTaskBranch(pr.headRef)) {
    if (repoCiPolicy(repo) === 'off') {
      await mergeOffTaskBranch(deps, repo, pr, part);
      return;
    }
    await resolveOne(
      deps,
      repo,
      pr.number,
      '任务工作流的 PR：自动合并只由工作流在冷验收通过之后挂，兜底不挂',
    );
    return;
  }
  if (pr.autoMerge) {
    await resolveOne(deps, repo, pr.number, '已经挂上了自动合并');
    return;
  }
  const files = await deps.gh.pullFiles(repo, pr.number);
  const risks = standardFiles(files, await standardList(deps, repo));
  if (risks.length > 0) {
    await resolveOne(deps, repo, pr.number, '改到了改标准的路径，不挂：等创始人同意');
    deps.log('info', '每小时对账：PR 改到改标准路径，不挂自动合并', {
      repo: `${repo.owner}/${repo.name}`,
      prNumber: pr.number,
      hits: risks.slice(0, 3).map((r) => r.rule),
    });
    return;
  }
  const required = await deps.gh.requiredChecks(repo);
  const verdict = await deps.gh.checksEvaluate(repo, pr.headSha, required);
  if (verdict !== 'green') {
    await resolveOne(deps, repo, pr.number, `CI 在这个头上还不绿（是 ${verdict}），还没到能挂的那一步`);
    return;
  }
  await deps.gh.enableAutoMerge(repo, pr);
  part.found += 1;
  deps.log('info', '每小时对账：给开着的 PR 挂上了自动合并', {
    repo: `${repo.owner}/${repo.name}`,
    prNumber: pr.number,
  });
  await resolveOne(deps, repo, pr.number, '每小时对账挂上了自动合并');
}

/**
 * 每个受管的仓：开着、作者是我们机器人、不是草稿、没挂自动合并、头上 CI 是绿的、不碰改标准路径的 PR 挂上自动合并；
 * 不再开着的、或者不再符合挂上条件的那条提醒撤掉。每张 PR、每个仓读不到、判不出都记一条没查成。
 */
export async function checkAutoMerges(deps: AutoMergeCheckDeps): Promise<SweepPart> {
  const part: SweepPart = { scanned: 0, found: 0, unchecked: [] };
  let repos: AutoMergeRepo[];
  try {
    repos = await deps.repos();
  } catch (err) {
    return { ...part, failed: `列受管的仓没成：${errMessage(err)}` };
  }
  /** 这轮扫到的开着的 PR 的提醒键：不再开着的（合了、关了）撤掉那条提醒。 */
  const seen = new Set<string>();
  for (const repo of repos) {
    const slug = `${repo.owner}/${repo.name}`;
    let pulls: PrAutoMergeCandidate[];
    try {
      pulls = await deps.gh.listPrs(repo);
    } catch (err) {
      part.unchecked.push(`${slug}：读开着的 PR 没成：${errMessage(err)}`);
      continue;
    }
    if (pulls.length > SCAN_LIMIT) {
      part.unchecked.push(
        `${slug}：开着的 PR 有 ${pulls.length} 张，超过一次能看的 ${SCAN_LIMIT}，这一轮不查这个仓`,
      );
      continue;
    }
    for (const pr of pulls) {
      seen.add(alertKey(repo, pr.number));
      try {
        await judgeOne(deps, repo, pr, part);
      } catch (err) {
        await reportFailure(deps, repo, pr.number, errMessage(err), part);
      }
    }
  }
  // 不再开着的（合了、关了）：撤掉那条提醒
  let open: { dedupeKey: string }[];
  try {
    open = await deps.autoMergeAlerts.listOpenByPrefix(AUTO_MERGE_ALERT_PREFIX);
  } catch (err) {
    part.unchecked.push(`列没处理的提醒没成，自动合并那部分的旧提醒这一轮不撤：${errMessage(err)}`);
    return part;
  }
  for (const alert of open) {
    if (seen.has(alert.dedupeKey)) continue;
    try {
      await deps.autoMergeAlerts.resolve({
        dedupeKey: alert.dedupeKey,
        by: RECONCILE_ACTOR,
        why: '这张 PR 不再开在我们受管的仓里、或这一轮没扫到它，这条提醒撤了',
      });
    } catch (err) {
      part.unchecked.push(`提醒 ${alert.dedupeKey} 撤不掉：${errMessage(err)}`);
    }
  }
  return part;
}
