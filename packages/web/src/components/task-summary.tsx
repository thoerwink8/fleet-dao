// 任务页的概览（#3140，#3509 起拆进页签）：最新汇报页签（结论、命令计数）、页头里的 PR 列表、改动文件页签。
// 数都是后端放在任务详情 overview 里的（packages/api/src/task-overview.ts）：改动的文件和增删行来自按 PR 头记的 numstat，
// 不是把每次编辑的行数加起来。读不到的写「没读到」和原因：老后端没给 overview、会话内容读不到、没记过这个 PR 的文件，
// 各写各的，不画 0。
import { useState } from 'react';
import type { TaskDetail, TaskPr } from '../api/types';
import { formatAgo } from '../lib/format';
import { segmentLabel, UNKNOWN_SEGMENT } from '../lib/segments';
import { fileParts, PR_STATE, runOrder } from '../lib/task-process';
import type { StatusKey } from '../theme/status-dict';
import { Clamped } from './call-row';
import { DiffStat } from './diff-stat';
import { Button } from './layout/button';
import { EmptyState } from './layout/empty-state';
import { Notice } from './layout/notice';
import { Stack } from './layout/stack';
import { LevelDot, StatusBadge } from './layout/status-badge';
import { Table } from './layout/table';
import { Tag } from './layout/tag';
import { Text } from './layout/text';
import { RepoLink } from './repo-link';

/** 改动卡默认露几个文件；PR 列表默认露几条。 */
export const FILES_SHOWN = 3;
export const PRS_SHOWN = 3;

type Overview = NonNullable<TaskDetail['overview']>;
type PrFiles = Extract<TaskPr['files'], { state: 'ok' }>;
type PrFile = PrFiles['items'][number];

const PR_STATUS: Record<TaskPr['state'], StatusKey> = {
  merged: 'task:pr:merged',
  open: 'task:pr:open',
  failed: 'task:pr:failed',
  closed: 'task:pr:closed',
  unknown: 'task:pr:unknown',
};

/** 最新汇报：最近一笔动手的最后一句话；没有写原因，读不到另说。 */
function Report({ o }: { o: Overview }) {
  const r = o.report;
  if (r.state === 'unavailable') {
    return (
      <Notice tone="stall" title="最新汇报没读到">
        {r.reason}
      </Notice>
    );
  }
  if (r.state === 'none') {
    return (
      <span data-report-missing>
        <Text tone="muted">没有汇报：{r.reason}</Text>
      </span>
    );
  }
  return (
    <div data-task-report>
      <Clamped text={r.text} variant="body" />
    </div>
  );
}

/** 「最新汇报」后面一句（照设计稿）：第几笔 · 段 · 模型 · 多久前；没有汇报不写。 */
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

/** 进度一行：N 个命令已完成，M 个失败；在跑的是一个小圆点加字；只有失败数标红。 */
function ProgressLine({ o }: { o: Overview }) {
  const t = o.tally;
  if (t.state === 'unavailable') {
    return (
      <Notice tone="stall" title="命令计数没读到">
        {t.reason}
      </Notice>
    );
  }
  const c = t.total;
  if (c.entries === 0) {
    return (
      <span data-progress-line>
        <Text size="meta" tone="muted">
          这张单还没有会话记录，没有命令和改动可数
        </Text>
      </span>
    );
  }
  return (
    <div data-progress-line>
      <Stack direction="horizontal" gap="md" align="center" wrap>
        <span>
          <Text>{c.commandsDone} 个命令已完成</Text>
          {c.commandsFailed > 0 ? (
            <>
              <Text>，</Text>
              <Text tone="danger" strong>
                {c.commandsFailed} 个失败
              </Text>
            </>
          ) : null}
        </span>
        {c.commandsRunning > 0 ? (
          <Stack direction="horizontal" gap="sm" align="center">
            <LevelDot level="processing" />
            <Text>{c.commandsRunning} 个正在运行</Text>
          </Stack>
        ) : null}
        {c.commandsUnknown > 0 ? (
          <Text
            size="meta"
            tone="muted"
            title="有调用、没有记下结果：老记录没调用号对不上、笔收场了结果没记、Mirasim 的流里没有退出码"
          >
            另有 {c.commandsUnknown} 个结果未知
          </Text>
        ) : null}
        {c.reads > 0 ? (
          <Text size="meta" tone="muted">
            读了 {c.reads} 次文件
          </Text>
        ) : null}
      </Stack>
    </div>
  );
}

