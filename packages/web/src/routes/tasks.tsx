import { ListChecks, Search } from 'lucide-react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { useAllBoards, useMe } from '../api/client';
import type { BoardTask, Repo } from '../api/types';
import { BoardsError, Empty, LoadingRows, Page, Panel } from '../components/page';
import { useRepo } from '../components/repo-context';
import { StatusChip, ToneBar } from '../components/status';
import { Input } from '../components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../components/ui/table';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import {
  describeTask,
  isMine,
  isTaskClosed,
  taskLive,
  taskProgress,
  taskStateLabel,
  taskTone,
} from '../lib/status';
import { cn } from '../lib/utils';

export function meta() {
  return [{ title: brand.title('任务') }];
}

const TONE_FILTERS = [
  { id: 'all', label: '全部' },
  { id: 'run', label: '在干' },
  { id: 'stuck', label: '卡住' },
  { id: 'human', label: '等你' },
  { id: 'wait', label: '排队' },
  { id: 'done', label: '完成' },
] as const;

type ToneFilter = (typeof TONE_FILTERS)[number]['id'];

function matchTone(t: BoardTask, f: ToneFilter): boolean {
  const tone = taskTone(t);
  switch (f) {
    case 'all':
      return true;
    case 'stuck':
      return tone === 'stall' || tone === 'fail';
    case 'done':
      return tone === 'done' || tone === 'stop';
    default:
      return tone === f;
  }
}

