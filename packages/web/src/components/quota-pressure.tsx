// 额度页「作废预估」（#2737）：每个池一行（池名写「编号（渠道）」，窗口写中文名、原名在悬停里），按时间该用多少、实际用了多少、池压力 ρ、照现速清零时预计剩多少。
// 数是后端算好的（shared 的 quotaPressure，取这个池清零时预计剩得最多的窗口，5 小时窗不算），这里只画表。
// 算不出（没读到、读数过期）写「没读到」和原因，不写 0；后端没带这一项（老后端）整块不画。
import type { PoolView } from '../api/types';
import { poolTitle, windowTitle } from '../lib/catalog';
import { formatIn, formatPercent } from '../lib/format';
import { Section } from './layout/section';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';

/** 池那一格：编号在前、渠道在括号里（上面的矩阵按渠道分组写的是「渠道 · 编号」）。 */
function poolCell(pool: PoolView): string {
  return `${pool.id}（${pool.channelName}）`;
}

/** 窗口中文名（和矩阵同一份 windowTitle）；这个池里找不到那个原名就照原名写。 */
function windowName(pool: PoolView, label: string): string {
  const w = pool.windows.find((x) => x.label === label);
  return w ? windowTitle(w) : label;
}

const HEADS = ['池', '窗口', '该用', '实际用了', 'ρ', '清零时预计剩'] as const;
/** 窄屏只留池、ρ、清零时预计剩三列（最该看的两样不被横向滚到看不见），其余写进池名下一行灰字。 */
const NARROW_HIDDEN: ReadonlySet<string> = new Set(['窗口', '该用', '实际用了']);

/** ρ 写两位小数；没法除（清零时刻就在眼前）写「—」并说明。 */
function rhoText(rho: number | null): string {
  return rho === null ? '—' : rho.toFixed(2);
}

/** 清零时预计剩多少：会提前用完的写「提前 N 小时用完」。 */
function leftText(p: Extract<NonNullable<PoolView['pressure']>, { state: 'known' }>): string {
  if (p.exhaustedHoursEarly !== null) return `剩 0 · 提前 ${Math.round(p.exhaustedHoursEarly)} 小时用完`;
  return formatPercent(p.leftAtReset);
}

export function QuotaPressure({ pools, now }: { pools: readonly PoolView[]; now: number }) {
  const rows = pools.filter((p) => p.pressure !== undefined);
  if (rows.length === 0) return null;
  return (
    <Section
      title="作废预估"
      description="ρ = 剩余比例 ÷ 剩余时间比例：大于 1 照时间均匀用也用不完，清零时会作废；小于 1 会提前用完。速度按最近 24 小时的读数算，不够按本期平均。"
      flush
    >
      <Table aria-label="作废预估" data-quota-pressure>
        <TableHeader>
          <TableRow>
            {HEADS.map((name) => (
              <TableHead key={name} className={NARROW_HIDDEN.has(name) ? 'max-md:hidden' : undefined}>
                {name}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((pool) => {
            const p = pool.pressure;
            if (!p) return null;
            if (p.state === 'unknown') {
              return (
                <TableRow key={pool.id} data-pressure-pool={pool.id} data-pressure="unknown">
                  <TableCell title={poolTitle(pool)}>{poolCell(pool)}</TableCell>
                  <TableCell
                    colSpan={HEADS.length - 1}
                    className="whitespace-normal text-muted-foreground"
                    title={p.why}
                  >
                    没读到（{p.why}）
                  </TableCell>
                </TableRow>
              );
            }
            const waste = p.leftAtReset >= 0.3;
            return (
              <TableRow key={pool.id} data-pressure-pool={pool.id} data-pressure="known">
                <TableCell title={poolTitle(pool)}>
                  {poolCell(pool)}
                  {/* 窄屏不留窗口、该用、实际用了三列：写成池名下一行灰字 */}
                  <div className="num whitespace-normal text-meta text-muted-foreground md:hidden">
                    {`${windowName(pool, p.label)} · ${formatIn(p.resetsAt, now)}清零 · 该用 ${formatPercent(p.expectedUsed)} · 实际 ${formatPercent(p.used)}`}
                  </div>
                </TableCell>
                <TableCell
                  className="num max-md:hidden"
                  title={`上游原名：${p.label}`}
                  data-pressure-col="window"
                >
                  {`${windowName(pool, p.label)} · ${formatIn(p.resetsAt, now)}清零`}
                </TableCell>
                <TableCell className="num max-md:hidden" data-pressure-col="expected">
                  {formatPercent(p.expectedUsed)}
                </TableCell>
                <TableCell className="num max-md:hidden" data-pressure-col="used">
                  {formatPercent(p.used)}
                </TableCell>
                <TableCell className="num" data-pressure-col="rho">
                  {rhoText(p.rho)}
                </TableCell>
                <TableCell
                  className={waste ? 'num whitespace-normal text-ink-stall' : 'num whitespace-normal'}
                  data-pressure-col="left"
                  title={
                    p.rateFrom === 'samples' ? '按最近 24 小时的读数算的速度' : '历史不够，按本期平均速度算'
                  }
                >
                  {leftText(p)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </Section>
  );
}
