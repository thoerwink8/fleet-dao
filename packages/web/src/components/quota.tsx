// 额度页的窗口怎么写（#3509 照 Arco 重做，#3533）：一个窗口一行，列是 窗口 / 用量（进度条 + 来源）/ 清零 / 状态；
// 说明（读法、上游原话、按时间该用到、先用它 / 快用完 / 读数过期的话）收在展开行里。
// 改这里之前必须知道：
// - 用量没读到（undefined）只画「没读到」的空槽，不画成 0%；上游说满了却没给比例，条画满、写「已用满」。
// - 读数过期的窗：条不变色（旧数不当现值），不喊「快用完」「先用它」。
import { type QuotaPace, quotaPace } from '@fleet-dao/shared';
import type { QuotaWindowView } from '../api/types';
import {
  formatUtil,
  isNearlyExhausted,
  isUpstreamFull,
  isUseItOrLoseIt,
  upstreamStatusLabel,
  utilOf,
  windowRawNote,
  windowTitle,
} from '../lib/catalog';
import { formatAgo, formatCount, formatIn, formatPercent, formatUsd } from '../lib/format';
import { readFail } from '../lib/read';
import { Descriptions } from './layout/descriptions';
import { Progress } from './layout/progress';
import { Stack } from './layout/stack';
import { StatusBadge } from './layout/status-badge';
import { Text } from './layout/text';

/** 实读是上游读到的，时间写「读」；估算没有上游读取，按本机用量算，时间写「算」。 */
export function readingVerb(reading: QuotaWindowView['reading']): '读' | '算' {
  return reading === 'measured' ? '读' : '算';
}

/** 每个额度数字都要标明来源：实读（接口读到的）还是估算（按我们自己的用量算的），悬停看读法（reclaude-carpool……）。 */
export function ReadingBadge({ w }: { w: QuotaWindowView }) {
  const measured = w.reading === 'measured';
  // 读数过期（#1748）：旧数不能挂「实读」的牌子，换成「读数过期」
  if (w.stale) {
    return (
      <span
        title={`${measured ? '从官方或网页接口读到的' : '按我们自己的用量估的'}，但读数太旧，不是现值（读法 ${w.source}）`}
        data-source={w.source}
        data-stale-badge="true"
      >
        <StatusBadge status="quota:quota:stale" />
      </span>
    );
  }
  return (
    <span
      title={`${measured ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}（读法 ${w.source}）`}
      data-source={w.source}
    >
      <StatusBadge status={measured ? 'quota:quota:measured' : 'quota:quota:estimated'} variant="dot" />
    </span>
  );
}

/** 按单位写数：美元、百分比、token、点数。 */
export function amount(w: Pick<QuotaWindowView, 'unit'>, n: number): string {
  switch (w.unit) {
    case 'usd':
      return formatUsd(n);
    case 'percent':
      return `${Math.round(n)}%`;
    case 'tokens':
      return formatCount(n);
    case 'points':
      return formatCount(n);
  }
}

/**
 * 同一行的已用 / 上限：token、点数用同一个单位、同一位小数（都用「万」或都用整数），
 * 避免各自 formatCount 混成「8,623.515 / 50.0 万」。
 */
export function amountPair(w: Pick<QuotaWindowView, 'unit'>, used: number, limit: number): string {
  if (w.unit === 'usd') return `${formatUsd(used)} / ${formatUsd(limit)}`;
  if (w.unit === 'percent') return `${Math.round(used)}% / ${Math.round(limit)}%`;
  const scale = Math.max(Math.abs(used), Math.abs(limit));
  if (scale < 10_000) {
    return `${formatCount(used)} / ${formatCount(limit)}`;
  }
  if (scale < 100_000_000) {
    return `${(used / 10_000).toFixed(1)} 万 / ${(limit / 10_000).toFixed(1)} 万`;
  }
  return `${(used / 100_000_000).toFixed(1)} 亿 / ${(limit / 100_000_000).toFixed(1)} 亿`;
}