export default function Tasks() {
  const { boards, isLoading, error, failed } = useAllBoards();
  const { repos } = useRepo();
  const { data: me } = useMe();
  const now = useNow();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tone = (TONE_FILTERS.find((f) => f.id === params.get('tone'))?.id ?? 'all') as ToneFilter;
  const repo = params.get('repo') ?? 'all';
  const mine = params.get('mine') === '1';
  const q = params.get('q') ?? '';

  const set = (key: string, value: string | null) => {
    const p = new URLSearchParams(params);
    if (value === null || value === '' || value === 'all') p.delete(key);
    else p.set(key, value);
    setParams(p, { replace: true });
  };

  const all: { t: BoardTask; repo: Repo }[] = boards.flatMap((b) =>
    b.tasks.map((t) => ({ t, repo: b.repo })),
  );
  const rows = all
    .filter(({ t }) => matchTone(t, tone))
    .filter((r) => repo === 'all' || r.repo.id === repo)
    .filter(({ t }) => !mine || isMine(t.requestedBy, me))
    .filter(
      ({ t }) =>
        !q || `#${t.issueNumber} ${t.title} ${t.requestedBy}`.toLowerCase().includes(q.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(isTaskClosed(a.t)) - Number(isTaskClosed(b.t)) ||
        a.t.priority - b.t.priority ||
        a.t.createdAt.localeCompare(b.t.createdAt),
    );

  const who = (t: BoardTask) => (isMine(t.requestedBy, me) ? '我' : t.requestedBy);

  return (
    <Page title="任务" description="所有需求，一行一个；点开看时间线、实时日志和每一步。">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div
          className="flex max-w-full overflow-x-auto rounded-lg bg-muted p-1"
          role="tablist"
          aria-label="按状态"
        >
          {TONE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={tone === f.id}
              onClick={() => set('tone', f.id)}
              className={cn(
                'h-7 shrink-0 rounded-md px-3 text-[13px] text-muted-foreground transition-colors',
                tone === f.id ? 'bg-card font-medium text-foreground shadow-sm' : 'hover:text-foreground',
              )}
            >
              {f.label}
              <span className="num ml-1 text-[11px] opacity-60">
                {all.filter(({ t }) => matchTone(t, f.id)).length}
              </span>
            </button>
          ))}
        </div>
        <Select value={repo} onValueChange={(v) => set('repo', v)}>
          <SelectTrigger size="sm" className="w-40" aria-label="按仓">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部仓</SelectItem>
            {repos.map((r) => (
              <SelectItem key={r.id} value={r.id}>
                <span className="num">{r.name}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          aria-pressed={mine}
          onClick={() => set('mine', mine ? null : '1')}
          className={cn(
            'h-8 rounded-lg border px-3 text-[13px] transition-colors',
            mine
              ? 'border-foreground bg-foreground text-background'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          只看我提的
        </button>
        <div className="relative ml-auto w-full sm:w-64">
          <Search
            className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={q}
            onChange={(e) => set('q', e.target.value)}
            placeholder="编号、标题、提出人"
            className="h-8 pl-8"
            aria-label="搜索需求"
          />
        </div>
      </div>

      {error ? (
        <div className="mb-3">
          <BoardsError failed={failed} error={error} />
        </div>
      ) : null}
      <Panel bodyClassName="p-0">
        {isLoading ? (
          <div className="p-4">
            <LoadingRows rows={6} />
          </div>
        ) : rows.length === 0 ? (
          error ? (
            <p className="px-4 py-10 text-center text-sm text-ink-fail">看板没读全，这里空着不代表没有需求</p>
          ) : (
            <Empty icon={ListChecks} title="没有符合条件的需求" hint="换个过滤条件看看。" />
          )
        ) : (
          <>
            <Table className="hidden md:table">
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16 pl-4">编号</TableHead>
                  <TableHead>需求</TableHead>
                  <TableHead className="w-28">仓</TableHead>
                  <TableHead className="w-28">状态</TableHead>
                  <TableHead className="w-36">进度</TableHead>
                  <TableHead className="w-24">提出人</TableHead>
                  <TableHead className="w-14">优先</TableHead>
                  <TableHead className="w-28 pr-4 text-right">提出于</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ t, repo: r }) => {
                  const toneNow = taskTone(t);
                  const prog = taskProgress(t);
                  return (
                    <TableRow
                      key={t.id}
                      className="cursor-pointer"
                      onClick={() => navigate(`/tasks/${t.id}`)}
                    >
                      <TableCell className="num pl-4 text-muted-foreground">#{t.issueNumber}</TableCell>
                      <TableCell className="max-w-0">
                        <Link
                          to={`/tasks/${t.id}`}
                          className="block truncate font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {t.title}
                        </Link>
                        <div className="truncate text-xs text-muted-foreground">{describeTask(t, now)}</div>
                      </TableCell>
                      <TableCell className="num text-xs text-muted-foreground">{r.name}</TableCell>
                      <TableCell>
                        <StatusChip tone={toneNow} label={taskStateLabel[t.state]} />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <ToneBar
                            value={prog.total ? prog.done / prog.total : 0}
                            tone={toneNow}
                            live={taskLive(t)}
                          />
                          <span className="num shrink-0 text-xs text-muted-foreground">
                            {prog.done}/{prog.total}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="max-w-0 truncate text-xs" title={t.requestedBy}>
                        {who(t)}
                      </TableCell>
                      <TableCell className="num text-xs text-muted-foreground">P{t.priority}</TableCell>
                      <TableCell className="num pr-4 text-right text-xs text-muted-foreground">
                        {formatAgo(t.createdAt, now)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            <ul className="divide-y md:hidden">
              {rows.map(({ t, repo: r }) => (
                <li key={t.id}>
                  <Link to={`/tasks/${t.id}`} className="block px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="num text-xs text-muted-foreground">#{t.issueNumber}</span>
                      <StatusChip tone={taskTone(t)} label={taskStateLabel[t.state]} />
                      <span className="num ml-auto text-[11px] text-muted-foreground">{r.name}</span>
                    </div>
                    <div className="mt-1 font-medium">{t.title}</div>
                    <div className="mt-0.5 text-xs text-muted-foreground">{describeTask(t, now)}</div>
                  </Link>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
    </Page>
  );
}
