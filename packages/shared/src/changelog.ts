// CHANGELOG.md → 版本号、正文、tag 名、milestone 名、飞书消息，发布合并后那一步「记一版」的核心解析。
// 仓里现在有两头用：
//   - packages/conventions/src/release-notes.ts：发布那条线（tag、release、milestone、飞书、状态机），在这一份上再叠。
//   - packages/web/src/lib/changelog.ts：驾驶舱 /changelog 页拿它把仓根的 CHANGELOG.md 摆出来。
// 改这里之前必须知道：
// - CHANGELOG.md 的格式钉死了（Unreleased 标题、版本标题的样子见本文件里的常量）：识别不到模样就报错，不宽容。
// - 同一个提交幂等：tag 名、release 名、milestone 名、飞书头之一是重复的话就当「做过了」，不暗示第二次。
// CLI 那一侧（状态机、计划下一步、飞书正文、状态文件名）在 packages/conventions/src/release-notes.ts；这里只放解析出来的核心。

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
  const last = released[0];
  const lastNum = last ? parseInt(last.version.slice(1), 10) : 0;
  const nextVersion = `v${lastNum + 1}`;
  const hasContent =
    section.length > 0 && !UNRELEASED_EMPTY_MARKS.some((mark) => section === mark || section.includes(mark));
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
