// 设置页仓库表里的「指挥官整理待办」（母单 #1335 第 4 片；#3533 照样稿拆成三块）：
// - RepoNameCell：仓名加一行小字（主线）。
// - GroomAction：操作格里的「整理待办」文字按钮；先确认（原因可空）再 POST，被拒时把后端的原话留在确认框里，不换成「出错了」。
// - GroomDetail：展开区里的整理状态（整理到哪、今日剩余、最近一次结果、更早的记录、读不懂的记录数）。
// 总开关读到关着才提前置灰；读不到（出错、还在读、远程快照没有这一格）不冒充关着，按钮保持能点。
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useGroomNow, useGroomStatus } from '../api/client';
import type { GroomStatus } from '../api/types';
import { formatAgo, formatDateTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { useMasterView } from './engine-master';
import { Button } from './layout/button';
import { ConfirmDialog } from './layout/confirm-dialog';
import { Label, Textarea } from './layout/input';
import { LoadError } from './layout/load-state';
import { Notice } from './layout/notice';
import { Stack } from './layout/stack';
import { Text } from './layout/text';
import { RepoLink } from './repo-link';

type GroomRequest = GroomStatus['recent'][number];

/** 整理记录的状态词（句子里的一截，不是状态标签，所以不走 StatusBadge）。 */
function stateWord(state: GroomRequest['state']): string {
  switch (state) {
    case 'queued':
      return '排队';
    case 'running':
      return '在做';
    case 'done':
      return '做成了';
    case 'failed':
      return '没做成';
    case 'expired':
      return '作废了';
  }
}

/** 展开区里的说明（原「展开」折叠里的那段，直接写在展开区，不再套一层折叠）。 */
const GROOM_HELP =
  '老单要整理过才能进队；同一时刻一次，每仓每天最多 3 次。开单早于接活开关的老单要贴了「整理过」或「交给引擎」才进队。点「整理待办」会记一条操作记录，引擎几秒内接手。';

function whenOf(row: GroomRequest): string {
  return row.finishedAt ?? row.startedAt ?? row.requestedAt;
}

function IssueNums({
  repo,
  items,
}: {
  repo: { owner: string; name: string };
  items: { n: number; title?: string }[];
}) {
  return items.map((item, i) => (
    <span key={item.n}>
      {i > 0 ? '、' : null}
      <RepoLink repo={repo} kind="issues" n={item.n}>
        #{item.n}
      </RepoLink>
      {item.title ? <Text tone="muted"> {item.title}</Text> : null}
    </span>
  ));
}

/** 最近一次做成了什么：开了、补了、建议关、贴要人拍，单号链到 GitHub。 */
function ResultSummary({
  result,
  repo,
}: {
  result: NonNullable<GroomRequest['result']>;
  repo: { owner: string; name: string };
}) {
  const lines: { label: string; items: { n: number; title?: string }[] }[] = [
    { label: '开了', items: result.opened.map((o) => ({ n: o.number, title: o.title })) },
    { label: '补了', items: result.amended.map((n) => ({ n })) },
    { label: '建议关', items: result.suggestedClose.map((n) => ({ n })) },
    { label: '贴要人拍', items: result.flagged.map((n) => ({ n })) },
  ];
  return (
    <ul aria-label="最近一次结果">
      {lines.map((line) => (
        <li key={line.label}>
          <Text size="meta">
            {line.label} {line.items.length} 张{line.items.length > 0 ? '：' : null}
            <IssueNums repo={repo} items={line.items} />
          </Text>
        </li>
      ))}
      {result.summary ? (
        <li>
          <Text size="meta" tone="muted">
            {result.summary}
          </Text>
        </li>
      ) : null}
    </ul>
  );
}

/** 仓名格：仓名（悬停给全名）加一行小字「主线 main」。 */
export function RepoNameCell({ repo, branch }: { repo: { owner: string; name: string }; branch: string }) {
  const name = `${repo.owner}/${repo.name}`;
  return (
    <Stack gap="sm">
      <Text strong truncate title={name}>
        {name}
      </Text>
      <Text size="meta" tone="muted">
        主线 {branch}
      </Text>
    </Stack>
  );
}

/** 操作格里的「整理待办」。 */
export function GroomAction({ repoId, repo }: { repoId: string; repo: { owner: string; name: string } }) {
  const name = `${repo.owner}/${repo.name}`;
  const query = useGroomStatus(repoId);
  const groom = useGroomNow();
  const { view: masterView } = useMasterView();
  const masterOff = masterView.kind === 'ok' && !masterView.master.on;
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const reasonId = useId();
  const busy = query.data?.busy === true;
  const blocked = groom.isPending || busy || query.isLoading || masterOff;

  // 确定键用 onConfirm 等结果（#2012）：成功才关框、清原因；失败留在框里统一写原因，这里只负责打 toast、把错误抛回给框。
  const confirm = async () => {
    const text = reason.trim();
    try {
      await groom.mutateAsync({ repoId, body: text ? { reason: text } : {} });
      setAsking(false);
      setReason('');
      toast.success(`已叫指挥官整理：${name}`);
    } catch (e) {
      toast.error('没叫成', { description: errorText(e) });
      throw e;
    }
  };

  return (
    <span data-testid={`groom-${repoId}`}>
      <Button
        size="sm"
        variant="text"
        disabledReason={
          masterOff ? '引擎总开关关着，不整理' : blocked ? (busy ? '正在整理' : '正在读整理状态') : undefined
        }
        onClick={() => {
          setReason('');
          setAsking(true);
        }}
        aria-label={`让指挥官整理 ${name} 的待办`}
        title="叫指挥官现在整理这个仓的待办"
      >
        整理待办
      </Button>
      <ConfirmDialog
        open={asking}
        onOpenChange={setAsking}
        title={`让指挥官整理 ${name} 的待办？`}
        description="记一条操作记录，引擎几秒内接手。同一时刻全局只做一次，这个仓每 24 小时最多 3 次。"
        confirmText="确认整理"
        onConfirm={confirm}
      >
        <Stack gap="sm">
          <Label htmlFor={reasonId}>原因（可以不填）</Label>
          <Textarea
            id={reasonId}
            value={reason}
            maxLength={500}
            placeholder="为什么现在整理"
            onChange={(e) => setReason(e.target.value)}
          />
        </Stack>
      </ConfirmDialog>
    </span>
  );
}

/** 展开区里的整理状态。 */
export function GroomDetail({ repoId, repo }: { repoId: string; repo: { owner: string; name: string } }) {
  const query = useGroomStatus(repoId);
  const now = useNow();
  const status = query.data;
  const latest = status?.recent[0];
  const older = status?.recent.slice(1) ?? [];
  const busy = status?.busy === true;

  const line = busy
    ? '整理中'
    : latest
      ? `${stateWord(latest.state)} ${formatAgo(whenOf(latest), now)}`
      : status
        ? '还没整理过'
        : null;

  return (
    <div data-testid={`groom-detail-${repoId}`}>
      <Stack gap="sm">
        <Text strong>整理待办</Text>
        <Text size="meta" tone="muted">
          {GROOM_HELP}
        </Text>
        {query.isLoading ? (
          <Text size="meta" tone="muted">
            在读…
          </Text>
        ) : null}
        {query.error ? <LoadError what="指挥官整理待办" error={query.error} /> : null}
        {status ? (
          <Text size="meta" tone={!busy && latest?.state === 'failed' ? 'danger' : 'default'}>
            {line}
            {' · '}
            <span data-testid={`groom-quota-${repoId}`}>
              今日剩余 {status.quota.remaining}/{status.quota.max}
            </span>
          </Text>
        ) : null}
        {status && status.unreadable > 0 ? (
          <Notice tone="stall" role="status">
            有 {status.unreadable} 条记录没读懂，下面不是全部。
          </Notice>
        ) : null}
        {status && latest ? (
          <>
            <Text size="meta">
              最近一次：{stateWord(latest.state)} · {formatDateTime(whenOf(latest))}
            </Text>
            {latest.why ? (
              <Text size="meta" tone="muted">
                {latest.why}
              </Text>
            ) : null}
            {latest.result ? <ResultSummary result={latest.result} repo={repo} /> : null}
            {!latest.result && (latest.state === 'queued' || latest.state === 'running') ? (
              <Text size="meta" tone="muted">
                还没有结果
              </Text>
            ) : null}
          </>
        ) : status ? (
          <Text size="meta" tone="muted">
            还没整理过
          </Text>
        ) : null}
        {older.length > 0 ? (
          <ul aria-label="更早的整理">
            {older.map((row) => (
              <li key={row.requestId}>
                <Text size="meta" tone="muted">
                  {stateWord(row.state)} · {formatDateTime(whenOf(row))}
                  {row.why ? ` · ${row.why}` : null}
                </Text>
              </li>
            ))}
          </ul>
        ) : null}
      </Stack>
    </div>
  );
}