/** 最新汇报页签：汇报、命令计数、「看全部过程」。onShowProcess：切到「过程」页签。 */
export function TaskSummary({
  d,
  now,
  onShowProcess,
}: {
  d: TaskDetail;
  now: number;
  onShowProcess: () => void;
}) {
  const o = d.overview;
  if (!o) {
    return (
      <div data-task-summary>
        <Notice tone="info">
          这台后端还没有任务概览（老版本推来的详情），所以最新汇报、PR 状态、改动文件和命令计数都没读到。
        </Notice>
      </div>
    );
  }
  const meta = reportMeta(d, o, now);
  return (
    <div data-task-summary>
      <Stack gap="md">
        <Report o={o} />
        {meta ? (
          <Text size="meta" tone="muted">
            {meta}
          </Text>
        ) : null}
        <ProgressLine o={o} />
        <Stack direction="horizontal" gap="md" align="center">
          <Button size="xs" variant="text" onClick={onShowProcess}>
            看全部过程
          </Button>
        </Stack>
      </Stack>
    </div>
  );
}

/** 一个 PR 一行：号、分支、状态（页头「PR」那一项）。悬停写后端的备注或这个状态的说明。 */
function PrRow({ pr, repo }: { pr: TaskPr; repo: TaskDetail['repo'] }) {
  // 悬停话：后端的备注优先，其次这个状态自带的一句
  const hint = pr.note ?? PR_STATE[pr.state].hint;
  return (
    <div data-pr={pr.number} data-pr-state={pr.state}>
      <Stack direction="horizontal" gap="md" align="center" wrap>
        <RepoLink repo={repo} kind="pull" n={pr.number}>
          PR #{pr.number}
        </RepoLink>
        {pr.branch ? (
          <Text mono tone="muted" title={pr.branch}>
            {pr.branch}
          </Text>
        ) : null}
        <StatusBadge status={PR_STATUS[pr.state]} {...(hint ? { title: hint } : {})} />
      </Stack>
    </div>
  );
}

