import { ChevronRight } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { errorText, useGroomNow, useGroomStatus } from '../api/client';
import type { GroomStatus } from '../api/types';
import { formatAgo, formatDateTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { useMasterView } from './engine-master';
import { LoadError } from './page';
import { RepoLink } from './repo-link';
import { StatusDot } from './status';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from './ui/alert-dialog';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Textarea } from './ui/textarea';

type GroomRequest = GroomStatus['recent'][number];

const STATE_WORD: Record<GroomRequest['state'], string> = {
  queued: '排队',
  running: '在做',
  done: '做成了',
  failed: '没做成',
  expired: '作废了',
};

/** 行尾状态点的颜色：做成绿、没做成红、排队在做蓝、作废灰。 */
const STATE_TONE: Record<GroomRequest['state'], Tone> = {
  queued: 'run',
  running: 'run',
  done: 'done',
  failed: 'fail',
  expired: 'stop',
};

/** 长说明默认折叠时露在外面的一行摘要（原仓库一节常显长文的压缩版）。 */
const GROOM_HELP_SUMMARY = '老单要整理过才能进队；同一时刻一次，每仓每天最多 3 次。';

/**
 * 点「展开」后才露的说明。正文是原 settings「仓库」一节 description 里铺满首屏的那段
 * （「让 AI 接活」开着/关着与整理准入），从常显挪进这里，默认不占屏。
 */
const GROOM_HELP_DETAIL =
  '「让 AI 接活」开着：引擎每 5 分钟自己按准入和排序挑单（老单要指挥官整理过），没单可挑会自动叫指挥官整理。关着：只有本机 fleet-api dispatch-issue 点名派。开单早于接活开关的老单要贴了「整理过」或「交给引擎」才进队。点下面按钮会记一条操作记录，引擎几秒内接手。';

/** 「指挥官整理待办」的长说明：默认一行摘要 +「展开」，点开才铺全文。 */
function GroomHelp() {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <div className="mt-1.5 text-xs text-muted-foreground" data-testid="groom-help">
      <div className="flex min-w-0 items-start gap-2">
        <p className="min-w-0 flex-1 truncate" title={GROOM_HELP_SUMMARY}>
          {GROOM_HELP_SUMMARY}
        </p>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="shrink-0 underline-offset-2 hover:underline"
        >
          {open ? '收起' : '展开'}
        </button>
      </div>
      {open ? (
        <p id={bodyId} className="mt-1 break-words">
          {GROOM_HELP_DETAIL}
        </p>
      ) : null}
    </div>
  );
}

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
      <RepoLink repo={repo} kind="issues" n={item.n} className="num underline underline-offset-2">
        #{item.n}
      </RepoLink>
      {item.title ? <span className="ml-1 text-muted-foreground">{item.title}</span> : null}
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
    <ul aria-label="最近一次结果" className="mt-1 space-y-0.5 text-xs">
      {lines.map((line) => (
        <li key={line.label}>
          {line.label} {line.items.length} 张{line.items.length > 0 ? '：' : null}
          <IssueNums repo={repo} items={line.items} />
        </li>
      ))}
      {result.summary ? <li className="text-muted-foreground">{result.summary}</li> : null}
    </ul>
  );
}

/**
 * 设置页每个仓「让 AI 接活」旁边的「指挥官整理待办」。
 * 次数和最近结果读 GET；按钮先确认（原因可空）再 POST。被拒时把后端的原话留下，不换成「出错了」。
 */
