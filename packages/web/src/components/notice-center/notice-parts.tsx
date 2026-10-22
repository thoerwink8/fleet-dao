// 通知中心详情里的几小块（#3533，样稿 Inbox.dc.html）：飞书送没送到、谁在处理、拍过之后的结果。只拼 components/layout 的件。
import { brand } from '#brand';
import type { Me, Notification } from '../../api/types';
import { handlingContradicted, linkStatus } from '../../lib/alert-repair';
import { type DecisionResultKind, decisionResult } from '../../lib/decision-result';
import { formatAgo, formatDateTime, formatDuration } from '../../lib/format';
import { isMine } from '../../lib/status';
import type { StatusKey } from '../../theme/status-dict';
import { Notice } from '../layout/notice';
import { Stack } from '../layout/stack';
import { StatusBadge } from '../layout/status-badge';
import { Tag } from '../layout/tag';
import { Text } from '../layout/text';
import { WorkRef } from '../work-ref';

export type Handling = NonNullable<Notification['handling']>;

const DELIVERY_NAME: Record<string, string> = { feishu: '飞书' };

/** 这条有没有哪个渠道没送到（列表行上的红标签用）。 */
export function hasUndelivered(n: Notification): boolean {
  return n.deliveries.some((d) => !d.delivered);
}

/**
 * 飞书等渠道送没送到：没拿到消息编号就算没送到。送到了是一截灰字（平常事，不占色块）；
 * 没送到才是红标签，试了几次、最后一次、错误原因写在后面（路由页样板 #1914：一行只一个显眼的东西）。
 */
export function Deliveries({ n }: { n: Notification }) {
  if (!n.deliveries.length) {
    return (
      <Text size="meta" tone="muted">
        只在{brand.product}
      </Text>
    );
  }
  return (
    <Stack direction="horizontal" gap="md" align="center" wrap>
      {n.deliveries.map((d, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 同一渠道可以发给好几个对象，契约里没有对象编号。
        <Delivery key={`${d.channel}-${i}`} d={d} />
      ))}
    </Stack>
  );
}

function Delivery({ d }: { d: Notification['deliveries'][number] }) {
  const name = DELIVERY_NAME[d.channel] ?? d.channel;
  const detail = `试了 ${d.attempts} 次${d.lastAttemptAt ? ` · 最后一次 ${formatDateTime(d.lastAttemptAt)}` : ''}${d.error ? ` · ${d.error}` : ''}`;
  if (d.delivered) {
    return (
      <Text size="meta" tone="muted" title={detail} data-delivery="ok">
        {name}已送到
      </Text>
    );
  }
  return (
    <Stack direction="horizontal" gap="sm" align="center" wrap>
      <Tag tone="fail">{name}没送到</Tag>
      <Text size="meta" tone="muted">
        {detail}
      </Text>
    </Stack>
  );
}

/** 处理到哪一步对应的字典键（后端 stage → 状态字典，颜色等级和字都在字典里）。 */
export function stageStatus(stage: Handling['stage']): StatusKey {
  return `notification:handling:${stage}`;
}

/**
 * 谁在处理 · 链接 · 多久了（design 15.3「谁在处理」）：后端从认领、PR、发布记录现算的，这里只照着显示；
 * 没查成的（发布判不了之类）照实列出来。这一行说「没人在修」，这次事故却明确关联了单（#3034 评审）：照关联现场写。
 */
