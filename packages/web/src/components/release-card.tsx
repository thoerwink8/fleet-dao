// /france 页的「发版」卡（#1231）：主线最新提交和 CI、法国在用的提交、差几个（最近合进去的 PR）、最近做完的一个任务。
// 只读展示：每一行各自带「查成了 / 没查成 + 原因」，没查成的行写明原因，不拿空、0 或「已是最新」顶。
import type { ReactNode } from 'react';
import type { ReleaseCard } from '../api/types';
import { formatAgo } from '../lib/format';
import { cn } from '../lib/utils';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3 py-2.5 first:pt-0 last:pb-0">
      <dt className="pt-px text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** 一行没查成：黄字写原因。 */
function Unread({ why }: { why: string }) {
  return (
    <p className="text-xs text-ink-stall" data-unreadable>
      没查成：{why}
    </p>
  );
}

function Sha({ short }: { short: string }) {
  return <span className="num rounded bg-muted px-1.5 py-0.5 text-xs">{short}</span>;
}

type Ci = Extract<ReleaseCard['mainline'], { state: 'ok' }>['ci'];

function CiBadge({ ci }: { ci: Ci }) {
  const map = {
    green: { text: 'CI 绿', cls: 'border-st-done/40 bg-st-done/10 text-ink-done' },
    red: { text: 'CI 红', cls: 'border-st-fail/40 bg-st-fail/10 text-ink-fail' },
    pending: { text: 'CI 在跑', cls: 'border-st-stall/40 bg-st-stall/10 text-ink-stall' },
    unreadable: { text: 'CI 没查成', cls: 'border-st-stall/40 bg-st-stall/10 text-ink-stall' },
  } as const;
  const m = map[ci.state];
  return (
    <span
      data-ci={ci.state}
      className={cn('shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium', m.cls)}
    >
      {m.text}
    </span>
  );
}

export function ReleaseCardBody({ card, now }: { card: ReleaseCard; now: number }) {
  const { mainline, deployed, gap, lastDone } = card;
  return (
    <dl className="divide-y">
      <Row label="主线最新">
        {mainline.state === 'unreadable' ? (
          <Unread why={mainline.why} />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Sha short={mainline.commit.short} />
              <CiBadge ci={mainline.ci} />
            </div>
            <p className="mt-1 break-words">{mainline.commit.title}</p>
            <p className="num text-xs text-muted-foreground">{formatAgo(mainline.commit.at, now)}提交</p>
            {mainline.ci.state === 'red' || mainline.ci.state === 'pending' ? (
              <p className="text-xs text-ink-stall">{mainline.ci.detail}</p>
            ) : null}
            {mainline.ci.state === 'unreadable' ? <Unread why={mainline.ci.why} /> : null}
          </>
        )}
      </Row>
      <Row label="法国在用">
        {deployed.state === 'unreadable' ? (
          <Unread why={deployed.why} />
        ) : (
          <>
            <Sha short={deployed.short} />
            {deployed.title !== null ? (
              <p className="mt-1 break-words">{deployed.title}</p>
            ) : (
              <Unread why={deployed.titleWhy ?? '标题没读到'} />
            )}
            {deployed.deployedAt !== null ? (
              <p className="num text-xs text-muted-foreground">发于 {formatAgo(deployed.deployedAt, now)}</p>
            ) : (
              <Unread why={deployed.deployedAtWhy ?? '发于何时没读到'} />
            )}
          </>
        )}
      </Row>
      <Row label="差几个">
        {gap.state === 'unreadable' ? (
          <Unread why={gap.why} />
        ) : gap.state === 'same' ? (
          <p className="font-medium text-ink-done" data-gap="same">
            法国已经是最新
          </p>
        ) : (
          <div data-gap="ahead">
            <p className="font-medium text-ink-stall">法国落后 {gap.count} 个提交</p>
            <ul className="mt-1 space-y-0.5 text-xs">
              {gap.prs.map((p) => (
                <li key={p.number} className="break-words">
                  <span className="num text-muted-foreground">#{p.number}</span> {p.title}
                </li>
              ))}
            </ul>
            {gap.nonPr > 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">另有 {gap.nonPr} 个提交不是 PR 合并的</p>
            ) : null}
          </div>
        )}
      </Row>
      <Row label="最近做完">
        {lastDone.state === 'unreadable' ? (
          <Unread why={lastDone.why} />
        ) : (
          <>
            <p className="break-words">
              <span className="num text-muted-foreground">PR #{lastDone.pr.number}</span> {lastDone.pr.title}
            </p>
            <p className="num text-xs text-muted-foreground">{formatAgo(lastDone.pr.mergedAt, now)}合并</p>
            {lastDone.issue.state === 'ok' ? (
              <p className="mt-1 break-words text-xs">
                关了 <span className="num text-muted-foreground">#{lastDone.issue.number}</span>{' '}
                {lastDone.issue.title}
                {lastDone.issue.alsoCloses.length > 0
                  ? `（还关了 ${lastDone.issue.alsoCloses.map((n) => `#${n}`).join('、')}）`
                  : ''}
              </p>
            ) : lastDone.issue.state === 'none' ? (
              <p className="mt-1 text-xs text-muted-foreground">这个 PR 没写关哪张单</p>
            ) : (
              <p className="mt-1 text-xs text-ink-stall">
                关的单 #{lastDone.issue.number} 没查成：{lastDone.issue.why}
              </p>
            )}
          </>
        )}
      </Row>
    </dl>
  );
}
