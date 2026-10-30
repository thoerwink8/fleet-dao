// 创始人引导的按周汇总（决定 0123，#3764）：仓里只留意思、不带原话。引导本身记在驾驶舱库（账本 directive 行），
// pnpm progress directive-digest [--week 2026-W44] [--write] 读整本账，把那一周（北京时间，周一到周日）的引导按时间列成一张表：
// 时间、类别、挂的单、意思。不带 --write 只打印；带 --write 写 docs/directive-digest/<周>.md（用普通 PR 提交，一周一个，别每条一个）。
// 原话不进输出：只取 meaning 字段；意思里整句含着原话（和原话不一样但把它抄进去了）的拒绝，不写进仓。
import { atDate, DirectiveRefused } from './directives.ts';
import type { LedgerDirective } from './ledger-read.ts';

export const DIGEST_DIR = 'docs/directive-digest';
const WEEK = /^(\d{4})-W(\d{2})$/;
const DAY_MS = 86_400_000;
/** 北京时间当天零点对应的“伪 UTC”毫秒：把时刻加 8 小时再用 UTC 读，免得依赖本机时区 */
const beijingDay = (d: Date): number => Math.floor((d.getTime() + 8 * 3_600_000) / DAY_MS) * DAY_MS;

/** 北京时间那天所在的 ISO 周，写成 2026-W44 */
export function isoWeekOf(d: Date): string {
  const day = new Date(beijingDay(d));
  // 周四所在的年就是 ISO 周的年
  const thursday = new Date(day.getTime() + (3 - ((day.getUTCDay() + 6) % 7)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 这一周的周一、周日（北京时间日期，YYYY-MM-DD）；周号不对拒绝 */
export function weekRange(week: string): { from: string; to: string } {
  const m = WEEK.exec(week);
  if (!m?.[1] || !m[2]) throw new DirectiveRefused(`--week ${week} 不对，要 2026-W44 这样的 ISO 周。`);
  const year = Number(m[1]);
  const w = Number(m[2]);
  if (w < 1 || w > 53) throw new DirectiveRefused(`--week ${week} 不对，周号要 01 到 53。`);
  // 1 月 4 日一定在第 1 周
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday1 = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * DAY_MS;
  const from = new Date(monday1 + (w - 1) * 7 * DAY_MS);
  if (isoWeekOf(from) !== week) throw new DirectiveRefused(`--week ${week} 这一年没有这一周。`);
  const to = new Date(from.getTime() + 6 * DAY_MS);
  const ymd = (x: Date) => x.toISOString().slice(0, 10);
  return { from: ymd(from), to: ymd(to) };
}

export const digestPath = (week: string): string => `${DIGEST_DIR}/${week}.md`;

/** 一条引导算哪一周：他说话的时刻（认得出就用），认不出用账本行落库时刻 */
export function directiveWeek(d: LedgerDirective): string {
  const spoken = d.spokenAt ? atDate(d.spokenAt) : null;
  return isoWeekOf(spoken ?? new Date(d.at));
}

const cell = (s: string) => s.replace(/\s+/g, ' ').replace(/\|/g, '／').trim();

/** 意思里把原话整句抄进去了（原话和意思不是同一句时才算；对外仓两者本来就相同） */
function copiesQuote(d: LedgerDirective): boolean {
  const q = d.text.trim();
  return q.length >= 6 && q !== d.meaning.trim() && d.meaning.includes(q);
}

/**
 * 那一周的汇总（Markdown）。没有意思的老行（还没有 meaning 字段）不列，数在末尾说明；有把原话抄进意思的直接拒绝。
 * 同样的账本总是出同样的字，重跑不会让文件变。
 */
export function renderDigest(week: string, all: readonly LedgerDirective[]): string {
  const { from, to } = weekRange(week);
  const mine = all.filter((d) => directiveWeek(d) === week).sort((a, b) => a.id - b.id);
  const leaked = mine.filter(copiesQuote);
  if (leaked.length > 0)
    throw new DirectiveRefused(
      `账本行 ${leaked.map((d) => d.id).join('、')} 的意思里含着原话，周汇总在公开仓，不写。先在驾驶舱库里改成转述再生成。`,
    );
  const shown = mine.filter((d) => d.meaning.trim());
  const skipped = mine.length - shown.length;
  const rows = shown.map((d) => {
    const when = (d.spokenAt || d.at).slice(0, 16).replace('T', ' ');
    return `| ${cell(when)} | ${cell(d.category || '—')} | #${d.issue} | ${cell(d.meaning)} |`;
  });
  return `${[
    `# 创始人引导周汇总 ${week}`,
    '',
    `- 周期：${from} 至 ${to}（北京时间）`,
    '- 来源：驾驶舱库（法国账本 directive 行）；只写意思，不带原话（决定 0123）',
    '- 生成：`pnpm progress directive-digest --week ' + week + ' --write`，别手改',
    `- 共 ${shown.length} 条${skipped > 0 ? `（另有 ${skipped} 条没有写意思，不列）` : ''}`,
    '',
    ...(rows.length > 0
      ? ['| 时间 | 类别 | 挂的单 | 意思 |', '|---|---|---|---|', ...rows]
      : ['这一周没有记引导。']),
  ].join('\n')}\n`;
}