export function HandlingValue({ h, now, n }: { h: Handling; now: number; n: Notification }) {
  const link = handlingContradicted(n) ? n.repair?.linked : undefined;
  if (link) {
    const ref = `${link.issue.repo.owner}/${link.issue.repo.name}#${link.issue.number}`;
    return (
      <Stack
        direction="horizontal"
        gap="md"
        align="center"
        wrap
        data-testid="alert-handling"
        data-from="linked"
      >
        <StatusBadge status={linkStatus(link)} variant="dot" />
        <Text size="meta" tone="muted" title={formatDateTime(link.at)}>
          {formatDuration(now - Date.parse(link.at))}
        </Text>
        <WorkRef repo={link.issue.repo} kind="issues" n={link.issue.number} label={ref} />
        {link.prNumber ? (
          <WorkRef repo={link.issue.repo} kind="pull" n={link.prNumber} label={`PR #${link.prNumber}`} />
        ) : null}
        <Text size="meta" tone="muted">
          处理人未知
        </Text>
      </Stack>
    );
  }
  return (
    <Stack direction="horizontal" gap="md" align="center" wrap data-testid="alert-handling">
      <StatusBadge status={stageStatus(h.stage)} variant="dot" title={[h.line, ...h.problems].join(' · ')} />
      <Text size="meta" tone="muted" title={formatDateTime(h.since)}>
        {formatDuration(now - Date.parse(h.since))}
      </Text>
      {h.work ? (
        <WorkRef
          repo={h.work.repo}
          kind="issues"
          n={h.work.issueNumber}
          label={`${h.work.repo.owner}/${h.work.repo.name}#${h.work.issueNumber}`}
        />
      ) : null}
      {h.pr ? <WorkRef repo={h.pr.repo} kind="pull" n={h.pr.number} label={`PR #${h.pr.number}`} /> : null}
      {h.who ? <Text>{h.who}</Text> : null}
      {h.silence ? (
        <Text size="meta" tone="muted">
          {h.silence.comment} · 到 {formatDateTime(h.silence.endsAt)}
        </Text>
      ) : null}
      {h.problems.map((p) => (
        <Text key={p} size="meta" tone="danger">
          {p}
        </Text>
      ))}
    </Stack>
  );
}

const RESULT_TONE = { done: 'done', queued: 'info', failed: 'fail', pending: 'info' } as const;

function resultStatus(kind: DecisionResultKind): StatusKey {
  return `notification:answer:${kind}`;
}

/**
 * 拍过的：谁选了什么、多久前，系统照着做的结果写在下面（#2353）。做成了、交给引擎了是信息条，没做成红条（卡留着，再选一次）。
 * 已处理的只写一行「我选了：…」加结果的话，不占色块。
 */
export function DecisionAnswerLine({
  n,
  me,
  now,
  plain = false,
}: {
  n: Notification;
  me: Me | undefined;
  now: number;
  /** 已处理的卡：一行灰字，不画结果框。 */
  plain?: boolean;
}) {
  const a = n.answer;
  if (!a) return null;
  const res = decisionResult(a);
  const who = `${isMine(a.by, me) ? '我' : a.by}${a.optionId === undefined ? '自己写了：' : '选了：'}`;
  if (plain) {
    return (
      <Text
        size="meta"
        tone="secondary"
        data-testid="decision-answer"
        data-result={res.kind}
        title={`${a.text} · ${formatDateTime(a.at)} · ${res.text}`}
      >
        {who}
        <Text size="meta" strong>
          {a.text}
        </Text>
        {a.execution ? ` · ${res.text}` : ''}
      </Text>
    );
  }
  return (
    <Notice
      tone={RESULT_TONE[res.kind]}
      role="status"
      title={
        <Stack direction="horizontal" gap="sm" wrap data-testid="decision-answer" data-result={res.kind}>
          <StatusBadge status={resultStatus(res.kind)} variant="dot" />
          <Text strong>
            {' · '}
            {who}
            {a.text}
          </Text>
          <Text size="meta" tone="secondary" title={formatDateTime(a.at)}>
            {formatAgo(a.at, now)}
          </Text>
        </Stack>
      }
    >
      <Text data-testid="decision-result">
        {res.text}
        {res.kind === 'failed' ? '。这条还开着，下面再选一次或自己写一句。' : ''}
      </Text>
    </Notice>
  );
}
