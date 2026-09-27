// 「认领对得上」（#348，specs/299-帅位只一个/方案.md「认领对得上」）：引擎机器人在每个开着的 PR 当前头上贴 commit status，
// 合并闸（@fleet-dao/conventions 的 merge-gate）认它。判法在 core 的 judgeClaimMatch；PR 挂了哪张单、正文写的认领号用
// conventions 的 linkedIssue、prClaimId（和合并闸同一份认法）；读写 GitHub 经 @fleet-dao/github 的 ClaimsGitHub（引擎机器人）。
// 三处调它：PR 事件（webhook、补收、重放都走 issue-intake.ts 的 handle）；认领变了的命令（seat-cli.ts 的 claim、cli.ts 的
// handover）；每轮 GitHub 对账（reconcile.ts：作废过了宽限期没心跳的本机认领，所有开着的 PR 重判一遍，作废的撤自动合并、留言）。
// 改这里之前必须知道：
// - 判的结果和头上现有的（引擎贴的最新一条）一样就不再贴：每个提交每个 context 最多存 1000 条。
// - 贴不上、读不到一律抛或记进 problems，不当成贴上了；对账那一轮有没处理成的报提醒，下一轮再做（这里不记账，每轮从头判）。
// - 作废、改派只动这份认领自己的、挂着这张单的 PR（core 的 pullOfClaim），别人的不碰；关 PR 不删分支。

import { ENGINE_BOT_LOGIN, linkedIssue, prClaimId } from '@fleet-dao/conventions';
import {
  CLAIM_STATUS_CONTEXT,
  type ClaimMatch,
  claimOwnerText,
  type IssueClaim,
  judgeClaimMatch,
  pullOfClaim,
} from '@fleet-dao/core';
import type { ClaimsGitHub, PullFacts } from '@fleet-dao/github';
import type { IngestedEvent, Logger, Store } from './ports.ts';

/** 认领这一侧认的仓：库里的编号（查认领）加 GitHub 上的名字。 */
export interface ClaimRepo {
  id: string;
  owner: string;
  name: string;
}

export interface ClaimAlerts {
  raise(key: string, title: string, body: string): Promise<void>;
  resolve(key: string, why: string): Promise<void>;
}

export interface ClaimStatusDeps {
  store: Pick<Store, 'findRepoByName' | 'getClaim' | 'listRepos' | 'voidExpiredClaims'>;
  github: ClaimsGitHub;
  /** 对账那一轮有没处理成的报「要人看」提醒、好了撤（后端进程里没有就只记进结果）。 */
  alerts?: ClaimAlerts | undefined;
  log: Logger;
}

/** 一张单的认领变了、重贴挂着它的开着的 PR：看了几个、贴了哪几个、哪几个没贴成。 */
export interface ClaimRefresh {
  checked: number;
  posted: number[];
  problems: string[];
}

export interface ClaimSweepReport {
  /** 这一轮作废的认领。 */
  voided: IssueClaim[];
  /** 查全了几个仓（开着的 PR 都列出来了）。 */
  reposScanned: number;
  reposTotal: number;
  /** 判了几个开着的 PR。 */
  checked: number;
  /** 贴了几条（判的和头上现有的不一样才贴）。 */
  posted: number;
  /** 撤了自动合并的 PR（owner/仓#号）。 */
  disabled: string[];
  /** 这一轮新留的评论条数。 */
  commented: number;
  problems: string[];
}

export interface ReassignCloseReport {
  /** 关掉的旧 PR。 */
  closed: number[];
  problems: string[];
}

