// #227：CHANGELOG.md → 版本号、正文、tag 名、milestone 名、飞书消息，发布合并后那一步「记一版」的核心逻辑。
// 核心解析（splitChangelog、UNRELEASED_HEADING、nextVersion、today、ChangelogSplit、Version）已挪到
// packages/shared/src/changelog.ts，本文件只做再导出。CLI 那一侧的状态机（FinalizeState、nextState、planFinalize）、
// 状态文件名（FINALIZE_DIR、stateFileName）、飞书正文（feishuBody、releaseBody、namesFor）还留在这里。
// 这份状态机被 .github/workflows/release.yml 一步步「合法顺序」用（打 tag → 建 release → 关 milestone → 推飞书）；
// release.yml 自己的「事实」判定（tag、release 在不在、body 对不对、 milestone 开没开）不按这份状态文件走。
// 「业务那一侧（bin/changelog-release.ts）、root 那一侧（deploy/bin/finalize-release.sh）」这两个文件名是上一稿方案
// 留下的、现在并不存在：当时想要一份本机 CLI 加一份 root 机器脚本，重做成 #593（发布 vN 的 PR 合并由 GitHub Actions
// 收尾，0011 第 4 条）之后这两个都不再要——所以本注释里不再点它们的名。
// 测试在 packages/conventions/test/release-notes.test.ts。
// 改这里之前必须知道：
// - CHANGELOG.md 的格式钉死了（Unreleased 标题、版本标题的样子见 shared/changelog.ts 里的注释）：识别不到模样就报错，不宽容。
// - 同一个提交幂等：tag 名、release 名、milestone 名、飞书头之一是重复的话就当「做过了」，不暗示第二次。

export {
  type ChangelogSplit,
  nextVersion,
  splitChangelog,
  today,
  UNRELEASED_HEADING,
  type Version,
} from '@fleet-dao/shared';

/** 打 tag、建 release、关 milestone、飞书都用这一个号同一名字：v<N>。 */
export interface ReleaseName {
  tag: string;
  releaseTitle: string;
  milestoneTitle: string;
  feishuTitle: string;
}
export function namesFor(version: string): ReleaseName {
  return {
    tag: version,
    releaseTitle: version,
    milestoneTitle: version,
    feishuTitle: version,
  };
}

/** 草稿 → 正文：就是 Unreleased 那一段，原封不动贴过去（保持「从 CHANGELOG.md 读」不让人手写一遍；飞书消息正文里加一句地址）。 */
export function releaseBody(section: string): string {
  if (section.trim().length === 0) throw new Error(`Unreleased 段是空的，没东西可发`);
  return section;
}

/** 飞书消息正文（带仓地址，提示回驾驶舱页/CHANGELOG.md 看完整）。 */
export function feishuBody(version: string, section: string, changelogUrl: string): string {
  return `${version} 上线了。\n\n${section}\n\n— ${changelogUrl}`;
}

/** 状态文件的名字：发布合并进主线以后 root 那一侧每过一版写一份。 */
export const FINALIZE_DIR = '.finalize';
export const stateFileName = (sha: string) => `${sha}.json`;

/** 状态：pending → tagging → tagged → release-created → milestone-closed → notified；{ schema: 1 } 防仓里的旧格式。 */
export type FinalizeState =
  | { schema: 1; kind: 'pending' }
  | { schema: 1; kind: 'tagging' }
  | { schema: 1; kind: 'tagged'; tagCreated: boolean }
  | { schema: 1; kind: 'release-created'; tagCreated: boolean; releaseCreated: boolean }
  | {
      schema: 1;
      kind: 'milestone-closed';
      tagCreated: boolean;
      releaseCreated: boolean;
      milestoneClosed: boolean;
    }
  | {
      schema: 1;
      kind: 'notified';
      tagCreated: boolean;
      releaseCreated: boolean;
      milestoneClosed: boolean;
      feishuSent: boolean;
    };

export const INITIAL_STATE: FinalizeState = { schema: 1, kind: 'pending' };

export function nextState(
  s: FinalizeState,
  step: 'tagged' | 'release-created' | 'milestone-closed' | 'notified',
): FinalizeState {
  if (step === 'tagged') return { schema: 1, kind: 'tagged', tagCreated: true };
  if (step === 'release-created') {
    if (s.kind === 'pending' || s.kind === 'tagging')
      throw new Error(`建 release 之前要先打 tag（现在在「${s.kind}」）`);
    return { schema: 1, kind: 'release-created', tagCreated: true, releaseCreated: true };
  }
  if (step === 'milestone-closed') {
    if (s.kind !== 'release-created')
      throw new Error(`关 milestone 之前要先建 release（现在在「${s.kind}」）`);
    return {
      schema: 1,
      kind: 'milestone-closed',
      tagCreated: true,
      releaseCreated: true,
      milestoneClosed: true,
    };
  }
  if (s.kind !== 'milestone-closed') throw new Error(`推飞书之前要先关 milestone（现在在「${s.kind}」）`);
  return {
    schema: 1,
    kind: 'notified',
    tagCreated: true,
    releaseCreated: true,
    milestoneClosed: true,
    feishuSent: true,
  };
}

/**
 * 看现在该干哪一步。每一判定都用证伪的方式：tag/release 在 GitHub 上查得到、且模样对（tag 名、正文对照对、开的是那个版本）；
 * 只有本侧的状态文件少到才用。照「从外到里、以外为准」写这个判定——发布合并后那一步自己的状态文件能丢失/代理品类能跑错，GitHub 上不能。
 */
export function planFinalize(opts: {
  state: FinalizeState;
  tagExists: boolean;
  releaseExists: boolean;
  releaseBodyMatches: boolean;
  milestoneOpen: boolean;
}): { tag: boolean; release: boolean; closeMilestone: boolean; notify: boolean } {
  const { state, tagExists, releaseExists, releaseBodyMatches, milestoneOpen } = opts;
  return {
    tag: !tagExists,
    release: tagExists && (!releaseExists || (releaseExists && !releaseBodyMatches)),
    closeMilestone: tagExists && releaseExists && releaseBodyMatches && milestoneOpen,
    notify: tagExists && releaseExists && releaseBodyMatches && !milestoneOpen && state.kind !== 'notified',
  };
}