/** 一句话的用量：「已用满」「$3.20 / $10.00」「40%」「已用 812，上限没读到」「用量没读到」。 */
export function quotaValue(w: QuotaWindowView): string {
  const util = utilOf(w);
  // 上游说已用满以它为准，排在数字前面说；有比例就顺带写上。
  if (isUpstreamFull(w)) return util === undefined ? '已用满' : `已用满 · ${formatPercent(util)}`;
  if (w.used !== undefined && w.limit !== undefined) return amountPair(w, w.used, w.limit);
  if (util !== undefined) return formatPercent(util);
  if (w.used !== undefined) return `已用 ${amount(w, w.used)}，上限没读到`;
  return '用量没读到';
}

/** 清零时刻已过，或上游这次没再报：算过期的旧读数。 */
export function isExpiredWindow(w: Pick<QuotaWindowView, 'staleSince' | 'resetsAt'>, now: number): boolean {
  if (w.staleSince) return true;
  if (w.resetsAt && Date.parse(w.resetsAt) <= now) return true;
  return false;
}

/** 同一个窗口类型里新旧两张时，过期那张收成一行灰字，不占一行。 */
export function ExpiredQuotaLine() {
  return (
    <span data-expired="true">
      <Text size="meta" tone="muted">
        旧读数，已过期
      </Text>
    </span>
  );
}

/**
 * 这个窗口的消耗进度（#2363，和选路同一份算法 shared 的 quotaPace）：读数过期、上游没报、用量或清零时刻没读到时算不出，返回 undefined。
 */
export function paceOf(w: QuotaWindowView, now: number): QuotaPace | undefined {
  if (w.stale || w.staleSince) return undefined;
  return (
    quotaPace({ window: w.window, label: w.label, used: utilOf(w), resetsAt: w.resetsAt }, now) ?? undefined
  );
}

/** 「按时间该用 62%，实际 75%」；窗口长度推不出、按 30 天估的补「（按 30 天估）」。 */
export function paceText(p: QuotaPace): string {
  return `按时间该用 ${formatPercent(p.elapsed)}，实际 ${formatPercent(p.used)}${p.estimated ? '（按 30 天估）' : ''}`;
}

/** 一个窗口的几个判断，条、状态、说明共用一份。 */
export function windowFacts(w: QuotaWindowView, now: number) {
  const util = utilOf(w);
  // 过期的读数不能当现值：不据此喊「先用它」。用量没读到的也不喊。
  const hot = !w.stale && isUseItOrLoseIt(w, now);
  const full = isNearlyExhausted(w);
  // 上游说满了、却没给比例（Claude 撞限额时就这样）：照「已用满」写，条画满，不算「用量没读到」。
  const upstreamFull = isUpstreamFull(w);
  const known = util !== undefined || upstreamFull;
  const pair =
    w.used !== undefined && w.limit !== undefined ? amountPair(w, w.used, w.limit).split(' / ') : null;
  const pace = paceOf(w, now);
  return { util, hot, full, upstreamFull, known, pair, pace };
}

/** 这个窗口要多说的话（先用它、快用完、上游状态、读数过期、不参与排序……）：展开行和悬停提示用。 */
export function windowNotes(w: QuotaWindowView, now: number): string[] {
  const { util, hot, full, known } = windowFacts(w, now);
  return [
    hot && util !== undefined ? `快清零还剩 ${formatPercent(1 - util)}，先用它` : null,
    full ? '快用完了，调度会先绕开' : null,
    w.upstreamStatus && w.upstreamStatus !== 'allowed' ? upstreamStatusLabel[w.upstreamStatus] : null,
    w.stale
      ? `读数过期，是 ${formatAgo(w.readAt, now)}${readingVerb(w.reading)}到的旧数，不是现值，不参与排序`
      : null,
    w.staleSince ? `上游从 ${formatAgo(w.staleSince, now)}起没再报这个窗，数是之前的，不参与排序` : null,
    !known && !w.staleSince ? '不参与「先用它」和排序' : null,
    w.reading === 'measured' ? null : '按本机用量估算',
  ].filter((n): n is string => n !== null);
}

