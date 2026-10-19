// 任务页的概览（#3140）：一屏看到这张单的结论、关联 PR、改了哪些文件、命令跑得怎么样。
// 参照 Claude 桌面版 Agent 会话：正文先给结论（最新一笔的最后汇报），再给一行进度（N 个命令已完成，M 个失败，K 个在跑），
// 然后是 PR 横条（紫色淡底：号、仓、分支、状态，点了去 GitHub）和「已编辑 N 个文件」折叠卡（每个文件一行带 +/-，只露前 3 个）。
// 数都是后端放在任务详情 overview 里的（packages/api/src/task-overview.ts）：改动卡的文件和增删行来自按 PR 头记的 numstat，
// 不是把每次编辑的行数加起来。读不到的写「没读到」和原因：老后端没给 overview、会话内容读不到、没记过这个 PR 的文件，
// 各写各的，不画 0。
import { ChevronRight, FileText } from 'lucide-react';
import { useState } from 'react';
import type { TaskDetail, TaskPr } from '../api/types';
import { formatAgo } from '../lib/format';
import { segmentLabel, UNKNOWN_SEGMENT } from '../lib/segments';
import { fileParts, PR_STATE, runOrder } from '../lib/task-process';
import { cn } from '../lib/utils';
import { DiffStat } from './diff-stat';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { RepoLink } from './repo-link';
import { Clamped } from './run-transcript';
import { Button } from './ui/button';

/** 改动卡默认露几个文件；PR 横条默认露几条。 */
export const FILES_SHOWN = 3;
export const PRS_SHOWN = 3;

type Overview = NonNullable<TaskDetail['overview']>;
type PrFiles = Extract<TaskPr['files'], { state: 'ok' }>;
type PrFile = PrFiles['items'][number];

/** 最新汇报：最近一笔动手的最后一句话；没有写原因，读不到另说。 */
function Report({ o }: { o: Overview }) {
  const r = o.report;
  if (r.state === 'unavailable') {
    return (
      <Notice tone="stall" title="最新汇报没读到">
        <span className="break-words">{r.reason}</span>
      </Notice>
    );
  }
  if (r.state === 'none') {
    return (
      <p className="text-body text-muted-foreground" data-report-missing>
        没有汇报：{r.reason}
      </p>
    );
  }
  return (
    <div data-task-report>
      <Clamped text={r.text} className="min-w-0 text-body break-words whitespace-pre-wrap" />
    </div>
  );
}

/** 「最新汇报」标题后面一句（照设计稿）：第几笔 · 段 · 模型 · 多久前；没有汇报不写。 */
export function reportMeta(d: TaskDetail, o: Overview, now: number): string | undefined {
  const r = o.report;
  if (r.state !== 'ok') return undefined;
  const run = d.segmentRuns.find((x) => x.id === r.runId);
  if (!run) return `最新一笔 · ${formatAgo(r.at, now)}`;
  const seg = run.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT;
  return [
    `第 ${runOrder(d.segmentRuns).get(run.id) ?? '?'} 笔`,
    seg,
    run.modelName,
    formatAgo(r.at, now),
  ].join(' · ');
}

/** 进度一行：N 个命令已完成，M 个失败；在跑的是一个蓝色小块；只有失败数标红。 */
function ProgressLine({ o }: { o: Overview }) {
  const t = o.tally;
  if (t.state === 'unavailable') {
    return (
      <Notice tone="stall" title="命令计数没读到">
        <span className="break-words">{t.reason}</span>
      </Notice>
    );
  }
  const c = t.total;
  if (c.entries === 0) {
    return (
      <p className="text-meta text-muted-foreground" data-progress-line>
        这张单还没有会话记录，没有命令和改动可数
      </p>
    );
  }
  return (
    <p className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-body" data-progress-line>
      <span>
        {c.commandsDone} 个命令已完成
        {c.commandsFailed > 0 ? (
          <>
            ，<span className="font-medium text-ink-fail">{c.commandsFailed} 个失败</span>
          </>
        ) : null}
      </span>
      {c.commandsRunning > 0 ? <StatusBadge tone="run" label={`${c.commandsRunning} 个正在运行`} /> : null}
      {c.commandsUnknown > 0 ? (
        <span
          className="text-meta text-muted-foreground"
          title="有调用、没有记下结果：老记录没调用号对不上、笔收场了结果没记、Mirasim 的流里没有退出码"
        >
          另有 {c.commandsUnknown} 个结果未知
        </span>
      ) : null}
      {c.reads > 0 ? <span className="text-meta text-muted-foreground">读了 {c.reads} 次文件</span> : null}
    </p>
  );
}

