// 通知中心左边的列表（#3533，样稿 Inbox.dc.html 的 .pick 列表）：一条一行，标题一行、灰字一行（类型、多久前、谁处理的），
// 行尾是飞书没送到的红标签和处理到哪一步的状态点；按天分组；日报在「全部」里折成一行。选中的一行 brand-1 底。
import type { Me, Notification } from '../../api/types';
import { formatAgo } from '../../lib/format';
import { isMine, noticeLevelMeta } from '../../lib/status';
import { ListRow } from '../layout/list';
import { MetaLine } from '../layout/meta-line';
import { Stack } from '../layout/stack';
import { StatusBadge } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { hasUndelivered, stageStatus } from './notice-parts';

/** 按天分的组：今天、昨天、几月几日。 */
export interface DayGroup {
  day: string;
  items: Notification[];
}

function Row({
  n,
  now,
  me,
  selected,
  handlingProblem,
  onPick,
}: {
  n: Notification;
  now: number;
  me: Me | undefined;
  selected: boolean;
  handlingProblem: string | undefined;
  onPick: (id: string) => void;
}) {
  const resolved = Boolean(n.resolvedAt);
  const level = noticeLevelMeta[n.level];
  return (
    <ListRow
      tall
      selected={selected}
      data-notice-row
      data-notice-id={n.id}
      data-resolved={resolved ? 'true' : undefined}
      onClick={() => onPick(n.id)}
      title={
        <Text strong={!resolved} tone={resolved ? 'muted' : 'default'}>
          {n.title}
        </Text>
      }
      meta={
        <MetaLine
          items={[
            level.label,
            <span key="when" data-row-when>
              {formatAgo(n.createdAt, now)}
            </span>,
            resolved && n.resolvedAt
              ? `${n.resolvedBy ? (isMine(n.resolvedBy, me) ? '我' : n.resolvedBy) : ''}处理于 ${formatAgo(n.resolvedAt, now)}`
              : null,
          ]}
        />
      }
      trailing={
        <Stack direction="horizontal" gap="sm" align="center">
          {hasUndelivered(n) ? <Tag tone="fail">飞书没送到</Tag> : null}
          {!resolved && n.handling ? (
            <StatusBadge status={stageStatus(n.handling.stage)} variant="dot" />
          ) : !resolved && n.level === 'alert' && handlingProblem ? (
            <Text size="meta" tone="muted" title={handlingProblem}>
              没读到
            </Text>
          ) : null}
        </Stack>
      }
    />
  );
}

/** 按天分组的通知行：每天一个灰字小标题，下面是那天的行。 */
export function NoticeRows({
  groups,
  now,
  me,
  selectedId,
  handlingProblem,
  onPick,
}: {
  groups: readonly DayGroup[];
  now: number;
  me: Me | undefined;
  selectedId: string | undefined;
  handlingProblem: string | undefined;
  onPick: (id: string) => void;
}) {
  return (
    <>
      {groups.flatMap((g) => [
        <ListRow
          key={`day-${g.day}`}
          data-day-head
          summary={
            <Text size="meta" tone="muted">
              {g.day}
            </Text>
          }
        />,
        ...g.items.map((n) => (
          <Row
            key={n.id}
            n={n}
            now={now}
            me={me}
            selected={selectedId === n.id}
            handlingProblem={handlingProblem}
            onPick={onPick}
          />
        )),
      ])}
    </>
  );
}

/** 「全部」视图里折成一行的日报：点开才铺开（用 key 随级别重置，切回「全部」时重新折叠）。 */
export function DailyFold({ count, children }: { count: number; children: React.ReactNode }) {
  return (
    <ListRow
      expandable
      data-testid="daily-fold"
      title={
        <Text>
          日报 <Text strong>{count}</Text> 条
        </Text>
      }
    >
      {children}
    </ListRow>
  );
}
