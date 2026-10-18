// 一版只记一处（#3110）：按完成的需求单写给使用者看，不把提交日志、排期和临时 AI 运营记录搬进产品条目。
// 分类按 Keep a Changelog：https://keepachangelog.com/en/1.1.0/ 。优先级：安全标签/标题 → 移除/弃用标签/标题 →
// 性质:bug 或缺陷 → 需求（perf/process 属于变更）→ 其余变更。标签缺失的旧单按类别兜底，不猜新标签。
import type { PlanIssue } from './github-api.ts';

export const CHANGELOG_FILE = 'CHANGELOG.md';
const GROUPS = ['新增', '变更', '修复', '移除/弃用', '安全'] as const;
type Group = (typeof GROUPS)[number];

export type ChangelogIssue = Pick<
  PlanIssue,
  'number' | 'title' | 'labels' | 'state' | 'stateReason' | 'isPr'
>;
export type ChangelogDeliveries =
  | { state: 'ok'; commits: readonly string[] }
  | { state: 'unavailable'; reason: string };

export interface ChangelogVersion {
  version: number;
  start: string;
  end: string;
  issues: readonly ChangelogIssue[];
  cutHead: string;
  deliveries: ChangelogDeliveries;
}

/** 标题是一行文字，不能注入 Markdown 标题、链接或换行。保留单号链接可追原需求。 */
function text(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\`*_{}[\]<>]/g, '\\$&')
    .trim();
}

function groupOf(issue: ChangelogIssue): Group {
  const has = (pattern: RegExp) => issue.labels.some((s) => pattern.test(s));
  if (has(/^(安全|security|性质:security)$/i) || /^(安全[：:]|修复安全|修补漏洞)/.test(issue.title))
    return '安全';
  if (has(/^(移除|弃用|removed|deprecated)$/i) || /^(移除|弃用|删除|退役|撤掉|去掉)/.test(issue.title))
    return '移除/弃用';
  if (issue.labels.includes('性质:bug') || issue.labels.includes('缺陷')) return '修复';
  if (issue.labels.includes('需求') && !issue.labels.some((s) => /^性质:(perf|process)$/.test(s)))
    return '新增';
  return '变更';
}

/** 显式运营类/个人工具调配不当产品功能发布；渠道/引擎本身的产品功能仍照常收。 */
function operational(issue: ChangelogIssue): boolean {
  return (
    issue.labels.some((s) => /^(AI运营|个人运营|临时运营)$/.test(s)) ||
    /^(?:临时[：:]?\s*)?(?:充值|切号|换号|换模型|调整额度|分配额度|开云会话|多开会话|派子代理|子代理派工)/.test(
      issue.title,
    )
  );
}

export function changelogAnchor(version: number): string {
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('版本号认不出');
  return `v${version}`;
}

export function renderChangelogVersion(input: ChangelogVersion): string {
  const anchor = changelogAnchor(input.version);
  for (const date of [input.start, input.end]) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date
    )
      throw new Error('版本起止日期认不出');
  }
  if (input.start > input.end) throw new Error('版本起止日期倒了');
  if (!/^[a-f0-9]{40}$/.test(input.cutHead)) throw new Error('收口时主线头不是完整提交号');
  const groups = new Map<Group, string[]>(GROUPS.map((g) => [g, []]));
  for (const issue of [...input.issues].sort((a, b) => a.number - b.number)) {
    if (issue.state !== 'closed' || issue.stateReason !== 'completed' || issue.isPr || operational(issue))
      continue;
    if (!issue.title.trim()) throw new Error(`#${issue.number} 没有可读标题`);
    groups.get(groupOf(issue))?.push(`- ${text(issue.title)}（#${issue.number}）`);
  }
  const lines = [`<a id="${anchor}"></a>`, `## [${anchor}] - ${input.start}～${input.end}`, ''];
  for (const group of GROUPS) {
    const entries = groups.get(group) ?? [];
    if (entries.length) lines.push(`### ${group}`, '', ...entries, '');
  }
  if ([...groups.values()].every((g) => g.length === 0))
    lines.push('这一版没有已完成的产品条目；未完成、不做、重复和临时运营记录不列入。', '');
  let delivered: string;
  if (input.deliveries.state === 'unavailable') {
    if (!input.deliveries.reason.trim()) throw new Error('交付物读不到却没有原因');
    delivered = `没查成：${text(input.deliveries.reason)}`;
  } else {
    if (input.deliveries.commits.some((sha) => !/^[a-f0-9]{40}$/.test(sha)))
      throw new Error('法国交付物不是完整提交号');
    delivered = input.deliveries.commits.length
      ? [...new Set(input.deliveries.commits)].map((sha) => `\`${sha}\``).join('、')
      : '发布历史已读全，这一版期间没有切换发布记录';
  }
  lines.push(
    '### 版本与交付物',
    '',
    `- 收口时主线头：\`${input.cutHead}\`。`,
    `- 发到法国的提交：${delivered}。`,
    '',
    '### 兼容性与升级',
    '',
    '- 版本是计划时间盒，部署仍按主线提交；具体兼容性和升级要求见上面各单，未逐项核验，不能据此认定没有破坏性变更。',
    '',
    '### 验证状态与已知限制',
    '',
    '- 条目依据 GitHub 的「完成」关单记录生成；关单和版本收口不代表法国现场验收通过，发布提交也不代表本版每个条目均已上线。',
  );
  return lines.join('\n');
}

/** 显式 HTML 锚点稳定；重跑替换同一节，其余版本/历史说明不动。重复版本先报错。 */
export function writeChangelogVersion(document: string, input: ChangelogVersion): string {
  const anchor = changelogAnchor(input.version);
  const rendered = renderChangelogVersion(input);
  const sections = [...document.matchAll(/^## \[v(\d+)\].*$/gm)];
  const same = sections.filter((s) => Number(s[1]) === input.version);
  if (same.length > 1) throw new Error(`${anchor} 在 CHANGELOG 重复，不能确定替哪一节`);
  if (same[0]?.index !== undefined) {
    const heading = same[0];
    const before = document.slice(0, heading.index);
    const marker = `<a id="${anchor}"></a>\n`;
    const start = before.endsWith(marker) ? heading.index - marker.length : heading.index;
    const restStart = heading.index + heading[0].length;
    const nextHeading = /^## /m.exec(document.slice(restStart));
    let end = nextHeading ? restStart + nextHeading.index : document.length;
    if (nextHeading) {
      const markerStart = document.lastIndexOf('<a id="', end);
      if (markerStart >= start && /^<a id="v\d+"><\/a>\n$/.test(document.slice(markerStart, end)))
        end = markerStart;
    }
    return `${`${document.slice(0, start)}${rendered}\n\n${document.slice(end)}`.trimEnd()}\n`;
  }
  const at = sections.find((s) => Number(s[1]) < input.version)?.index ?? document.length;
  const markerStart = document.lastIndexOf('<a id="', at);
  const insert =
    markerStart >= 0 && /^<a id="v\d+"><\/a>\n$/.test(document.slice(markerStart, at)) ? markerStart : at;
  return `${`${document.slice(0, insert).trimEnd()}\n\n${rendered}\n\n${document.slice(insert)}`.trimEnd()}\n`;
}

export function hasChangelogVersion(document: string, version: number): boolean {
  changelogAnchor(version);
  return new RegExp(`^## \\[v${version}\\](?: |$)`, 'm').test(document);
}
