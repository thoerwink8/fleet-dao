import { LOCAL_LABEL } from '@fleet-dao/conventions';
import { type Db, findRepoPolicyByGithubId, findRepoProfile, raiseMergedReviewEvent } from '@fleet-dao/db';
import {
  createGitHub,
  createPolicyGitHub,
  listInstallationRepositories,
  type ReleaseFactsReader,
  type RepoRef,
  reviewMergeHold,
  type SelfCheckItem,
} from '@fleet-dao/github';
import { policyOrigin } from '@fleet-dao/shared';
import { type Logger, pgLedger, pgLocker } from '@fleet-dao/store';
import { createCiPolicyBridge, withPolicySource } from './ci-policy-bridge.ts';
import type { DecisionCommenter } from './decision-handoff.ts';
import type { Deps } from './deps.ts';
import { githubAppMissing } from './github.ts';
import type { LocalHoldPort } from './local-hold.ts';
import type { GitHubEventSink } from './ports.ts';
import { currentMilestoneOf, type RequestIssuePort } from './request-issue.ts';

/**
 * PR、CI 事件写镜像：@fleet-dao/github 的事件去处，要两个机器人的凭据（只在这里、启动时读一次）。读不到时后端照样起，
 * PR、CI 事件如实失败，健康检查的 github_events 报红（credentialsMissing）；补上凭据要重启后端。
 */
/** 机器人凭据没读到：发版卡读 GitHub 的每一样都如实抛这个原因（卡上各行写没查成 + 原因）。 */ function credentialsMissingFacts(
  why: string,
): ReleaseFactsReader {
  const fail = async (): Promise<never> => {
    throw new Error(`GitHub 机器人的凭据没读到（${why}）`);
  };
  return {
    mainlineHead: fail,
    commit: fail,
    mainCi: fail,
    compare: fail,
    lastMergedPull: fail,
    issueTitle: fail,
  };
}

export function githubMirror(
  db: Db,
  publicUrl: URL,
  log: Logger,
  development = false,
  makeGitHub: typeof createGitHub = createGitHub,
): {
  sink: GitHubEventSink;
  credentialsMissing?: () => Promise<void>;
  releaseFacts: ReleaseFactsReader;
  /** 「要你拍」拍完往进度单、任务单留言（#1915）；凭据没读到就没有，答案照存、回包写没接上。 */
  decisionCommenter?: DecisionCommenter;
  /** 诊断型验收条的单被继续、重做时交回本机（#3602）：留言 + 贴「本机做」；凭据没读到就没有。 */
  localHold?: LocalHoldPort;
  /** 重查 GitHub App。凭据没读到就没有，重查报「凭据没读到」。 */
  selfCheck?: (repos: RepoRef[]) => Promise<SelfCheckItem[]>;
  /** 提需求（#2060）开单、写回评论、读单子状态，都用「引擎」机器人；凭据没读到就没有，开单回 503，不假装开了。 */
  requestIssues?: RequestIssuePort;
  /** 导入列表：两个机器人的安装令牌。凭据没读到就没有，列表回「没接上」。 */
  installationRepos?: Deps['installationRepos'];
  ciPolicyBridge?: Deps['ciPolicyBridge'];
} {
  let gh: ReturnType<typeof createGitHub>;
  try {
    gh = makeGitHub({ ledger: pgLedger(db), locker: pgLocker(db, { log }), log });
  } catch (err) {
    log.error('GitHub 机器人的凭据没读到：PR、CI 事件写不进镜像', { error: String(err) });
    const missing = githubAppMissing(String(err));
    return {
      sink: missing.sink,
      credentialsMissing: missing.check,
      releaseFacts: credentialsMissingFacts(String(err)),
    };
  }
  let supportedOrigin = true;
  try {
    policyOrigin(publicUrl.origin);
  } catch (err) {
    // 凭据已成功装配；桥失败不得改报成凭据缺失。
    if (!development) throw new Error('CI 策略桥初始化失败', { cause: err });
    supportedOrigin = false;
    log.warn('开发环境未装配公开 CI 策略桥，策略读写返回 503', { error: String(err) });
  }
  const ciPolicyBridge = supportedOrigin
    ? createCiPolicyBridge({
        origin: publicUrl.origin,
        gh: createPolicyGitHub(gh.deps),
        log,
        locker: pgLocker(db, { log, strict: true }),
        find: (repo) => findRepoProfile(db, repo.owner, repo.name),
        findByGithubId: (id) => findRepoPolicyByGithubId(db, id),
      })
    : undefined;
  const sink = gh.eventSink(
    reviewMergeHold(gh.claims, log, async (note) => {
      await raiseMergedReviewEvent(db, note);
    }),
  );
  // 引擎等 CI 靠活动自己轮询（waitCi），不收按事件叫醒的信号：PR、CI 事件只写镜像。
  // 唯一的例外是正式评审要求改（#2991）：引擎任务 PR 挂着的自动合并当场撤掉，评审由引擎合并那一步现读、交给工人
  return {
    // 评审到时 PR 已合：留未送达的明账（驾驶舱报警）；写不成抛错，这条投递记成出错、按原文重放
    ...(ciPolicyBridge ? { ciPolicyBridge } : {}),
    sink: ciPolicyBridge ? withPolicySource(sink, ciPolicyBridge) : sink,
    releaseFacts: gh.releaseFacts,
    decisionCommenter: {
      async comment(input) {
        const got = await gh.commentIssue(input);
        return { url: got.url };
      },
    },
    localHold: async (input) => {
      await gh.commentIssue({
        repo: input.repo,
        issueNumber: input.issueNumber,
        key: input.key,
        body: input.comment,
      });
      await gh.addIssueLabel({ repo: input.repo, issueNumber: input.issueNumber, label: LOCAL_LABEL });
    },
    selfCheck: (repos) => gh.selfCheck(repos),
    installationRepos: {
      list: (role) => listInstallationRepositories(gh.client, role),
    },
    requestIssues: {
      // 不走发件箱，同步调（母单 #2047 方案第六节）；正文过卫生检查、幂等都在 @fleet-dao/github 的 openIssue / commentIssue 里
      async openIssue(input) {
        // 挂当前版本（#2683）：创始人开的进当前版本，不落未排期
        const milestone = await currentMilestoneOf(() => gh.readOpenMilestones({ repo: input.repo }));
        return gh.openIssue({ ...input, milestone });
      },
      async commentIssue(input) {
        return gh.commentIssue(input);
      },
      async readIssueState(input) {
        return gh.readIssueState(input);
      },
    },
  };
}
