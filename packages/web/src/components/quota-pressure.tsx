// 额度页「作废预估」（#2737）：每个池一行（池名写「编号（渠道）」，窗口写中文名、原名在悬停里），按时间该用多少、实际用了多少、池压力 ρ、照现速清零时预计剩多少。
// 数是后端算好的（shared 的 quotaPressure，取这个池清零时预计剩得最多的窗口，5 小时窗不算），这里只画表。
// 算不出（没读到、读数过期）写「没读到」和原因，不写 0；后端没带这一项（老后端）整块不画。
import type { PoolView } from '../api/types';
import { poolTitle, windowTitle } from '../lib/catalog';
import { formatIn, formatPercent } from '../lib/format';
import { Section } from './layout/section';
import { Table, type TableColumn } from './layout/table';
import { Text } from './layout/text';

type Pressure = NonNullable<PoolView['pressure']>;
interface Row {
  pool: PoolView;
  pressure: Pressure;
}

/** 池那一格：编号在前、渠道在括号里（上面的表按渠道分组写的是「渠道 · 编号」）。 */
function poolCell(pool: PoolView): string {
  return `${pool.id}（${pool.channelName}）`;
}

/** 窗口中文名（和上面的表同一份 windowTitle）；这个池里找不到那个原名就照原名写。 */
function windowName(pool: PoolView, label: string): string {
  const w = pool.windows.find((x) => x.label === label);
  return w ? windowTitle(w) : label;
}

/** ρ 写两位小数；没法除（清零时刻就在眼前）写「—」并说明。 */
function rhoText(rho: number | null): string {
  return rho === null ? '—' : rho.toFixed(2);
}

/** 清零时预计剩多少：会提前用完的写「提前 N 小时用完」。 */
function leftText(p: Extract<Pressure, { state: 'known' }>): string {
  if (p.exhaustedHoursEarly !== null) return `剩 0 · 提前 ${Math.round(p.exhaustedHoursEarly)} 小时用完`;
  return formatPercent(p.leftAtReset);
}

/** 算不出的行：整行写「没读到（原因）」，别的格子是「—」。 */
function unknownText(r: Row): string | null {
  return r.pressure.state === 'unknown' ? `没读到（${r.pressure.why}）` : null;
}

export function QuotaPressure({ pools, now }: { pools: readonly PoolView[]; now: number }) {
  const rows: Row[] = pools.flatMap((pool) => (pool.pressure ? [{ pool, pressure: pool.pressure }] : []));
  if (rows.length === 0) return null;
  const known = (r: Row) => (r.pressure.state === 'known' ? r.pressure : null);
  const columns: TableColumn<Row>[] = [
    {
      key: 'pool',
      title: '池',
      render: (_v, r) => (
        <span data-pressure-pool={r.pool.id} data-pressure={r.pressure.state} title={poolTitle(r.pool)}>
          {poolCell(r.pool)}
        </span>
      ),
    },
    {
      key: 'window',
      title: '窗口',
      render: (_v, r) => {
        const p = known(r);
        if (!p) {
          return (
            <span title={r.pressure.state === 'unknown' ? r.pressure.why : undefined}>
              <Text tone="muted">{unknownText(r)}</Text>
            </span>
          );
        }
        return (
          <span data-pressure-col="window" title={`上游原名：${p.label}`}>
            {`${windowName(r.pool, p.label)} · ${formatIn(p.resetsAt, now)}清零`}
          </span>
        );
      },
    },
    {
      key: 'expected',
      title: '该用',
      render: (_v, r) => {
        const p = known(r);
        return p ? <span data-pressure-col="expected">{formatPercent(p.expectedUsed)}</span> : '—';
      },
    },
    {
      key: 'used',
      title: '实际用了',
      render: (_v, r) => {
        const p = known(r);
        return p ? <span data-pressure-col="used">{formatPercent(p.used)}</span> : '—';
      },
    },
    {
      key: 'rho',
      title: 'ρ',
      render: (_v, r) => {
        const p = known(r);
        return p ? <span data-pressure-col="rho">{rhoText(p.rho)}</span> : '—';
      },
    },
    {
      key: 'left',
      title: '清零时预计剩',
      render: (_v, r) => {
        const p = known(r);
        if (!p) return '—';
        const waste = p.leftAtReset >= 0.3;
        return (
          <span
            data-pressure-col="left"
            data-waste={waste || undefined}
            title={p.rateFrom === 'samples' ? '按最近 24 小时的读数算的速度' : '历史不够，按本期平均速度算'}
          >
            <Text tone={waste ? 'warning' : 'default'}>{leftText(p)}</Text>
          </span>
        );
      },
    },
  ];
  return (
    <Section
      title="作废预估"
      description="ρ = 剩余比例 ÷ 剩余时间比例：大于 1 照时间均匀用也用不完，清零时会作废；小于 1 会提前用完。速度按最近 24 小时的读数算，不够按本期平均。"
      flush
    >
      <div data-quota-pressure>
        <Table caption="作废预估" columns={columns} rows={rows} rowKey={(r) => r.pool.id} />
      </div>
    </Section>
  );
}
