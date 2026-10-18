// 任务页的概览（#3140）：一屏看到这张单的结论、关联 PR、改了哪些文件、命令跑得怎么样。
// 参照 Claude 桌面版 Agent 会话：正文先给结论（最新一笔的最后汇报），再给一行进度（N 个命令已完成，M 个失败，K 个在跑），
// 然后是 PR 横条（紫色淡底：号、仓、分支、状态，点了去 GitHub）和「已编辑 N 个文件」折叠卡（每个文件一行带 +/-，只露前 3 个）。
// 数都是后端从 run_transcript 算好放在任务详情的 overview 里（packages/api/src/task-overview.ts）；
// 读不到的写「没读到」和原因：老后端没给 overview、会话内容读不到、PR 镜像里没有，各写各的，不画 0。
import type { FileChange } from '@fleet-dao/shared';
import { ChevronRight, FileText } from 'lucide-react';
import { useState } from 'react';
import type { TaskDetail } from '../api/types';
import { formatAgo } from '../lib/format';
import { runNth, segmentLabel, UNKNOWN_SEGMENT } from '../lib/segments';
import { commandTally, fileParts, PR_STATE, type TaskPr, uncountedHint } from '../lib/task-process';
import { cn } from '../lib/utils';
import { Notice } from './layout/notice';
import { Section } from './layout/section';
import { StatusBadge } from './layout/status-badge';
import { RepoLink } from './repo-link';
import { Clamped } from './run-transcript';
import { DiffStat } from './task-process';

/** 改动卡默认露几个文件；PR 横条默认露几条。 */
export const FILES_SHOWN = 3;
export const PRS_SHOWN = 3;

function hasCounts(files: readonly FileChange[]): boolean {
  return files.some((f) => f.added !== undefined || f.removed !== undefined);
}

/** 最新汇报：最新一笔的结论（没有结论取最后一句话）；读不到写原因。 */
function Report({ d, now }: { d: TaskDetail; now: number }) {
  const p = d.overview?.process;
  if (!p || p.state !== 'ok') return null;
  if (!p.report) {
    return (
      <p className="text-body text-muted-foreground" data-report-missing>
        没有汇报：{p.reportNote ?? '没读到'}
      </p>
    );
  }
  const run = d.segmentRuns.find((r) => r.id === p.report?.runId);
  const nth = run ? (runNth(d.segmentRuns, run.id) ?? 1) : undefined;
  const seg = run?.segment ? segmentLabel[run.segment] : UNKNOWN_SEGMENT;
  return (
    <div data-task-report>
      <Clamped text={p.report.text} className="min-w-0 text-body break-words whitespace-pre-wrap" />
      <p className="mt-1 text-meta text-muted-foreground">
        {run ? `来自${seg}第 ${nth} 次` : '来自最新一笔'} · {formatAgo(p.report.at, now)}
        {p.report.source === 'assistant' ? '（这一笔没写结论，取的是最后一句话）' : ''}
      </p>
    </div>
  );
}

/** 进度一行：N 个命令已完成，M 个失败；在跑的是一个蓝色小块；只有失败数标红。 */
function ProgressLine({ d }: { d: TaskDetail }) {
  const p = d.overview?.process;
  if (!p || p.state !== 'ok') return null;
  const c = p.counts;
  const hasRecord = p.runs.some((r) => !r.noRecord);
  if (!hasRecord) {
    return (
      <p className="text-meta text-muted-foreground" data-progress-line>
        这张单的几笔都跑在记录会话内容之前，没有命令和改动的记录
      </p>
    );
  }
  const t = commandTally(c);
  return (
    <p className="num flex flex-wrap items-center gap-x-2 gap-y-1 text-body" data-progress-line>
      <span>
        {t.done} 个命令已完成
        {t.failed > 0 ? (
          <>
            ，<span className="font-medium text-ink-fail">{t.failed} 个失败</span>
          </>
        ) : null}
      </span>
      {t.running > 0 ? <StatusBadge tone="run" label={`${t.running} 个正在运行`} /> : null}
      {t.unknown > 0 ? (
        <span className="text-meta text-muted-foreground" title="这些笔已经收场，命令有调用、没有记下结果">
          另有 {t.unknown} 个没读到结果
        </span>
      ) : null}
      {c.reads > 0 ? <span className="text-meta text-muted-foreground">读了 {c.reads} 个文件</span> : null}
    </p>
  );
}