/** 表里「用量」那一格：进度条（竖线是按时间该用到哪）加来源和读数多久前的。 */
export function QuotaUsage({ w, now }: { w: QuotaWindowView; now: number }) {
  const { util, hot, full, upstreamFull, known, pair, pace } = windowFacts(w, now);
  const percent = util !== undefined ? util * 100 : upstreamFull ? 100 : undefined;
  // 条右边的字：金额窗写「已用 / 上限 · 百分比」，其余照 quotaValue
  const label =
    pair && util !== undefined && w.unit !== 'percent'
      ? `${quotaValue(w)} · ${formatUtil(util)}`
      : percent !== undefined && !pair
        ? quotaValue(w)
        : undefined;
  const mark = pace && w.window !== '5h' ? pace.elapsed * 100 : undefined;
  return (
    <div
      data-quota-line
      data-hot={hot || undefined}
      data-full={full || undefined}
      data-stale={w.stale || undefined}
      data-unknown={!known || undefined}
      title={[...windowNotes(w, now), `${formatAgo(w.readAt, now)}${readingVerb(w.reading)}`].join('；')}
    >
      <Stack gap="sm">
        <Progress
          percent={percent === undefined ? readFail('用量没读到') : percent}
          {...(w.stale ? { thresholds: {} } : {})}
          {...(mark !== undefined ? { mark } : {})}
          {...(label !== undefined ? { label } : {})}
        />
        {percent === undefined && w.used !== undefined ? (
          <Text size="meta" tone="secondary">
            {quotaValue(w)}
          </Text>
        ) : null}
        <Stack direction="horizontal" gap="sm" align="center">
          <ReadingBadge w={w} />
          <Text size="meta" tone="muted">
            {formatAgo(w.readAt, now)}
            {readingVerb(w.reading)}
          </Text>
        </Stack>
      </Stack>
    </div>
  );
}

/** 清零那一格。 */
export function QuotaReset({ w, now }: { w: QuotaWindowView; now: number }) {
  const { hot } = windowFacts(w, now);
  if (!w.resetsAt) {
    return (
      <Text size="meta" tone="muted">
        清零时间没读到
      </Text>
    );
  }
  return (
    <Text strong={hot}>
      <span className="num">{formatIn(w.resetsAt, now)}</span>
    </Text>
  );
}

/** 展开行：读法、上游原话、按时间该用到、窗口原名，加上这个窗口要多说的话。 */
export function QuotaDetail({ w, now }: { w: QuotaWindowView; now: number }) {
  const { pace } = windowFacts(w, now);
  const notes = windowNotes(w, now);
  const behind = pace !== undefined && w.window !== '5h' && pace.behind <= -0.1;
  const measured = w.reading === 'measured';
  return (
    <div data-quota-notes>
      <Descriptions
        columns={2}
        items={[
          {
            label: '读法',
            value: `${measured ? '实读' : '估算'}，${formatAgo(w.readAt, now)}${readingVerb(w.reading)}到的；读法：${w.source}（${measured ? '从官方或网页接口读到的' : '读不到，按我们自己的用量估的'}）`,
          },
          {
            label: '上游原话',
            value:
              w.statusRaw && w.upstreamStatus && w.upstreamStatus !== 'allowed'
                ? w.statusRaw
                : '上游没有另说',
          },
          {
            label: '按时间该用到',
            value: pace ? (
              <Stack gap="sm">
                <span data-quota-pace data-behind={behind || undefined}>
                  <Text tone={behind ? 'warning' : 'default'}>{paceText(pace)}</Text>
                </span>
                {w.window !== '5h' ? (
                  <Text size="meta" tone="muted">
                    同一模型的几个渠道里，用得比时间慢 10% 以上的调度先用，快 10% 以上的往后放
                  </Text>
                ) : null}
              </Stack>
            ) : (
              '算不出（读数过期、上游没报，或用量、清零时间没读到）'
            ),
          },
          { label: '窗口原名', value: windowRawNote(w).replace('上游原名：', ''), mono: true },
          ...(notes.length > 0
            ? [
                {
                  label: '说明',
                  value: (
                    <Stack gap="sm">
                      {notes.map((n) => (
                        <Text key={n}>{n}</Text>
                      ))}
                    </Stack>
                  ),
                },
              ]
            : []),
        ]}
      />
    </div>
  );
}

