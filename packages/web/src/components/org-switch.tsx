import { ArrowLeftRight } from 'lucide-react';
import { brand } from '#brand';
import type { OrgSwitchView } from '../api/types';
import { formatClock } from '../lib/format';
import { cn } from '../lib/utils';

// 两类账号叫什么走品牌文件（brand.terms.carpool / solo）：演示版的包里不许出现正式版的内部叫法（src/build/scan.ts）。
const carpool = () => brand.terms.carpool;
const solo = () => brand.terms.solo;

/** 不同的拼车「用不了」的叫法（方案 v2 4.2）。 */
const outageName = (kind: 'E1' | 'E2' | 'E3'): string =>
  ({
    E1: `${carpool()}本人 5 小时额度用满`,
    E2: `${carpool()}整辆车的官方窗口被用光`,
    E3: `${carpool()}组织本身用不了`,
  })[kind];

export type OrgSwitchTone = 'muted' | 'ok' | 'stall' | 'fail';

export interface OrgSwitchSummary {
  tone: OrgSwitchTone;
  /** 顶上那一句。 */
  headline: string;
  /** 往下的几条小字（每条一件事）。 */
  details: string[];
}

/**
 * 额度页顶上的切号现状（#194，方案 v2 4.4）：一句话「挂着独享；拼车预计 HH:MM 恢复（来源：接口 / 被拒原文）」，
 * 渠道不可用、只剩 1 个账号、读不到账号状态、账本认不出这几种另说，都明说，不拿「没事」顶。
 */
export function orgSwitchSummary(v: OrgSwitchView): OrgSwitchSummary {
  const paused = v.soloPaused
    ? [
        `已点「引擎暂不用${solo()}」：${carpool()}用不了也不切${solo()}，Claude 的活等${carpool()}恢复或交给别家模型`,
      ]
    : [];
  if (v.state === 'unavailable') {
    return { tone: 'muted', headline: `切号现状看不到：${v.why}`, details: paused };
  }
  if (v.state === 'unreadable') {
    return { tone: 'fail', headline: v.why, details: paused };
  }
  const details: string[] = [];
  let tone: OrgSwitchTone = 'ok';
  const raise = (t: OrgSwitchTone) => {
    const order: OrgSwitchTone[] = ['muted', 'ok', 'stall', 'fail'];
    if (order.indexOf(t) > order.indexOf(tone)) tone = t;
  };
  let headline: string;
  if (v.live === null) {
    headline = '还没读到会话用户现在挂的是哪个组织';
    raise('stall');
  } else if (v.live === 'solo') {
    headline = `挂着${solo()}`;
    if (v.outage) {
      const when = v.outage.resetsAt
        ? `预计 ${formatClock(v.outage.resetsAt)} 恢复（来源：${v.outage.resetsFrom === 'api' ? '接口' : '被拒原文'}）`
        : '几点恢复不知道';
      headline += `；${outageName(v.outage.kind)}，${when}`;
      details.push(`凭什么：${v.outage.evidence}`);
    } else {
      headline += `；没有记着的${carpool()}恢复条件（多半是人手动切的）`;
    }
    if (v.backPendingSince) {
      details.push(
        `${carpool()}恢复了，切回的宽限中（${formatClock(v.backPendingSince)} 起）：新活先不往${solo()}派，在跑的收尾后切回`,
      );
    }
  } else {
    headline = `挂着${carpool()}`;
    if (v.outage) {
      headline += `；${outageName(v.outage.kind)}，正要切${solo()}`;
      details.push(`凭什么：${v.outage.evidence}`);
      raise('stall');
    }
  }
  if (v.channel) {
    if (v.channel.state === 'unavailable') {
      headline = `渠道不可用（${formatClock(v.channel.since)} 起）：没有一个可用账号；${headline}`;
      details.unshift(v.channel.why);
      raise('fail');
    } else if (v.channel.state === 'single') {
      details.unshift(`只剩 1 个可用账号，没得选：${v.channel.why}`);
      raise('stall');
    } else if (v.channel.state === 'unknown') {
      details.unshift(`读不到账号状态，不切号：${v.channel.why}`);
      raise('stall');
    }
  }
  if (v.whites > 0) {
    details.push(
      `切回${carpool()}后马上又被拒（白切）连着 ${v.whites} 次${v.whites >= 3 ? '，已不再自己切回，要人看' : ''}`,
    );
    raise(v.whites >= 3 ? 'fail' : 'stall');
  }
  if (v.lastRead && !v.lastRead.ok) {
    details.push(
      `最近一次读${carpool()}接口没成（${formatClock(v.lastRead.at)}）：${v.lastRead.why ?? '原因没写'}`,
    );
    raise('stall');
  }
  details.push(...paused);
  if (v.soloPaused) raise('stall');
  return { tone, headline, details };
}

const TONE_CLASS: Record<OrgSwitchTone, string> = {
  muted: 'text-muted-foreground',
  ok: 'text-foreground',
  stall: 'text-ink-stall',
  fail: 'text-ink-fail',
};

/** 额度表顶上的一栏：怎么切号的现状（没有这项 = 老后端，不画）。 */
export function OrgSwitchBanner({ view }: { view: OrgSwitchView | undefined }) {
  if (!view) return null;
  const s = orgSwitchSummary(view);
  return (
    <div className="mb-3 rounded-xl border bg-card p-3" data-tone={s.tone} data-testid="org-switch">
      <div className="flex items-center gap-2">
        <ArrowLeftRight className={cn('size-4 shrink-0', TONE_CLASS[s.tone])} aria-hidden />
        <span className={cn('text-sm font-medium', TONE_CLASS[s.tone])}>{s.headline}</span>
      </div>
      {s.details.length ? (
        <ul className="mt-1.5 space-y-0.5 pl-6 text-xs text-muted-foreground">
          {s.details.map((d) => (
            <li key={d}>{d}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