/** 页头里的 PR 列表：号、分支、状态；超过 3 个只展开 3 个，其余点「还有 N 个 PR」。没有 PR 返回 null。 */
export function TaskPrs({ d }: { d: TaskDetail }) {
  const [all, setAll] = useState(false);
  const prs = d.overview?.prs ?? [];
  if (prs.length === 0) return null;
  const shown = all ? prs : prs.slice(0, PRS_SHOWN);
  return (
    <div data-pr-bars>
      <Stack gap="sm">
        {shown.map((pr) => (
          <PrRow key={pr.number} pr={pr} repo={d.repo} />
        ))}
        {prs.length > PRS_SHOWN ? (
          <Stack direction="horizontal" gap="sm">
            <Button size="xs" variant="text" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? '收起' : `还有 ${prs.length - PRS_SHOWN} 个 PR`}
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </div>
  );
}

function FileName({ file }: { file: PrFile }) {
  const { dir, base } = fileParts(file.path);
  return (
    <span data-file={file.path} title={file.path}>
      <Text mono tone="muted">
        {dir}
      </Text>
      <Text mono>{base}</Text>
    </span>
  );
}

/** 一个 PR 的「已编辑 N 个文件 +x -y」：每个文件一行，只露前 3 个，其余点开；二进制写「二进制」，不写 +0 -0。 */
function ChangedFiles({ pr, files, repo }: { pr: TaskPr; files: PrFiles; repo: TaskDetail['repo'] }) {
  const [all, setAll] = useState(false);
  const items = files.items;
  const counted = items.filter((f) => f.added !== null || f.removed !== null);
  const added = counted.reduce((n, f) => n + (f.added ?? 0), 0);
  const removed = counted.reduce((n, f) => n + (f.removed ?? 0), 0);
  const shown = all ? items : items.slice(0, FILES_SHOWN);
  return (
    <div data-changed-files data-changed-pr={pr.number}>
      <Stack gap="md">
        <Stack direction="horizontal" gap="md" align="center" wrap>
          <RepoLink repo={repo} kind="pull" n={pr.number}>
            PR #{pr.number}
          </RepoLink>
          <Text strong>已编辑 {items.length} 个文件</Text>
          {counted.length > 0 ? (
            <Text size="meta" tone="muted">
              <DiffStat added={added} removed={removed} />
              {counted.length < items.length ? '（合计不含二进制）' : ''}
            </Text>
          ) : null}
          {files.current === false ? (
            <span
              data-files-stale
              title={`记下的是提交 ${files.headSha.slice(0, 7)} 的改动，PR 现在的头已经变了，数字可能落后`}
            >
              <Tag tone="warning">不是 PR 最新的头</Tag>
            </span>
          ) : null}
        </Stack>
        {items.length === 0 ? (
          <Text tone="muted">这个头相对主线没有改动文件</Text>
        ) : (
          <Table<PrFile>
            caption={`PR #${pr.number} 的改动文件`}
            rowKey="path"
            rows={shown}
            columns={[
              { key: 'path', title: '文件', render: (_v, f) => <FileName file={f} /> },
              {
                key: 'added',
                title: '增',
                align: 'right',
                render: (_v, f) =>
                  f.binary ? (
                    <Text size="meta" tone="muted" title="二进制文件，git 不给行数">
                      二进制
                    </Text>
                  ) : f.added === null ? (
                    <Text tone="muted">—</Text>
                  ) : (
                    <Text>+{f.added}</Text>
                  ),
              },
              {
                key: 'removed',
                title: '删',
                align: 'right',
                render: (_v, f) =>
                  f.binary || f.removed === null ? '' : <Text tone="muted">-{f.removed}</Text>,
              },
            ]}
          />
        )}
        {items.length > FILES_SHOWN ? (
          <Stack direction="horizontal" gap="sm">
            <Button size="xs" variant="text" aria-expanded={all} onClick={() => setAll((v) => !v)}>
              {all ? '收起' : `还有 ${items.length - FILES_SHOWN} 个文件`}
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </div>
  );
}

/** 改动文件页签：每个 PR 一张表；没记过、读不到的 PR 各写一行原因；没有 PR 写没有。 */
export function TaskChangedFiles({ d }: { d: TaskDetail }) {
  const o = d.overview;
  if (!o) {
    return (
      <Notice tone="info">这台后端还没有任务概览（老版本推来的详情），所以 PR 的改动文件没读到。</Notice>
    );
  }
  if (o.prs.length === 0) {
    return (
      <EmptyState
        size="inline"
        title="这张单还没有关联的 PR"
        hint="推了分支、开了 PR 以后，改了哪些文件记在这里"
      />
    );
  }
  // 新的 PR 在前
  const prs = [...o.prs].sort((a, b) => b.number - a.number);
  return (
    <div data-changed-block>
      <Stack gap="xl">
        {prs.map((pr) =>
          pr.files.state === 'ok' ? (
            <ChangedFiles key={pr.number} pr={pr} files={pr.files} repo={d.repo} />
          ) : (
            <span key={pr.number} data-changed-unread={pr.number}>
              <Text size="meta" tone={pr.files.state === 'unavailable' ? 'warning' : 'muted'}>
                PR #{pr.number} 的改动文件没读到：{pr.files.reason}
              </Text>
            </span>
          ),
        )}
        <Text size="meta" tone="muted">
          只记文件和增删数，不存 diff 正文；完整 diff 在 GitHub 的「Files changed」里。
        </Text>
      </Stack>
    </div>
  );
}
