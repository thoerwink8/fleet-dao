// 首页「额度和钱」一行（#2759）：额度怎样，加本期估算花了多少。
// 估算读不到写「没记」，不写 $0（0 会让人以为这期没花钱）。

import { formatUsd } from '../../lib/format';
import type { HomeHealth, HomeSpend } from './types';

const QUOTA_WORD: Record<HomeHealth['quota']['state'], string> = {
  ok: '正常',
  tight: '紧',
  empty: '没有',
  unknown: '没查成',
};

/** 本期估算的那一个数。没给、读不到都是「没记」。 */
export function spendMoney(spend: HomeSpend | undefined): string {
  if (!spend || spend.estimated.state === 'unread') return '没记';
  return formatUsd(spend.estimated.usd);
}

export function SpendLine({ quota, spend }: { quota: HomeHealth['quota']; spend: HomeSpend | undefined }) {
  const money = spendMoney(spend);
  return (
    <p data-spend-line className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-body">
      <span>
        额度 <span className="font-medium">{QUOTA_WORD[quota.state]}</span>
      </span>
      <span className="text-meta text-muted-foreground">{quota.detail}</span>
      <span>
        本期估算{' '}
        <span
          data-spend-money
          className="num font-medium"
          title={spend?.estimated.state === 'unread' ? spend.estimated.why : undefined}
        >
          {money}
        </span>
      </span>
    </p>
  );
}