/** PR 横条：紫色淡底（PR 的颜色），号、仓、分支、状态；点了去 GitHub。 */
function PrBar({ pr, repo }: { pr: TaskPr; repo: TaskDetail['repo'] }) {
  const s = PR_STATE[pr.state];
  return (
    <li
      data-pr={pr.number}
      data-pr-state={pr.state}
      className="flex min-w-0 items-center gap-2 rounded-md border border-st-human-line bg-st-human-soft px-3 py-1.5 text-body max-md:min-h-10"
    >
      <RepoLink
        repo={repo}
        kind="pull"
        n={pr.number}
        className="num shrink-0 font-medium text-ink-human underline-offset-2 hover:underline"
      >
        #{pr.number}
      </RepoLink>
      <span className="num min-w-0 shrink truncate text-muted-foreground max-md:hidden">
        {repo.owner}/{repo.name}
      </span>
      {pr.branch ? (
        <span
          className="num min-w-0 flex-1 truncate font-mono text-meta text-muted-foreground"
          title={pr.branch}
        >
          {pr.branch}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {pr.files.state === 'ok' ? (
        <span className="num shrink-0 text-meta text-muted-foreground max-md:hidden">
          {pr.files.items.length} 个文件
        </span>
      ) : null}
      <StatusBadge
        tone={s.tone}
        label={s.label}
        {...((pr.note ?? s.hint) ? { title: pr.note ?? s.hint } : {})}
      />
    </li>
  );
}

function PrBars({ d, o }: { d: TaskDetail; o: Overview }) {
  const [all, setAll] = useState(false);
  const prs = o.prs;
  if (prs.length === 0) return null;
  const shown = all ? prs : prs.slice(0, PRS_SHOWN);
  return (
    <div data-pr-bars>
      <ul className="space-y-1.5" aria-label="关联的 PR">
        {shown.map((pr) => (
          <PrBar key={pr.number} pr={pr} repo={d.repo} />
        ))}
      </ul>
      {prs.length > PRS_SHOWN ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="mt-1 rounded-md px-1 text-meta text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none max-md:min-h-10"
        >
          {all ? '收起' : `还有 ${prs.length - PRS_SHOWN} 个 PR`}
        </button>
      ) : null}
    </div>
  );
}

function FileRow({ file, pr, repo }: { file: PrFile; pr: TaskPr; repo: TaskDetail['repo'] }) {
  const [open, setOpen] = useState(false);
  const { dir, base } = fileParts(file.path);
  return (
    <li data-file={file.path} className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-body hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-md:min-h-10"
      >
        <FileText className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="num min-w-0 flex-1 truncate" title={file.path}>
          <span className="text-muted-foreground">{dir}</span>
          <span className="font-medium">{base}</span>
        </span>
        {file.binary ? (
          <span className="shrink-0 text-meta text-muted-foreground" title="二进制文件，git 不给行数">
            二进制
          </span>
        ) : (
          <DiffStat added={file.added ?? undefined} removed={file.removed ?? undefined} />
        )}
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="px-3 pb-2 pl-8 text-meta text-muted-foreground" data-file-detail>
          <p>
            这里只记每个文件的增删行数，不存 diff 正文；完整 diff 在{' '}
            <RepoLink
              repo={repo}
              kind="pull"
              n={pr.number}
              className="num text-ink-human underline underline-offset-2"
            >
              PR #{pr.number}
            </RepoLink>{' '}
            的「Files changed」里。
          </p>
        </div>
      ) : null}
    </li>
  );
}

