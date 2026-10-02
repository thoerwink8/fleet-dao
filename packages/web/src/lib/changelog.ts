// 驾驶舱 /changelog 页的来源：仓根 CHANGELOG.md 的全文。
// ?raw 由 vite 在打包时把文件内容内联成字符串，浏览器拿到的是 build 那一刻的版本。
// 格式解析走共享的 splitChangelog（packages/shared/src/changelog.ts），
// 和 packages/conventions/src/release-notes.ts 那份是同一个实现——发布那条线认不出模样的话这页一样认不出，
// 两条线的判定只能一起换。
// 演示版不进这一页（路由表不放、导航也不给 module），所以仓名不会被这一页带进演示版产物。
import { type ChangelogSplit, splitChangelog } from '@fleet-dao/shared';
import changelogText from '../../../../CHANGELOG.md?raw';

/** 把仓根的 CHANGELOG.md 切出 Unreleased 段和已发布版本。解析失败就抛 —— 页面 LoadError 显示，不伪装成「还没发版」。 */
export function readChangelog(): ChangelogSplit {
  return splitChangelog(changelogText);
}