/**
 * 一个窗口的整张说明（用量、条、清零、来源、全部说明合在一起，不分列）。额度页的表按列拆开画（QuotaUsage、QuotaReset、QuotaDetail），
 * 这里留着给只要一个窗口的地方用，和表里同一份判断。
 */
export function QuotaCell({ w, now }: { w: QuotaWindowView; now: number }) {
  const { util, hot, full, upstreamFull, known, pair } = windowFacts(w, now);
  const notes = windowNotes(w, now);
  return (
    <div
      data-hot={hot || undefined}
      data-full={full || undefined}
      data-stale={w.stale || undefined}
      data-unknown={!known || undefined}
    >
      <Stack gap="sm">
        {/* 表头已经写了是哪种窗：只在多出信息（按模型组、上游自报的窗名）时才再写一遍 */}
        {w.scope || w.window === 'other' ? (
          <Text size="meta" tone="muted" title={windowRawNote(w)}>
            {windowTitle(w)}
          </Text>
        ) : null}
        <Stack direction="horizontal" gap="sm" align="baseline" wrap justify="between">
          {pair ? (
            <span className="num">
              <Text strong tone={full ? 'danger' : w.stale ? 'muted' : 'default'}>
                {pair[0]}
              </Text>
              <Text size="meta" tone="muted">
                {' '}
                / {pair[1]}
              </Text>
            </span>
          ) : util !== undefined ? (
            <span className="num">
              <Text strong tone={full ? 'danger' : w.stale ? 'muted' : 'default'}>
                {formatPercent(util)}
              </Text>
            </span>
          ) : upstreamFull ? (
            <Text strong tone="danger">
              已用满
            </Text>
          ) : w.used !== undefined ? (
            <span className="num">
              <Text strong>{amount(w, w.used)}</Text>
              <Text size="meta" tone="muted">
                {' '}
                已用，上限没读到
              </Text>
            </span>
          ) : (
            <Text strong tone="warning">
              用量没读到
            </Text>
          )}
          <Stack direction="horizontal" gap="sm" align="center">
            {w.used !== undefined && util !== undefined ? (
              <Text size="meta" tone="muted">
                {formatUtil(util)}
              </Text>
            ) : null}
            <ReadingBadge w={w} />
          </Stack>
        </Stack>
        <Progress
          percent={util !== undefined ? util * 100 : upstreamFull ? 100 : readFail('用量没读到')}
          {...(w.stale ? { thresholds: {} } : {})}
        />
        <Stack direction="horizontal" gap="sm" justify="between" wrap>
          {w.resetsAt ? (
            <Text size="meta" tone={hot ? 'default' : 'muted'} strong={hot}>
              <span className="num">{formatIn(w.resetsAt, now)}</span>清零
            </Text>
          ) : (
            <Text size="meta" tone="muted">
              清零时间没读到
            </Text>
          )}
          <Text size="meta" tone={w.stale ? 'warning' : 'muted'}>
            {w.reading === 'measured' ? null : <span>按本机用量估算 · </span>}
            <span
              data-tone={w.stale ? 'stall' : undefined}
              title={w.stale ? '读数太旧，不能当现值用' : undefined}
            >
              <span className="num">{formatAgo(w.readAt, now)}</span>
            </span>
            {readingVerb(w.reading)}
          </Text>
        </Stack>
        {w.stale ? (
          <span data-stale-note>
            <Text size="meta" tone="warning" strong>
              读数过期，上面是 <span className="num">{formatAgo(w.readAt, now)}</span>
              {readingVerb(w.reading)}到的旧数，不是现值，不参与排序
            </Text>
          </span>
        ) : null}
        {notes
          .filter((n) => !n.startsWith('读数过期') && n !== '按本机用量估算')
          .map((n) => (
            <Text key={n} size="meta" tone={full && n.startsWith('快用完') ? 'danger' : 'secondary'}>
              {n}
            </Text>
          ))}
      </Stack>
    </div>
  );
}