export interface ClaimStatus {
  /** PR 事件（开了、推了新提交、改了正文、重开、补收）：现读这个 PR，判、和头上现有的比，不一样才贴。别的事件回 undefined。 */
  onPullEvent(event: IngestedEvent): Promise<string | undefined>;
  /** 一张单的认领变了：这个仓开着的、挂着这张单的 PR 都重判重贴。 */
  refreshIssue(repo: ClaimRepo, issueNumber: number): Promise<ClaimRefresh>;
  /** 每轮对账：作废过了宽限期没心跳的本机认领，所有受管的仓开着的 PR 判一遍；作废的认领的 PR 先撤自动合并，再贴红、留言。 */
  sweep(): Promise<ClaimSweepReport>;
  /** 强制改派：旧认领自己的 PR 撤自动合并、关掉（分支不动）、留言指向新主，再重贴这张单别的 PR。 */
  closeForReassign(
    repo: ClaimRepo,
    old: IssueClaim,
    input: { to: string; founder: string },
  ): Promise<ReassignCloseReport>;
}

/** 这几种 PR 事件会改判：开了、推了新提交、改了正文（挂的单、认领号）、重开、草稿转正、补收拼的那种。 */
const PULL_ACTIONS = new Set([
  'opened',
  'reopened',
  'synchronize',
  'edited',
  'ready_for_review',
  'converted_to_draft',
  'synced',
]);

/** 对账那一轮的提醒（一条，好了撤）。 */
export const CLAIM_STATUS_ALERT_KEY = 'claim-status:sweep';

/** 一轮最多作废几张（多的下一轮再来）。 */
const VOID_BATCH = 200;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const ref = (repo: ClaimRepo) => ({ owner: repo.owner, name: repo.name });
const slugOf = (repo: ClaimRepo) => `${repo.owner}/${repo.name}`;

export function voidComment(claim: IssueClaim): string {
  return [
    `认领作废了：#${claim.issueNumber} 的认领（${claimOwnerText(claim)}，认领 ${claim.claimId.slice(0, 8)}）过了宽限期（${claim.graceMinutes} 分钟）没心跳，库里已作废。这个 PR 的自动合并撤了，「${CLAIM_STATUS_CONTEXT}」是红的，合不进去。`,
    '要接着做：找帅位重新认领这张单，把新认领号写进正文「认领」栏（分支留着，接着用）；不做了就关掉这个 PR。',
  ].join('\n\n');
}

export function reassignComment(to: string, founder: string): string {
  return `这张单改派给 ${to}（创始人原话：${founder}）；分支留着，新主接着用。这个 PR 关了、自动合并撤了。`;
}

