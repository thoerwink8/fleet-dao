// 工作台「数据概览」（#3509，样稿 Main.dc.html 第一块）：一排指标，只有额度和本期估算两格，不带图标。
// 本期估算读不到写「没记」，不写 $0（0 会让人以为这期没花钱）；额度没查成写「没查成」。
// 额度不是「正常」时，下面多一行灰字写是哪几个池的事。数字只在异常时上色。
import { formatUsd } from '../../lib/format';
import { Stack } from '../layout/stack';
import { Stat, StatGrid } from '../layout/stat';
import { Text } from '../layout/text';
import type { LayoutTone } from '../layout/tone';
import type { HomeHealth, HomeSpend } from './types';

const QUOTA_WORD: Record<HomeHealth['quota']['state'], string> = {
  ok: '正常',
  tight: '紧',
  empty: '没有',
  unknown: '没查成',
};

/** 额度这格的颜色：正常照正文色，紧、没查成橙，没有红。 */
const QUOTA_TONE: Record<HomeHealth['quota']['state'], LayoutTone | undefined> = {
  ok: undefined,
  tight: 'stall',
  empty: 'fail',
  unknown: 'stall',
};

/** 本期估算的那一个数。没给、读不到都是「没记」。 */
export function spendMoney(spend: HomeSpend | undefined): string {
  if (!spend || spend.estimated.state === 'unread') return '没记';
  return formatUsd(spend.estimated.usd);
}

export function Overview({ quota, spend }: { quota: HomeHealth['quota']; spend: HomeSpend | undefined }) {
  const money = spendMoney(spend);
  const why = spend?.estimated.state === 'unread' ? spend.estimated.why : undefined;
  return (
    <Stack gap="md">
      <div data-spend-line>
        <StatGrid cols={2}>
          <Stat label="额度" value={QUOTA_WORD[quota.state]} tone={QUOTA_TONE[quota.state]} />
          <Stat
            label="本期估算"
            value={
              <span data-spend-money title={why}>
                {money}
              </span>
            }
          />
        </StatGrid>
      </div>
      {quota.state !== 'ok' && quota.detail ? (
        <Text size="meta" tone="muted">
          额度：{quota.detail}
        </Text>
      ) : null}
    </Stack>
  );
}