/** PR 横条：紫色淡底（PR 的颜色），号、仓、分支、状态；点了去 GitHub。 */
function PrBar({ pr, repo }: { pr: TaskPr; repo: TaskDetail['repo'] }) {
  const s = PR_STATE[pr.state];
  const counted = pr.files.length > 0;
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
      {counted ? (
        <span className="num shrink-0 text-meta text-muted-foreground max-md:hidden">
          {pr.files.length} 个文件
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

function PrBars({ d }: { d: TaskDetail }) {
  const [all, setAll] = useState(false);
  const prs = d.overview?.prs ?? [];
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

function FileRow({
  file,
  prs,
  repo,
}: {
  file: FileChange;
  prs: readonly TaskPr[];
  repo: TaskDetail['repo'];
}) {
  const [open, setOpen] = useState(false);
  const { dir, base } = fileParts(file.path);
  const pr = prs.find((p) => p.files.some((f) => f.path === file.path));
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
        {file.added !== undefined || file.removed !== undefined ? (
          <DiffStat added={file.added} removed={file.removed} />
        ) : (
          <span className="shrink-0 text-meta text-muted-foreground" title="这个文件的编辑没有记行数">
            没记行数
          </span>
        )}
        <ChevronRight
          className={cn('size-3.5 shrink-0 text-muted-foreground', open && 'rotate-90')}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="px-3 pb-2 pl-8 text-meta text-muted-foreground" data-file-detail>
          <p>
            会话里改了 {file.edits} 次。这里只记每次编辑改了几行，不存 diff 正文
            {pr ? (
              <>
                ；完整 diff 在{' '}
                <RepoLink
                  repo={repo}
                  kind="pull"
                  n={pr.number}
                  className="num text-ink-human underline underline-offset-2"
                >
                  PR #{pr.number}
                </RepoLink>{' '}
                的「Files changed」里。
              </>
            ) : (
              '，这个文件对应的 PR 没读到。'
            )}
          </p>
        </div>
      ) : null}
    </li>
  );
}

/** 「已编辑 N 个文件 +x -y」折叠卡：每个文件一行，只露前 3 个，其余点开。 */
function ChangedFiles({ d }: { d: TaskDetail }) {
  const [all, setAll] = useState(false);
  const p = d.overview?.process;
  if (!p || p.state !== 'ok') return null;
  const c = p.counts;
  if (c.files.length === 0) {
    return p.runs.some((r) => !r.noRecord) ? (
      <p className="text-meta text-muted-foreground" data-changed-empty>
        这张单的会话里没有编辑过文件
      </p>
    ) : null;
  }
  const shown = all ? c.files : c.files.slice(0, FILES_SHOWN);
  const counted = hasCounts(c.files);
  return (
    <div className="overflow-hidden rounded-md border" data-changed-files>
      <div className="flex min-w-0 items-center gap-2 border-b bg-muted px-3 py-1.5 text-body">
        <span className="num font-medium">已编辑 {c.files.length} 个文件</span>
        <DiffStat
          added={counted ? c.added : undefined}
          removed={counted ? c.removed : undefined}
          title={uncountedHint(c.uncounted)}
        />
        {!counted ? <span className="text-meta text-muted-foreground">没记行数</span> : null}
        {c.uncounted > 0 && counted ? (
          <span className="text-meta text-muted-foreground" title={uncountedHint(c.uncounted)}>
            （另有 {c.uncounted} 次没记行数）
          </span>
        ) : null}
      </div>
      <ul className="divide-y divide-border">
        {shown.map((f) => (
          <FileRow key={f.path} file={f} prs={d.overview?.prs ?? []} repo={d.repo} />
        ))}
      </ul>
      {c.files.length > FILES_SHOWN ? (
        <button
          type="button"
          aria-expanded={all}
          onClick={() => setAll((v) => !v)}
          className="w-full border-t px-3 py-1.5 text-left text-meta text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset max-md:min-h-10"
        >
          {all ? '收起' : `还有 ${c.files.length - FILES_SHOWN} 个文件`}
        </button>
      ) : null}
    </div>
  );
}

/** 概览整块：汇报、进度、PR、改动文件。 */
export function TaskSummary({ d, now }: { d: TaskDetail; now: number }) {
  const o = d.overview;
  if (!o) {
    return (
      <Section title="汇报与改动" data-task-summary>
        <Notice tone="info">
          这台后端还没有任务概览（老版本推来的详情），所以最新汇报、PR 状态、改动文件和命令计数都没读到。
        </Notice>
      </Section>
    );
  }
  const unavailable = o.process.state === 'unavailable' ? o.process.reason : undefined;
  return (
    <Section title="汇报与改动" data-task-summary>
      <div className="space-y-3">
        {unavailable ? (
          <Notice tone="stall" title="汇报、命令和改动文件没读到">
            <span className="break-words">{unavailable}</span>
          </Notice>
        ) : (
          <>
            <Report d={d} now={now} />
            <ProgressLine d={d} />
          </>
        )}
        <PrBars d={d} />
        <ChangedFiles d={d} />
      </div>
    </Section>
  );
}
