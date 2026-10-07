// CHANGELOG.md → 版本号、正文、tag 名、milestone 名、飞书消息，发布合并后那一步「记一版」的核心解析。
// 仓里现在有三头用：
//   - packages/conventions/src/release-notes.ts、publish-actions.ts：发布那条线（发起 PR、tag、release、milestone、飞书、状态机），在这一份上再叠。
//   - packages/web/src/lib/changelog.ts：驾驶舱 /changelog 页拿它把仓根的 CHANGELOG.md 摆出来。
//   - packages/api/src/release-version.ts：驾驶舱后端拿已发的版本核「这一版」；已经有发布标记的号不当这一版。
// 改这里之前必须知道：
// - CHANGELOG.md 的格式钉死了（Unreleased 标题、版本标题的样子见本文件里的常量）：识别不到模样就报错，不宽容。
// - 同一个提交幂等：tag 名、release 名、milestone 名、飞书头之一是重复的话就当「做过了」，不暗示第二次。
// CLI 那一侧（状态机、计划下一步、飞书正文、状态文件名）在 packages/conventions/src/release-notes.ts；这里只放解析出来的核心。

export const UNRELEASED_HEADING = '## [Unreleased]';
const HEADING_LINE = /^## \[(v\d+)\] - (\d{4}-\d{2}-\d{2})\s*$/;

/** 占位词：一段正文里每一行都恰好是其中之一，这段就算「还没写」。 */
export const PLACEHOLDER_MARKS: readonly string[] = ['还没有', '没有内容', '无'];

/**
 * 这段正文是不是只剩占位：去掉空行后，每一行都恰好是一个占位词。只认整行——「加了无人值守推进」里带「无」、
 * 「补上以前还没有的收尾」里带「还没有」都是真内容（原先按「含不含」判，这两句都被当成空的，发起脚本就拒发）。
 * 空段不算占位（是不是空由调用方另判）。Unreleased 段（splitChangelog）和某一版正文（release.yml 建 release 前）同用这一份。
 */
export function isPlaceholderSection(section: string): boolean {
  const lines = section
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  return lines.length > 0 && lines.every((l) => PLACEHOLDER_MARKS.includes(l));
}

export type Version = { version: string; date: string };

export interface ChangelogSplit {
  /** Unreleased 后面那一段（拼正文用）。 */
  section: string;
  /**
   * 下一版收进「## [v<N>] - 日期」标题时用的日期（今天，UTC）。这里不给版本号：版本号取当前版本里程碑
   * （packages/conventions/src/publish-actions.ts 的 releaseVersion），里程碑和更新日志的版本号可以不连续
   * （v1、v2 是没写更新日志就关掉的里程碑）。原先这里还按「已发的最大版本 +1」猜一个，驾驶舱拿它显示，
   * 第一版叫成了 v1（#725）；别再从更新日志推版本号。
   */
  next: { date: string };
  /** 仓里已经记住的版本（拼「上一版」用）。 */
  released: Version[];
  /** Unreleased 是否有真内容（不是空、也不是只剩占位）。 */
  hasContent: boolean;
}

/**
 * Unreleased 段拿出最低层一行：空的有「什么也没有」、「还没有」等。
 * now 是「今天」的来源（默认读真钟，UTC）：要钉死日期的调用方（测试）自己给，别拿写死的日期去比真钟。
 */
export function splitChangelog(text: string, now: () => string = today): ChangelogSplit {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md 缺 ${UNRELEASED_HEADING}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = (lines[i] ?? '').trim();
    if (HEADING_LINE.test(line)) {
      end = i;
      break;
    }
    if (line.startsWith('## '))
      throw new Error(`CHANGELOG.md 里认不出的二级标题：「${line}」（版本标题应为 ## [v<N>] - YYYY-MM-DD）`);
  }
  const section = lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
  const released: Version[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const m = HEADING_LINE.exec((lines[i] ?? '').trim());
    if (m) released.push({ version: m[1] ?? '', date: m[2] ?? '' });
  }
  released.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.version < b.version ? 1 : -1));
  const hasContent = section.length > 0 && !isPlaceholderSection(section);
  return { section, next: { date: now() }, released, hasContent };
}

/** 日期只为「今天」，UTC（不拿机器本地时区，在 v1 收尾时想要走到 UTC 里真正的一天）。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}