/** 一个 PR 的「已编辑 N 个文件 +x -y」折叠卡：每个文件一行，只露前 3 个，其余点开。 */
function ChangedFiles({ pr, files, repo }: { pr: TaskPr; files: PrFiles; repo: TaskDetail['repo'] }) {
  const [all, setAll] = useState(false);
  const items = files.items;
  const counted = items.filter((f) => f.added !== null || f.removed !== null);
  const added = counted.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = counted.reduce((n, f) => n + (f.removed ?? 0), 0);
  const shown = all ? items : items.slice(0, FILES_SHOWN);
  return (
    <div className="overflow-hidden rounded-md border" data-changed-files data-changed-pr={pr.number}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 border-b bg-muted px-3 py-1.5 text-body">
        <span className="num font-medium">已编辑 {items.length} 个文件</span>
        {counted.length > 0 ? <DiffStat added={added} removed={removed} /> : null}
        <span className="num text-meta text-muted-foreground">PR #{pr.number}</span>
        {files.current === false ? (
          <span
            className="text-meta text-ink-stall"
            title={`记下的是提交 ${files.headSha.slice(0, 7)} 的改动，PR 现在的头已经变了，数字可能落后`}
            data-files-stale
          >
            不是 PR 最新的头
          </span>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="px-3 py-1.5 text-body text-muted-foreground">这个头相对主线没有改动文件</p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.map((f) => (
            <FileRow key={f.path} file={f} pr={pr} repo={repo} />
          ))}
        </ul>
      )}
      {items.length > FILES_SHOWN ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="w-full border-t px-3 py-1.5 text-left text-meta text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-md:min-h-10"
        >
          {all ? '收起' : `还有 ${items.length - FILES_SHOWN} 个文件`}
        </button>
      ) : null}
    </div>
  );
}

/** 每个 PR 一张改动卡；没记过、读不到的 PR 各写一行原因。 */
function ChangedFilesBlock({ d, o }: { d: TaskDetail; o: Overview }) {
  if (o.prs.length === 0) return null;
  // 新的 PR 在前
  const prs = [...o.prs].sort((a, b) => b.number - a.number);
  return (
    <div className="space-y-2" data-changed-block>
      {prs.map((pr) =>
        pr.files.state === 'ok' ? (
          <ChangedFiles key={pr.number} pr={pr} files={pr.files} repo={d.repo} />
        ) : (
          <p
            key={pr.number}
            data-changed-unread={pr.number}
            className={cn(
              'text-meta',
              pr.files.state === 'unavailable' ? 'text-ink-stall' : 'text-muted-foreground',
            )}
          >
            PR #{pr.number} 的改动文件没读到：{pr.files.reason}
          </p>
        ),
      )}
    </div>
  );
}

/** 概览整块：汇报、进度、PR、改动文件。 */
export function TaskSummary({ d, now }: { d: TaskDetail; now: number }) {
  const o = d.overview;
  if (!o) {
    return (
      <Section title="最新汇报" variant="plain" data-task-summary>
        <Notice tone="info">
          这台后端还没有任务概览（老版本推来的详情），所以最新汇报、PR 状态、改动文件和命令计数都没读到。
        </Notice>
      </Section>
    );
  }
  // 照设计稿（#3228）：不套卡片，标题「最新汇报」后面写谁、多久前说的，右边跳到过程
  return (
    <Section
      title="最新汇报"
      description={reportMeta(d, o, now)}
      variant="plain"
      actions={
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="text-muted-foreground"
          onClick={() =>
            document
              .querySelector('[data-task-process]')
              ?.scrollIntoView({ block: 'start', behavior: 'smooth' })
          }
        >
          看全部过程
        </Button>
      }
      data-task-summary
    >
      <div className="space-y-3">
        <Report o={o} />
        <ProgressLine o={o} />
        <PrBars d={d} o={o} />
        <ChangedFilesBlock d={d} o={o} />
      </div>
    </Section>
  );
}
