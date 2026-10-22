import { Scale } from 'lucide-react';
import { brand } from '#brand';
import type { CarpoolReconcileView } from '../api/types';
import { formatClock } from '../lib/format';
import { Glyph } from './layout/glyph';
import { Section } from './layout/section';
import { Stack } from './layout/stack';
import { Text, type TextTone } from './layout/text';

export type CarpoolReconcileTone = 'muted' | 'ok' | 'stall';

export interface CarpoolReconcileSummary {
  tone: CarpoolReconcileTone;
  /** 一句话：这一窗本机记到花了多少、接口说用了多少，差多少、凭什么这么说（后端写好的 note）。 */
  headline: string;
  /** 小字：窗口从几点到几点、读数几点读的。 */
  detail?: string;
}

/**
 * 额度页上的拼车额度对账（#194 方案 4.7）：先只显示、不报警，所以最重也只是 stall 色（要看一眼），不是 fail。
 * 没法对（没读到、窗口已过、没接上）写明原因，不拿「对得上」冒充。
 */
export function carpoolReconcileSummary(v: CarpoolReconcileView): CarpoolReconcileSummary {
  if (v.state === 'unavailable')
    return { tone: 'muted', headline: `${brand.terms.carpool}额度对账看不到：${v.why}` };
  return {
    tone: v.verdict === 'match' ? 'ok' : 'stall',
    headline: v.note,
    detail: `这一窗 ${formatClock(v.windowStart)} 到 ${formatClock(v.windowEnd)}；接口读数 ${formatClock(v.apiReadAt)}，本机的花费只算到那一刻开始的会话，在跑的会话收场才记花费，所以本机的数略偏小`,
  };
}

const TEXT_TONE: Record<CarpoolReconcileTone, TextTone> = {
  muted: 'muted',
  ok: 'default',
  stall: 'warning',
};

/** 额度表顶上、切号现状下面的一栏（没有这项 = 老后端，不画）。 */
export function CarpoolReconcileBanner({ view }: { view: CarpoolReconcileView | undefined }) {
  if (!view) return null;
  const s = carpoolReconcileSummary(view);
  return (
    <Section
      {...(s.tone === 'stall' ? { tone: 'stall' as const } : {})}
      data-tone={s.tone}
      data-testid="carpool-reconcile"
    >
      <Stack direction="horizontal" gap="sm" align="start">
        <Glyph icon={Scale} tone={TEXT_TONE[s.tone]} />
        <Stack gap="sm">
          <Text strong tone={TEXT_TONE[s.tone]}>
            {s.headline}
          </Text>
          {s.detail ? (
            <Text as="p" size="meta" tone="muted">
              {s.detail}
            </Text>
          ) : null}
        </Stack>
      </Stack>
    </Section>
  );
}
