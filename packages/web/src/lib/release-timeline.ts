// 发版卡的文案（#2026）：最近一次点击的一句话、九步时间线每一步的样子、发后体检一句话、确认框里的预检清单。
// 纯函数，测试钉住每一种状态对应的字（packages/web/src/test/release-one-click-2026.test.tsx）。
import type { ReleaseCard } from '../api/types';
import { formatAgo, formatDuration } from './format';

type Last = ReleaseCard['action']['last'];
type Timeline = NonNullable<Last['timeline']>;
type Check = NonNullable<Last['check']>;

/** 九步的名字：和法国接活脚本 deploy/france/release-request/lib.mjs 的 PHASES 同一顺序。 */
export const RELEASE_PHASES = [
  '预检',
  '暂停本机',
  '暂停法国',
  '等收尾',
  '发版',
  '等部署',
  '验证',
  '恢复',
  '派清单',
] as const;

/** 进度记录里没写 waiting 时，这一步默认在干什么。 */
const STEP_DOING = [
  '记发版前异常基线',
  '本机暂停（法国上跳过）',
  '关法国引擎总开关、记下各仓接活开关',
  '等法国在跑的会话收尾',
  '跑 release.sh',
  '等法国在用的切到目标、跑 release.sh --check',
  '发后体检',
  '把引擎总开关恢复到发版前、核对开关',
  '收尾',
] as const;

export type StepState = 'done' | 'current' | 'blocked' | 'failed' | 'todo';

export interface StepRow {
  index: number;
  name: string;
  state: StepState;
  /** 这一步的一句话：用了多久、在等什么、卡在哪。 */
  text: string;
}

const since = (iso: string | null | undefined, now: number) =>
  iso ? formatDuration(now - Date.parse(iso)) : null;

/**
 * 九步时间线：走过的写「用了多久」，当前那步写在等什么、已用多久（卡住、没成写原因），没到的写「没到」。
 * 做完了（done）九步都算走过。
 */
export function stepRows(
  timeline: Timeline,
  status: Last['state'],
  why: string | null,
  now: number,
): StepRow[] {
  return RELEASE_PHASES.map((name, index) => {
    const at = timeline.steps[index] ?? null;
    const next = timeline.steps[index + 1] ?? null;
    const done = status === 'done' || index < timeline.phase;
    if (done) {
      const took = at && next ? formatDuration(Date.parse(next) - Date.parse(at)) : null;
      return { index, name, state: 'done', text: took ? `走过了 · 用了 ${took}` : '走过了' };
    }
    if (index > timeline.phase) return { index, name, state: 'todo', text: '没到' };
    const used = since(at, now);
    if (status === 'blocked') {
      const lag = timeline.laggards.length > 0 ? `（${timeline.laggards.join('、')}）` : '';
      return { index, name, state: 'blocked', text: `卡住了${lag}：${why ?? '没写原因'}` };
    }
    if (status === 'failed') return { index, name, state: 'failed', text: `没成：${why ?? '没写原因'}` };
    const doing = timeline.waiting ?? STEP_DOING[index] ?? '在走';
    return {
      index,
      name,
      state: 'current',
      text: `在等：${doing}${used ? ` · 这一步已用 ${used}` : ''}`,
    };
  });
}

/** 时间线头一行：第几步、一共用了多久。 */
export function timelineHead(timeline: Timeline, status: Last['state'], now: number): string {
  const total = since(timeline.startedAt, now);
  const step = `第 ${timeline.phase} 步「${RELEASE_PHASES[timeline.phase] ?? '?'}」`;
  if (status === 'done') return `九步都走完了${total ? `（从开始到现在 ${total}）` : ''}`;
  const word = status === 'blocked' ? '卡在' : status === 'failed' ? '停在' : '走到';
  return `${word}${step}${total ? ` · 一共已用 ${total}` : ''}`;
}

/** 发后体检一句话：「发后体检：通过」或「发后体检：没通过：A、B」。 */
export function checkLine(check: Check): { text: string; ok: boolean } {
  if (check.ok) return { text: '发后体检：通过', ok: true };
  const bad = check.items.filter((x) => !x.ok).map((x) => x.name);
  return { text: `发后体检：没通过：${bad.join('、') || '（没写哪几项）'}`, ok: false };
}

/**
 * 最近一次点击的结果一句话：读不到写没查成 + 原因，不当成没点过。
 * 做完了的说法和法国接活脚本实际做的一致：只恢复引擎总开关；各仓「让 AI 接活」开关发版不动，体检核对它们没被动过。
 */
export function lastLine(
  last: Last,
  now: number,
): { text: string; tone: 'ok' | 'warn' | 'fail' | 'plain' } | null {
  const when = last.at ? `（${formatAgo(last.at, now)}）` : '';
  switch (last.state) {
    case 'none':
      return null;
    case 'pending':
      return { text: '发布请求已提交，等法国接活（接活后这里显示进度）', tone: 'warn' };
    case 'refused':
      return { text: `上一次被法国拒了${when}：${last.why ?? '（没写原因）'}。现场没动`, tone: 'fail' };
    case 'running':
      return { text: `发版在走：${last.phase ?? ''} · ${last.target ?? ''}${when}`, tone: 'warn' };
    case 'blocked':
      return { text: `发版卡住了：${last.phase ?? ''}${when}。${last.why ?? ''}`, tone: 'warn' };
    case 'failed':
      return { text: `发版没成：${last.phase ?? ''}${when}。${last.why ?? ''}`, tone: 'fail' };
    case 'done':
      return {
        text: `上一趟发完了：${last.target ?? ''}${when}。引擎总开关已恢复到发版前（开着的开回、关着的保持关）；各仓接活开关发版不动`,
        tone: last.check && !last.check.ok ? 'warn' : 'ok',
      };
    case 'aborted':
      return { text: `上一趟被撤销了：${last.target ?? ''}${when}`, tone: 'plain' };
    case 'unreadable':
      return { text: `上一次的结果没查成：${last.why ?? ''}`, tone: 'warn' };
  }
}

export type PreflightKind = 'ok' | 'block' | 'info';

const KIND_OF: Record<string, PreflightKind> = { 通过: 'ok', 卡住: 'block', 读不到: 'block', 留意: 'info' };

/**
 * 预检输出（stdout）里一项一行的那几行（packages/api/src/france-preflight.ts 的 renderPreflight：「名字：等级 详情」，
 * 等级是 通过 / 卡住 / 留意 / 读不到，读不到算卡住）；老写法「[通过] 详情」也认。别的行（标题、结论）不要。
 */
export function preflightItems(stdout: string): { kind: PreflightKind; text: string }[] {
  const out: { kind: PreflightKind; text: string }[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    const old = /^\[(通过|卡住|留意)\]\s*(.*)$/.exec(line);
    if (old) {
      out.push({ kind: KIND_OF[old[1] ?? ''] ?? 'block', text: old[2] ?? '' });
      continue;
    }
    const m = /^([^：]+)：(通过|卡住|留意|读不到)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const level = m[2] ?? '';
    const detail = m[3] ?? '';
    out.push({
      kind: KIND_OF[level] ?? 'block',
      text: `${m[1]}：${level === '读不到' ? '读不到，' : ''}${detail}`,
    });
  }
  return out;
}
