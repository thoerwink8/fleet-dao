// 命令行表格：账号池 / 窗口 / 已用/上限 / 百分比 / 清零时间 / 实读或估算 / 来源 / 错误。
import type { PoolQuotaResult, QuotaReading, QuotaReport } from './types.ts';

const HEADERS = ['账号池', '窗口', '已用/上限', '百分比', '清零时间', '实读/估算', '来源', '错误'];

/** 终端里中日韩字符占两格。 */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const wide =
      (c >= 0x1100 && c <= 0x115f) ||
      (c >= 0x2e80 && c <= 0xa4cf) ||
      (c >= 0xac00 && c <= 0xd7a3) ||
      (c >= 0xf900 && c <= 0xfaff) ||
      (c >= 0xfe30 && c <= 0xfe4f) ||
      (c >= 0xff00 && c <= 0xff60) ||
      (c >= 0xffe0 && c <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

const pad = (s: string, width: number) => s + ' '.repeat(Math.max(0, width - displayWidth(s)));

function amount(v: number | undefined, unit: QuotaReading['unit']): string {
  if (v === undefined) return '—';
  if (unit === 'usd') return `$${v.toFixed(2)}`;
  if (unit === 'percent') return `${Number(v.toFixed(1))}%`;
  return `${Math.round(v).toLocaleString('en-US')} 点`;
}

const STATUS_TEXT: Record<string, string> = { warning: '告警', limit_reached: '已满' };

function percent(w: QuotaReading): string {
  const ratio =
    w.utilization ??
    (w.used !== undefined && w.limit !== undefined && w.limit > 0 ? w.used / w.limit : undefined);
  const base = ratio === undefined ? '—' : `${(ratio * 100).toFixed(1)}%`;
  if (w.upstreamStatus && STATUS_TEXT[w.upstreamStatus]) return `${base}（${STATUS_TEXT[w.upstreamStatus]}）`;
  if (!w.upstreamStatus && w.statusRaw) return `${base}（上游：${w.statusRaw}）`;
  return base;
}

function relative(ms: number): string {
  const abs = Math.abs(ms);
  const text =
    abs >= 86_400_000
      ? `${(abs / 86_400_000).toFixed(1)} 天`
      : abs >= 3_600_000
        ? `${(abs / 3_600_000).toFixed(1)} 小时`
        : `${Math.max(1, Math.round(abs / 60_000))} 分钟`;
  return ms >= 0 ? `${text}后` : `已过 ${text}`;
}

function resetText(iso: string | undefined, now: Date, timeZone?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const local = d.toLocaleString('zh-CN', {
    ...(timeZone ? { timeZone } : {}),
    hour12: false,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${local}（${relative(d.getTime() - now.getTime())}）`;
}

function windowName(w: QuotaReading): string {
  return w.scope ? `${w.label}（只扣 ${w.scope}）` : w.label;
}

function rowsOf(r: PoolQuotaResult, now: Date, timeZone?: string): string[][] {
  if (!r.ok) return [[r.poolId, '—', '—', '—', '—', '—', r.reader, `${r.error.code}：${r.error.message}`]];
  if (r.windows.length === 0) return [[r.poolId, '（上游说没有窗口）', '—', '—', '—', '—', r.reader, '']];
  return r.windows.map((w) => [
    r.poolId,
    windowName(w),
    `${amount(w.used, w.unit)} / ${amount(w.limit, w.unit)}`,
    percent(w),
    resetText(w.resetsAt, now, timeZone),
    w.reading === 'measured' ? '实读' : '估算',
    w.source,
    '',
  ]);
}

export function formatQuotaTable(
  report: QuotaReport,
  options: { now?: Date; timeZone?: string } = {},
): string {
  const now = options.now ?? new Date(report.finishedAt);
  const rows = report.results.flatMap((r) => rowsOf(r, now, options.timeZone));
  const widths = HEADERS.map((h, i) =>
    Math.max(displayWidth(h), ...rows.map((row) => displayWidth(row[i] ?? ''))),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  const out = [line(HEADERS), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)];

  const extra: string[] = [];
  for (const r of report.results) {
    const bits: string[] = [];
    if (r.ok && r.subscription) {
      const s = r.subscription;
      bits.push(
        `套餐 ${s.plan ?? '—'}${s.expiresAt ? `，付到 ${resetText(s.expiresAt, now, options.timeZone)}` : ''}`,
      );
    }
    bits.push(...r.notes);
    if (bits.length) extra.push(`${r.poolId}：${bits.join('；')}`);
  }
  if (extra.length) out.push('', '说明：', ...extra.map((s) => `  ${s}`));

  const ok = report.results.filter((r) => r.ok);
  const measured = ok.filter((r) => r.windows.some((w) => w.reading === 'measured')).length;
  const estimated = ok.filter(
    (r) => r.windows.length > 0 && r.windows.every((w) => w.reading === 'estimated'),
  ).length;
  const empty = ok.filter((r) => r.windows.length === 0).length;
  const failed = report.results.length - ok.length;
  const parts = [
    `实读 ${measured}`,
    `估算 ${estimated}`,
    ...(empty ? [`读到 0 个窗口 ${empty}`] : []),
    `没读成 ${failed}`,
  ];
  out.push('', `共 ${report.results.length} 个账号池：${parts.join('，')}。读取时刻 ${report.startedAt}`);
  return out.join('\n');
}
