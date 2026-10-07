// 驾驶舱 /changelog 页的来源：仓根 CHANGELOG.md 的全文。
// ?raw 由 vite 在打包时把文件内容内联成字符串，浏览器拿到的是 build 那一刻的版本。
// 格式解析走共享的 splitChangelog（packages/shared/src/changelog.ts），
// 和 packages/conventions/src/release-notes.ts 那份是同一个实现——发布那条线认不出模样的话这页一样认不出，
// 两条线的判定只能一起换。
import { type ChangelogSplit, splitChangelog } from '@fleet-dao/shared';
import changelogText from '../../../../CHANGELOG.md?raw';

/** 把仓根的 CHANGELOG.md 切出 Unreleased 段和已发布版本。解析失败就抛 —— 页面 LoadError 显示，不伪装成「还没发版」。 */
export function readChangelog(): ChangelogSplit {
  return splitChangelog(changelogText);
}

/**
 * 已发布那一版的正文（「## [v<N>] - 日期」到下一个二级标题之间）：页面上点一版看它发了什么。
 * 只在驾驶舱里用、只读；版本标题的认法和共享的 splitChangelog 一致（同一个 `## [v<N>] - YYYY-MM-DD` 写法）。
 * 找不到那一版就抛：页面写「没读成」，不拿空正文冒充「这一版什么都没发」。
 */
export function releasedBody(version: string, text: string = changelogText): string {
  const lines = text.split(/\r?\n/);
  const head = `## [${version}]`;
  const start = lines.findIndex((l) => l.trim().startsWith(head));
  if (start === -1) throw new Error(`CHANGELOG.md 里找不到 ${head} 这一版`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if ((lines[i] ?? '').startsWith('## ')) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}
