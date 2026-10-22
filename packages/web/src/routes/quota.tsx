// 额度页（#3509 照 Arco 重做，#3533；样稿 canvas/Quota.dc.html）：页头一句说明，长说明和读法在 ⓘ；顶上一句结论
// （现在先用哪个池、哪个快用完）；下面一张账号池表，四个页签（全部 / 该先用 / 快用完 / 读数过期或没查成）把表筛一遍，带计数；再下面是作废预估。
// 改这里之前必须知道：
// - 读过一次、刷新失败：照旧画上一次的数，顶上一条带重试的橙提示条，不把看得到的清空；一次都没读成才整页只写没查成。
// - 暂停设置没查成、账号池的毛病没读成：照实写，不写成「没有毛病」；引擎对读不到的暂停按暂停办。
// - 页签的计数就是筛出来的行数，和表对得上；没读到的窗不当 0，读数过期的不参与「该先用」「快用完」。
import { errMessage } from '@fleet-dao/shared/util';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { brand } from '#brand';
import { errorText, usePools } from '../api/client';
import type { Pools } from '../api/types';
import { EmptyState } from '../components/layout/empty-state';
import { FilterTabs } from '../components/layout/filter-tabs';
import { LoadError, LoadingRows, LoadPartial, LoadStale } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Stack } from '../components/layout/stack';
import { Text } from '../components/layout/text';
import { usePoolProblems } from '../components/pool-problem';
import { PoolHoldBanner, PoolSwitchProvider } from '../components/pool-switch';
import { quotaValue } from '../components/quota';
import { buildRows, QuotaMatrix, type QuotaRow } from '../components/quota-matrix';
import { QuotaNotice } from '../components/quota-notice';
import { QuotaPressure } from '../components/quota-pressure';
import { poolTitle, utilOf, windowTitle } from '../lib/catalog';
import { formatAgo, formatIn, formatPercent } from '../lib/format';
import { useNow } from '../lib/hooks';

export function meta() {
  return [{ title: brand.title('额度') }];
}

const SUMMARY = '每个账号池、每个时间窗用了多少、几点清零。';
const DESCRIPTION = (
  <Stack gap="sm">
    <Text as="p">
      每个数都写明是实读还是估算。快清零还剩不少的会标「该先用」：调度会先用它；用了九成以上的标「快用完」，调度会先绕开。
    </Text>
    <Text as="p">
      每行展开后有「按时间该用到」：同一模型的几个渠道里，用得比时间慢一成以上的调度先用，快一成以上的往后放。条上的竖线就是按时间该用到哪。
    </Text>
    <Text as="p">
      实读：从官方接口或它自家网页的用量接口读到的。估算：读不到，按我们自己的用量算，撞到限额时记下上限。
    </Text>
    <Text as="p">
      读数过期：超过一段时间没读到新数，旧数不当现值用、不参与排序。没查成：一条都没读到，不是「没用量」。用量没读到：只读到了清零时间。
    </Text>
    <Text as="p">点每行左边的箭头，展开这一行的说明（读法、上游原话、读数新不新）。</Text>
    <Text as="p">
      每个池那一行的开关是停用：关掉只写一句原因，复查日期可不填。引擎探到封号或登录失效时，这一行写「封号」，开关不跟着动。
    </Text>
    <Text as="p">
      每个渠道的标题行右边有「全部暂停」「全部放开」：一次动这个渠道下所有池，同样要写原因。一部分池已停时变成「暂停其余」「放开已停」，各只动自己那一半；认不出的暂停和封号提醒不会被放开。
    </Text>
  </Stack>
);

type Filter = 'all' | 'first' | 'near' | 'stale';

/** 顶上的结论：现在先用哪个池的哪个窗；没有要抢着用的，就说哪个快用完；都没有就说够用。 */
function QuotaHero({ rows, now }: { rows: readonly QuotaRow[]; now: number }) {
  const hotRows = rows.flatMap((r) => (r.hot && r.w ? [{ r, w: r.w }] : []));
  const fullRows = rows.flatMap((r) => (r.full && r.w ? [{ r, w: r.w }] : []));
  const soonest = [...hotRows].sort(
    (a, b) => Date.parse(a.w.resetsAt ?? '') - Date.parse(b.w.resetsAt ?? ''),
  )[0];
  const firstFull = fullRows[0];
  let text: string;
  if (soonest) {
    const util = utilOf(soonest.w);
    const left = util === undefined ? '' : `还剩 ${formatPercent(1 - util)}`;
    const reset = soonest.w.resetsAt ? `${formatIn(soonest.w.resetsAt, now)}清零` : '清零时间没读到';
    text = `现在先用 ${poolTitle(soonest.r.pool)}：${windowTitle(soonest.w)}${left}，${reset}。`;
    if (firstFull) {
      text += `${poolTitle(firstFull.r.pool)} 的${windowTitle(firstFull.w)}快用完，调度会先绕开。`;
    }
  } else if (firstFull) {
    text = `${poolTitle(firstFull.r.pool)}：${windowTitle(firstFull.w)}${quotaValue(firstFull.w)}，调度会先绕开。`;
  } else {
    text = '都够用：没有快清零要抢着用的，也没有快用完的。';
  }
  return (
    <div data-quota-hero>
      <Notice tone="info">
        <span data-hero-line>{text}</span>
      </Notice>
    </div>
  );
}