export function createClaimStatus(deps: ClaimStatusDeps): ClaimStatus {
  const { store, github, log } = deps;

  /** 合并闸只认 ENGINE_BOT_LOGIN 贴的：身份对不上，贴了也白贴，明确报错。 */
  function assertEngineLogin(): void {
    const login = github.engineLogin();
    if (login !== ENGINE_BOT_LOGIN)
      throw new Error(
        `引擎机器人是 ${login}，合并闸只认 ${ENGINE_BOT_LOGIN} 贴的「${CLAIM_STATUS_CONTEXT}」：贴了也不算，先把两边对上（packages/conventions/src/merge-gates.ts）`,
      );
  }

  async function judge(
    repo: ClaimRepo,
    pull: PullFacts,
  ): Promise<{ issue: number | undefined; claim: IssueClaim | null; verdict: ClaimMatch }> {
    const issue = linkedIssue(pull.body, pull.title);
    const claim = issue === undefined ? null : (await store.getClaim(repo.id, issue)).claim;
    const verdict = judgeClaimMatch({
      issueNumber: issue,
      claim,
      byAgentBot: github.isAgentBot(pull.author),
      prNumber: pull.number,
      prClaimId: prClaimId(pull.body),
    });
    return { issue, claim, verdict };
  }

  /** 判的和头上现有的（引擎贴的最新一条）不一样才贴；贴了回 true。 */
  async function post(
    repo: ClaimRepo,
    pull: PullFacts,
    issue: number | undefined,
    verdict: ClaimMatch,
  ): Promise<boolean> {
    assertEngineLogin();
    const cur = await github.latestStatus(ref(repo), pull.headSha, CLAIM_STATUS_CONTEXT);
    if (cur?.byEngine && cur.state === verdict.state && cur.description === verdict.description) return false;
    await github.setStatus(ref(repo), pull.headSha, {
      context: CLAIM_STATUS_CONTEXT,
      state: verdict.state,
      description: verdict.description,
      targetUrl:
        issue === undefined ? undefined : `https://github.com/${repo.owner}/${repo.name}/issues/${issue}`,
    });
    return true;
  }

  async function repoOf(slug: string): Promise<ClaimRepo> {
    const [owner = '', name = ''] = slug.split('/');
    const repo = await store.findRepoByName(owner, name);
    // 门口刚按受管的仓放进来：找不到就是这之间仓被删了，如实失败
    if (!repo) throw new Error(`仓 ${slug} 不在库里（门口还当它是受管的）`);
    return repo;
  }

  async function refreshIssue(repo: ClaimRepo, issueNumber: number): Promise<ClaimRefresh> {
    const pulls = (await github.openPulls(ref(repo))).filter(
      (p) => linkedIssue(p.body, p.title) === issueNumber,
    );
    const out: ClaimRefresh = { checked: pulls.length, posted: [], problems: [] };
    for (const pull of pulls) {
      try {
        const { issue, verdict } = await judge(repo, pull);
        if (await post(repo, pull, issue, verdict)) out.posted.push(pull.number);
      } catch (err) {
        out.problems.push(`#${pull.number}：${message(err)}`);
      }
    }
    return out;
  }

  return {
    async onPullEvent(event) {
      if (event.event !== 'pull_request') return undefined;
      if (!PULL_ACTIONS.has(event.action ?? '')) return `claim_status=skip_${event.action ?? 'none'}`;
      const n = (event.payload as { pull_request?: { number?: unknown } } | null)?.pull_request?.number;
      if (typeof n !== 'number') throw new Error('PR 事件里认不出 pull_request.number：「认领对得上」没判');
      const repo = await repoOf(event.repo);
      // 现读：重放、补收带的那份可能早过时了（正文、头都可能变过）
      const pull = await github.readPull(ref(repo), n);
      if (pull.state !== 'open') return 'claim_status=closed';
      const { issue, verdict } = await judge(repo, pull);
      const posted = await post(repo, pull, issue, verdict);
      return `claim_status=${posted ? verdict.state : 'same'}`;
    },

    refreshIssue,

    async sweep() {
      const report: ClaimSweepReport = {
        voided: [],
        reposScanned: 0,
        reposTotal: 0,
        checked: 0,
        posted: 0,
        disabled: [],
        commented: 0,
        problems: [],
      };
      report.voided = (await store.voidExpiredClaims({ limit: VOID_BATCH })).voided;
      const repos = await store.listRepos();
      report.reposTotal = repos.length;
      for (const repo of repos) {
        const slug = slugOf(repo);
        let pulls: PullFacts[];
        try {
          pulls = await github.openPulls(ref(repo));
        } catch (err) {
          report.problems.push(`${slug} 开着的 PR 没列出来：${message(err)}`);
          continue;
        }
        report.reposScanned += 1;
        for (const pull of pulls) {
          report.checked += 1;
          try {
            const { issue, claim, verdict } = await judge(repo, pull);
            const own =
              claim?.state === 'voided' &&
              pullOfClaim(claim, {
                number: pull.number,
                prClaimId: prClaimId(pull.body),
                byAgentBot: github.isAgentBot(pull.author),
              });
            // 作废的：先撤自动合并，再贴红、留一句（撤不成的这一轮记下、下一轮再撤）
            if (own && pull.autoMerge) {
              await github.disableAutoMerge(ref(repo), pull);
              report.disabled.push(`${slug}#${pull.number}`);
            }
            if (await post(repo, pull, issue, verdict)) report.posted += 1;
            if (own && claim) {
              const c = await github.commentPull(
                ref(repo),
                pull.number,
                `claim-voided:${claim.claimId}`,
                voidComment(claim),
              );
              if (c.created) report.commented += 1;
            }
          } catch (err) {
            report.problems.push(`${slug}#${pull.number}：${message(err)}`);
          }
        }
      }
      if (deps.alerts) {
        try {
          if (report.problems.length > 0) {
            await deps.alerts.raise(
              CLAIM_STATUS_ALERT_KEY,
              `「${CLAIM_STATUS_CONTEXT}」这一轮有 ${report.problems.length} 处没处理成`,
              [
                '作废认领后撤自动合并、贴红、留言，或者给开着的 PR 判、贴「认领对得上」，有没做成的；下一轮 GitHub 对账（每 15 分钟）再做，好了自己撤。',
                ...report.problems.slice(0, 10).map((p) => `- ${p}`),
                report.problems.length > 10 ? `- 另有 ${report.problems.length - 10} 处` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            );
          } else if (report.reposScanned === report.reposTotal) {
            await deps.alerts.resolve(CLAIM_STATUS_ALERT_KEY, '这一轮开着的 PR 都判完、贴好了');
          }
        } catch (err) {
          report.problems.push(`提醒没报成：${message(err)}`);
        }
      }
      if (report.voided.length > 0 || report.disabled.length > 0)
        log.info('认领作废、撤自动合并', {
          voided: report.voided.map((c) => `${c.repoId}#${c.issueNumber}`),
          disabled: report.disabled,
        });
      return report;
    },

    async closeForReassign(repo, old, input) {
      const out: ReassignCloseReport = { closed: [], problems: [] };
      let pulls: PullFacts[];
      try {
        pulls = await github.openPulls(ref(repo));
      } catch (err) {
        return { closed: [], problems: [`${slugOf(repo)} 开着的 PR 没列出来：${message(err)}`] };
      }
      for (const pull of pulls) {
        if (linkedIssue(pull.body, pull.title) !== old.issueNumber) continue;
        const mine = pullOfClaim(old, {
          number: pull.number,
          prClaimId: prClaimId(pull.body),
          byAgentBot: github.isAgentBot(pull.author),
        });
        if (!mine) continue;
        try {
          if (pull.autoMerge) await github.disableAutoMerge(ref(repo), pull);
          await github.commentPull(
            ref(repo),
            pull.number,
            `claim-reassigned:${old.claimId}`,
            reassignComment(input.to, input.founder),
          );
          await github.closePull(ref(repo), pull.number);
          out.closed.push(pull.number);
        } catch (err) {
          out.problems.push(`#${pull.number}：${message(err)}`);
        }
      }
      // 这张单别的开着的 PR（别人的）按新认领重判
      try {
        const r = await refreshIssue(repo, old.issueNumber);
        out.problems.push(...r.problems);
      } catch (err) {
        out.problems.push(`重贴 #${old.issueNumber} 别的 PR 没成：${message(err)}`);
      }
      return out;
    },
  };
}

/** 认领变了之后重贴那一句（命令行打给人看）。 */
export function refreshText(r: ClaimRefresh | { error: string }): string {
  if ('error' in r)
    return `PR 上的「${CLAIM_STATUS_CONTEXT}」没重贴成（${r.error}）：GitHub 对账每 15 分钟会补，补上之前合并闸按旧的算`;
  if (r.checked === 0) return `没有挂这张单的开着的 PR，「${CLAIM_STATUS_CONTEXT}」不用重贴`;
  const posted =
    r.posted.length > 0 ? `重贴了 ${r.posted.map((n) => `#${n}`).join('、')}` : '都和现在的一样，没重贴';
  const bad = r.problems.length > 0 ? `；没贴成：${r.problems.join('；')}（GitHub 对账每 15 分钟会补）` : '';
  return `挂这张单的开着的 PR ${r.checked} 个，「${CLAIM_STATUS_CONTEXT}」${posted}${bad}`;
}
