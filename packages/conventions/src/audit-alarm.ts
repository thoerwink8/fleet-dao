// 对账红了有人接（#2683）：GitHub 对账（github-audit.ts）没过就开（或更新）同一张「GitHub 对账没过」单，挂当前版本、贴「缺陷」「本机做」；
// 绿了自动关。从前 github-audit 定时那一轮连红 12 天没人看，红只在 Actions 页上，谁也不会去翻。
// 只认这一个标题：同名开着的有就改它的正文，不再开第二张；读不到开着的单就不开（不拿「没读到」当「没有」，免得开出一堆重复）。
import type { GitHubAlarmWriter, PlanIssue } from './github-api.ts';
import { LOCAL_LABEL } from './labels.ts';

export const ALARM_TITLE = 'GitHub 对账没过';
const ALARM_LABELS = ['缺陷', LOCAL_LABEL];

export interface AlarmInput {
  /** 这一轮红没红（有断裂或没查成）。 */
  red: boolean;
  /** 这一轮查出来的，一行一条（写进单的正文）。 */
  lines: readonly string[];
  /** 开着的单（同一轮对账读的那份）；没读到是 undefined。 */
  open: readonly PlanIssue[] | undefined;
  /** 当前版本的里程碑号；没有当前版本是 undefined（单照开，只是不挂）。 */
  milestone: number | undefined;
  /** 这一轮的 Actions 链接（有就写进正文）。 */
  runUrl: string | undefined;
  at: Date;
}

export type AlarmOutcome =
  | { action: 'opened' | 'updated' | 'closed'; issue: number }
  | { action: 'none' }
  | { action: 'failed'; why: string };

function body(input: AlarmInput): string {
  const at = new Date(input.at.getTime() + 8 * 3_600_000).toISOString();
  return [
    '## 场景',
    '',
    `GitHub 对账（\`.github/workflows/github-audit.yml\`）最近一轮（北京时间 ${at.slice(0, 10)} ${at.slice(11, 16)}）没过${input.runUrl ? `：${input.runUrl}` : ''}。每天这一轮红了就更新这张单，绿了自动关。`,
    '',
    '## 原话',
    '',
    '无（AI 发现）',
    '',
    '## 已知的模块',
    '',
    '- `packages/conventions/src/github-audit.ts`、`packages/conventions/src/version-cut.ts`',
    '',
    '## 怎么算做完',
    '',
    '- 下面每一条修好（或照它说的处理掉），下一轮对账绿了这张单自动关：',
    '',
    ...input.lines.slice(0, 60).map((l) => `  - ${l}`),
    ...(input.lines.length > 60 ? [`  - ……另有 ${input.lines.length - 60} 条，看 Actions 日志`] : []),
  ].join('\n');
}

export async function followAlarm(gh: GitHubAlarmWriter, input: AlarmInput): Promise<AlarmOutcome> {
  if (input.open === undefined)
    return { action: 'failed', why: '读不到开着的单，判不了「GitHub 对账没过」那张单开没开，这一轮没动它' };
  const [existing, ...dupes] = input.open
    .filter((i) => i.title === ALARM_TITLE && !i.isPr)
    .sort((a, b) => a.number - b.number);
  try {
    if (!input.red) {
      if (!existing) return { action: 'none' };
      const closing = `${existing.body ?? ''}\n\n北京时间 ${new Date(input.at.getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} 这一轮对账过了，自动关。`;
      await gh.closeIssueCompleted(existing.number, closing);
      for (const d of dupes) await gh.closeIssueCompleted(d.number, `${d.body ?? ''}\n\n对账过了，自动关。`);
      return { action: 'closed', issue: existing.number };
    }
    const text = body(input);
    if (existing) {
      await gh.updateIssueBody(existing.number, text);
      if (input.milestone !== undefined && existing.milestone === null) {
        await gh.setIssueMilestone(existing.number, input.milestone);
      }
      return { action: 'updated', issue: existing.number };
    }
    const n = await gh.createIssue(ALARM_TITLE, text, ALARM_LABELS);
    if (input.milestone !== undefined) await gh.setIssueMilestone(n, input.milestone);
    return { action: 'opened', issue: n };
  } catch (e) {
    return {
      action: 'failed',
      why: `「${ALARM_TITLE}」那张单没开成、没改成（${e instanceof Error ? e.message : String(e)}）`,
    };
  }
}