export function RepoGroomControl({
  repoId,
  repo,
}: {
  repoId: string;
  repo: { owner: string; name: string };
}) {
  const name = `${repo.owner}/${repo.name}`;
  const query = useGroomStatus(repoId);
  const groom = useGroomNow();
  const { view: masterView } = useMasterView();
  // 读到总开关关着才提前置灰。读不到（出错、还在读、远程快照没有这一格）不冒充关着，按钮保持能点。
  const masterOff = masterView.kind === 'ok' && !masterView.master.on;
  const [asking, setAsking] = useState(false);
  const [open, setOpen] = useState(false);
  const detailId = useId();
  const now = useNow();
  const [reason, setReason] = useState('');
  const [writeError, setWriteError] = useState<unknown>(null);
  const reasonId = useId();
  const status = query.data;
  const latest = status?.recent[0];
  const older = status?.recent.slice(1) ?? [];
  const busy = status?.busy === true;

  const confirm = () => {
    const text = reason.trim();
    setWriteError(null);
    groom.mutate(
      { repoId, body: text ? { reason: text } : {} },
      {
        onSuccess: () => {
          setAsking(false);
          setReason('');
          toast.success(`已叫指挥官整理：${name}`);
        },
        onError: (e) => {
          setAsking(false);
          setWriteError(e);
          toast.error('没叫成', { description: errorText(e) });
        },
      },
    );
  };

  return (
    <section data-testid={`groom-${repoId}`} aria-label={`${name} 的指挥官整理待办`} className="contents">
      {/* 行尾：状态点 + 一句状态 + 今日剩余 + 「详情」+「整理」按钮；整理记录点「详情」才展开。 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 self-center">
        <StatusDot tone={busy ? 'run' : latest ? STATE_TONE[latest.state] : 'stop'} />
        <span className="text-xs">
          {busy ? (
            <span className="font-medium text-ink-stall">整理中</span>
          ) : latest ? (
            <>
              <span className="font-medium">{STATE_WORD[latest.state]}</span>{' '}
              <span className="num text-muted-foreground">{formatAgo(whenOf(latest), now)}</span>
            </>
          ) : status ? (
            <span className="text-muted-foreground">还没整理过</span>
          ) : (
            <span className="text-muted-foreground">整理</span>
          )}
        </span>
        {status ? (
          <span className="num text-caption text-muted-foreground" data-testid={`groom-quota-${repoId}`}>
            今日剩余 {status.quota.remaining}/{status.quota.max}
          </span>
        ) : null}
        {masterOff ? (
          <span className="text-caption text-muted-foreground">引擎总开关关着，不整理</span>
        ) : null}
        <button
          type="button"
          aria-expanded={open}
          aria-controls={detailId}
          aria-label={`${name} 的整理详情`}
          onClick={() => setOpen((v) => !v)}
          className="inline-flex items-center gap-0.5 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          详情
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} aria-hidden />
        </button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={groom.isPending || busy || query.isLoading || masterOff}
          onClick={() => {
            if (masterOff) return;
            setReason('');
            setAsking(true);
          }}
          aria-label={`让指挥官整理 ${name} 的待办`}
          title={masterOff ? '引擎总开关关着，不整理' : undefined}
        >
          整理
        </Button>
      </div>

      {open || query.error || writeError || (status && status.unreadable > 0) ? (
        <div id={detailId} className="min-w-0 basis-full rounded-lg border border-dashed px-3 py-2">
          <h3 className="text-xs font-medium">指挥官整理待办</h3>
          {open ? <GroomHelp /> : null}
          {query.isLoading ? <p className="mt-1 text-xs text-muted-foreground">在读…</p> : null}
          {query.error ? (
            <div className="mt-2">
              <LoadError what="指挥官整理待办" error={query.error} />
            </div>
          ) : null}
          {status && status.unreadable > 0 ? (
            <p className="mt-1 text-xs text-ink-fail">有 {status.unreadable} 条记录没读懂，下面不是全部。</p>
          ) : null}

          {open && status && latest ? (
            <div className="mt-1.5">
              <p className="text-xs">
                最近一次：{STATE_WORD[latest.state]} ·{' '}
                <span className="num">{formatDateTime(whenOf(latest))}</span>
              </p>
              {latest.why ? (
                <p className="mt-0.5 break-words text-xs text-muted-foreground">{latest.why}</p>
              ) : null}
              {latest.result ? <ResultSummary result={latest.result} repo={repo} /> : null}
              {!latest.result && (latest.state === 'queued' || latest.state === 'running') ? (
                <p className="mt-0.5 text-xs text-muted-foreground">还没有结果</p>
              ) : null}
            </div>
          ) : open && status ? (
            <p className="mt-1.5 text-xs text-muted-foreground">还没整理过</p>
          ) : null}

          {open && older.length > 0 ? (
            <ul aria-label="更早的整理" className="mt-1.5 space-y-0.5 text-xs text-muted-foreground">
              {older.map((row) => (
                <li key={row.requestId} className="break-words">
                  {STATE_WORD[row.state]} · <span className="num">{formatDateTime(whenOf(row))}</span>
                  {row.why ? ` · ${row.why}` : null}
                </li>
              ))}
            </ul>
          ) : null}
          {writeError ? (
            <p role="alert" className="mt-1.5 break-words text-xs text-ink-fail">
              {errorText(writeError)}
            </p>
          ) : null}
        </div>
      ) : null}

      <AlertDialog open={asking} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>让指挥官整理 {name} 的待办？</AlertDialogTitle>
            <AlertDialogDescription>
              记一条操作记录，引擎几秒内接手。同一时刻全局只做一次，这个仓每 24 小时最多 3 次。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor={reasonId}>原因（可以不填）</Label>
            <Textarea
              id={reasonId}
              value={reason}
              maxLength={500}
              placeholder="为什么现在整理"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              disabled={groom.isPending}
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              {groom.isPending ? '正在提交' : '确认整理'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
