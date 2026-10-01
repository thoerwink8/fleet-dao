// #227：CHANGELOG.md → 版本号、正文、tag 名、milestone 名、飞书消息，发布合并后那一步「记一版」的核心逻辑。
// 业务那一侧（packages/conventions/src/bin/changelog-release.ts）、root 那一侧（deploy/bin/finalize-release.sh）都用这份。
// 测试在 packages/conventions/test/release-notes.test.ts；Persistence 测试在 packages/conventions/test/changelog-persistence.test.ts。
// 改这里之前必须知道：
// - CHANGELOG.md 的格式钉死了（Unreleased 标题、版本标题的样子见这个文件里的注释）：识别不到模样就报错，不宽容。
// - 同一个提交幂等：tag 名、release 名、milestone 名、飞书头之一是重复的话就当「做过了」，不暗示第二次。

export const UNRELEASED_HEADING = '## [Unreleased]';
const HEADING_LINE = /^## \[(v\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;

const UNRELEASED_EMPTY_MARKS = ['还没有', '没有内容', '无'];
export type Version = { version: string; date: string };

export interface ChangelogSplit {
  /** Unreleased 后面那一段（拼正文用）。 */
  section: string;
  /** 下一版本号：Unreleased 里没写 v1 的话，按 Union 里该有的版本号往下推下来。 */
  next: { version: string; date: string };
  /** 仓里已经记住的版本（拼「上一版」用）。 */
  released: Version[];
  /** Unreleased 是否有真内容（CI 检查那个用）。 */
  hasContent: boolean;
}

/** Unreleased 段拿出最低层一行：空的有「什么也没有」、「还没有」等。 */
export function splitChangelog(text: string): ChangelogSplit {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md 缺 ${UNRELEASED_HEADING}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i].trim());
    if (m) {
      end = i;
      break;
    }
    if (lines[i].startsWith('## ') && !HEADING_LINE.test(lines[i].trim()))
      throw new Error(`CHANGELOG.md 里认不出的二级标题：「${lines[i].trim()}」（版本标题应为 ## [v<N>] - YYYY-MM-DD）`);
  }
  const section = lines.slice(start + 1, end).join('\n').trim();
  const released: Version[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec(lines[i].trim());
    if (m) released.push({ version: m[1], date: m[2] });
  }
  released.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.version < b.version ? 1 : -1));
  const last = released[0];
  const lastNum = last ? parseInt(last.version.slice(1), 10) : 0;
  const nextVersion = `v${lastNum + 1}`;
  const hasContent =
    section.length > 0 &&
    !UNRELEASED_EMPTY_MARKS.some((mark) => section === mark || section.includes(mark));
  const date = today();
  return { section, next: { version: nextVersion, date }, released, hasContent };
}

/** 同一行的下一版本：v1 之后是 v2。 */
export function nextVersion(version: string): string {
  if (!/^v\d+$/.test(version)) throw new Error(`真的版本号模样认不出（应为 v<N>）：「${version}」`);
  return `v${parseInt(version.slice(1), 10) + 1}`;
}

/** 日期只为「今天」，UTC（不拿机器本地时区，在 v1 收尾时想要走到 UTC 里真正的一天）。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  | { schema: 1; kind: 'milestone-closed'; tagCreated: boolean; releaseCreated: boolean; milestoneClosed: boolean }
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
  if (step === 'tagged')
    return { schema: 1, kind: 'tagged', tagCreated: true };
  if (step === 'release-created') {
    if (s.kind === 'pending' || s.kind === 'tagging') throw new Error(`建 release 之前要先打 tag（现在在「${s.kind}」）`);
    return { schema: 1, kind: 'release-created', tagCreated: true, releaseCreated: true };
  }
  if (step === 'milestone-closed') {
    if (s.kind !== 'release-created') throw new Error(`关 milestone 之前要先建 release（现在在「${s.kind}」）`);
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
    notify:
      tagExists &&
      releaseExists &&
      releaseBodyMatches &&
      !milestoneOpen &&
      state.kind !== 'notified',
  };
}