function QuotaLoaded({
  data,
  error,
  refetch,
  dataUpdatedAt,
  now,
}: {
  data: Pools;
  error: unknown;
  refetch: () => void;
  dataUpdatedAt: number;
  now: number;
}) {
  const poolProblems = usePoolProblems();
  const [filter, setFilter] = useState<Filter>('all');
  const staleMinutes = data.staleAfterMinutes ?? 30;
  const problems = poolProblems.problems;
  const all = buildRows(data.pools, now, problems);
  const shown: Record<Filter, QuotaRow[]> = {
    all,
    first: all.filter((r) => r.hot),
    near: all.filter((r) => r.full),
    stale: all.filter((r) => r.stale),
  };
  return (
    <Stack gap="lg">
      {error ? (
        <LoadStale
          what="额度"
          error={error}
          when={formatAgo(new Date(dataUpdatedAt).toISOString(), now)}
          onRetry={refetch}
        />
      ) : null}
      {data.pools.length > 0 ? <QuotaHero rows={all} now={now} /> : null}
      {/* 切号现状、拼车对账：两项都没有就不占地方（QuotaNotice 自己判） */}
      <QuotaNotice orgSwitch={data.orgSwitch} reconcile={data.carpoolReconcile} />
      <PoolHoldBanner />
      {poolProblems.error ? (
        <div data-pool-problems="unreadable">
          <LoadPartial>
            账号池的毛病（额度读不到、凭据过期）没读成：{errorText(poolProblems.error)}。表里没写不代表没有。
          </LoadPartial>
        </div>
      ) : null}
      {data.pools.length === 0 ? (
        <Section>
          <EmptyState icon={Gauge} title="还没有账号池" />
        </Section>
      ) : (
        <Section title="账号池">
          <Stack gap="md">
            <div data-quota-summary>
              <FilterTabs
                aria-label="额度摘要"
                items={[
                  { id: 'all', label: '全部', count: shown.all.length },
                  { id: 'first', label: '该先用', count: shown.first.length },
                  { id: 'near', label: '快用完', count: shown.near.length },
                  { id: 'stale', label: '读数过期或没查成', count: shown.stale.length },
                ]}
                value={filter}
                onChange={setFilter}
              />
            </div>
            <PoolSwitchProvider>
              <QuotaMatrix rows={shown[filter]} pools={data.pools} now={now} problems={problems} />
            </PoolSwitchProvider>
            <Text size="meta" tone="muted" as="p">
              {`该先用：清零在窗长 20% 内且用量低于 70%。快用完：用量 90% 以上，或上游说已用满。超过 ${staleMinutes} 分钟没读到新数的不能当现值用，不参与判断；一条都没读到的是「没查成」，不是「没用量」；只读到清零时间的是「用量没读到」。没读到的不当 0。`}
            </Text>
          </Stack>
        </Section>
      )}
      {data.pools.length > 0 ? <QuotaPressure pools={data.pools} now={now} /> : null}
    </Stack>
  );
}

export default function Quota() {
  const q = usePools();
  const now = useNow();
  const { data, error, isLoading, refetch, isFetching, dataUpdatedAt } = q;
  const refresh = {
    onRefresh: () => void refetch(),
    isFetching,
    dataUpdatedAt,
    staleAfterMs: (data ? data.staleAfterMinutes : 30) * 60_000,
  };
  const page = { title: '额度', description: SUMMARY, detail: DESCRIPTION, refresh };

  // 一次都没读成：整页只写没查成和原因、带重试。读成过、刷新失败的在下面照旧画上一次的数，顶上一条提示条
  if (error && !data) {
    return (
      <Page {...page}>
        <LoadError text={`额度没查成：${errMessage(error)}`} error={error} onRetry={() => void refetch()} />
      </Page>
    );
  }
  return (
    <Page {...page}>
      {isLoading || !data ? (
        <LoadingRows rows={6} />
      ) : (
        <QuotaLoaded
          data={data}
          error={error}
          refetch={() => void refetch()}
          dataUpdatedAt={dataUpdatedAt}
          now={now}
        />
      )}
    </Page>
  );
}
