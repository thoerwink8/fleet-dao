// /france 页的「发版」卡（#1231）：主线最新提交和 CI、法国在用的提交、差几个（最近合进去的 PR）、最近做完的一个任务。
// 只读展示：每一行各自带「查成了 / 没查成 + 原因」，没查成的行写明原因，不拿空、0 或「已是最新」顶。
// 发布入口（#1255）：「发布到法国」按钮和弹窗放在「在用版本」那一行（ReleaseEntry，env-facts 的 versionExtra 挂上去），发版卡本身只读。
// 四行事实用 KeyValue（片 7，#1853）；提交号用 Tag，CI 状态用 StatusBadge。
import { useState } from 'react';
import { toast } from 'sonner';
import { errorText, useFranceRelease } from '../api/client';
import type { ReleaseCard } from '../api/types';
import { formatAgo } from '../lib/format';
import { cn } from '../lib/utils';
import { KeyValue } from './layout/key-value';
import { StatusBadge } from './layout/status-badge';
import { Tag } from './layout/tag';
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

/** 一行没查成：黄字写原因。 */
function Unread({ why }: { why: string }) {
  return (
    <p className="text-meta text-ink-stall" data-unreadable>
      没查成：{why}
    </p>
  );
}

function Sha({ short }: { short: string }) {
  return (
    <Tag mono className="num">
      {short}
    </Tag>
  );
}

type Ci = Extract<ReleaseCard['mainline'], { state: 'ok' }>['ci'];

function CiBadge({ ci }: { ci: Ci }) {
  const map = {
    green: { text: 'CI 绿', tone: 'done' },
    red: { text: 'CI 红', tone: 'fail' },
    pending: { text: 'CI 在跑', tone: 'stall' },
    unreadable: { text: 'CI 没查成', tone: 'stall' },
  } as const;
  const m = map[ci.state];
  return (
    <span data-ci={ci.state} className="shrink-0">
      <StatusBadge tone={m.tone} label={m.text} variant="outline" icon={false} />
    </span>
  );
}

/** 「发版」卡的四行事实（只读）。发布入口不在这里，在「在用版本」那一行（ReleaseEntry，#1255）。 */
export function ReleaseCardBody({ card, now }: { card: ReleaseCard; now: number }) {
  return <ReleaseRows card={card} now={now} />;
}

/**
 * 「在用版本」那一行里的发布入口（#1255，决定 0032：发版单位是主线提交）：写明落后主线几个提交、要发的主线头提交号和标题，
 * 下面是「发布到法国」按钮和它的弹窗（ReleaseAction）。读不到的那一项写没查成和原因，不拿「已是最新」顶。
 */
export function ReleaseEntry({ card, now }: { card: ReleaseCard; now: number }) {
  const { gap, mainline } = card;
  return (
    // 挂在「在用版本」那一行的灰字下面、和名字对齐（#1914 样板铺开）：一行差几个，一行要发的主线头，再下面按钮
    <div className="space-y-1.5" data-release-entry>
      {gap.state === 'ahead' ? (
        <p className="text-meta font-medium text-ink-stall" data-entry-gap="ahead">
          落后主线 {gap.count} 个提交
        </p>
      ) : gap.state === 'same' ? (
        <p className="text-meta font-medium text-ink-done" data-entry-gap="same">
          已是主线最新
        </p>
      ) : (
        <Unread why={gap.why} />
      )}
      {mainline.state === 'ok' ? (
        <p
          className="flex min-w-0 items-center gap-1.5 text-meta whitespace-nowrap"
          data-entry-head
          title={`要发的主线头 ${mainline.commit.short} ${mainline.commit.title}`}
        >
          <span className="shrink-0 text-muted-foreground">要发的主线头</span>
          <Sha short={mainline.commit.short} />
          <span className="min-w-0 truncate">{mainline.commit.title}</span>
        </p>
      ) : (
        <Unread why={mainline.why} />
      )}
      <ReleaseAction card={card} now={now} />
    </div>
  );
}

function ReleaseRows({ card, now }: { card: ReleaseCard; now: number }) {
  const { mainline, deployed, gap, lastDone } = card;
  return (
    <KeyValue
      items={[
        {
          label: '主线最新',
          value:
            mainline.state === 'unreadable' ? (
              <Unread why={mainline.why} />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <Sha short={mainline.commit.short} />
                  <CiBadge ci={mainline.ci} />
                </div>
                <p className="mt-1 break-words">{mainline.commit.title}</p>
                <p className="num text-meta text-muted-foreground">
                  {formatAgo(mainline.commit.at, now)}提交
                </p>
                {mainline.ci.state === 'red' || mainline.ci.state === 'pending' ? (
                  <p className="text-meta text-ink-stall">{mainline.ci.detail}</p>
                ) : null}
                {mainline.ci.state === 'unreadable' ? <Unread why={mainline.ci.why} /> : null}
              </>
            ),
        },
        {
          label: '法国在用',
          value:
            deployed.state === 'unreadable' ? (
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
                  <p className="num text-meta text-muted-foreground">
                    发于 {formatAgo(deployed.deployedAt, now)}
                  </p>
                ) : (
                  <Unread why={deployed.deployedAtWhy ?? '发于何时没读到'} />
                )}
              </>
            ),
        },
        {
          label: '差几个',
          value:
            gap.state === 'unreadable' ? (
              <Unread why={gap.why} />
            ) : gap.state === 'same' ? (
              <p className="font-medium text-ink-done" data-gap="same">
                法国已经是最新
              </p>
            ) : (
              <div data-gap="ahead">
                <p className="font-medium text-ink-stall">法国落后 {gap.count} 个提交</p>
                <ul className="mt-1 space-y-0.5 text-meta">
                  {gap.prs.map((p) => (
                    <li key={p.number} className="break-words">
                      <span className="num text-muted-foreground">#{p.number}</span> {p.title}
                    </li>
                  ))}
                </ul>
                {gap.nonPr > 0 ? (
                  <p className="mt-1 text-meta text-muted-foreground">
                    另有 {gap.nonPr} 个提交不是 PR 合并的
                  </p>
                ) : null}
              </div>
            ),
        },
        {
          label: '最近做完',
          value:
            lastDone.state === 'unreadable' ? (
              <Unread why={lastDone.why} />
            ) : (
              <>
                <p className="break-words">
                  <span className="num text-muted-foreground">PR #{lastDone.pr.number}</span>{' '}
                  {lastDone.pr.title}
                </p>
                <p className="num text-meta text-muted-foreground">
                  {formatAgo(lastDone.pr.mergedAt, now)}合并
                </p>
                {lastDone.issue.state === 'ok' ? (
                  <p className="mt-1 break-words text-meta">
                    关了 <span className="num text-muted-foreground">#{lastDone.issue.number}</span>{' '}
                    {lastDone.issue.title}
                    {lastDone.issue.alsoCloses.length > 0
                      ? `（还关了 ${lastDone.issue.alsoCloses.map((n) => `#${n}`).join('、')}）`
                      : ''}
                  </p>
                ) : lastDone.issue.state === 'none' ? (
                  <p className="mt-1 text-meta text-muted-foreground">这个 PR 没写关哪张单</p>
                ) : (
                  <p className="mt-1 text-meta text-ink-stall">
                    关的单 #{lastDone.issue.number} 没查成：{lastDone.issue.why}
                  </p>
                )}
              </>
            ),
        },
      ]}
    />
  );
}

type Last = ReleaseCard['action']['last'];

/** 最近一次点击的结果一句话：读不到写没查成 + 原因，不当成没点过。 */
function lastLine(last: Last, now: number): { text: string; tone: 'ok' | 'warn' | 'fail' | 'plain' } | null {
  const when = last.at ? `（${formatAgo(last.at, now)}）` : '';
  switch (last.state) {
    case 'none':
      return null;
    case 'pending':
      return { text: '发布请求已提交，等法国接活（接活后这里显示进度）', tone: 'warn' };
    case 'refused':
      return { text: `上一次被法国拒了${when}：${last.why ?? '（没写原因）'}。现场没动`, tone: 'fail' };
    case 'running':
      return { text: `发版在走：${last.phase ?? ''} · ${last.target ?? ''}${when}`, tone: 'warn' };
    case 'blocked':
      return { text: `发版卡住了：${last.phase ?? ''}${when}。${last.why ?? ''}`, tone: 'warn' };
    case 'failed':
      return { text: `发版没成：${last.phase ?? ''}${when}。${last.why ?? ''}`, tone: 'fail' };
    case 'done':
      return {
        text: `上一趟发完了：${last.target ?? ''}${when}。引擎总开关和接活开关已恢复到发版前的样子`,
        tone: 'ok',
      };
    case 'aborted':
      return { text: `上一趟被撤销了：${last.target ?? ''}${when}`, tone: 'plain' };
    case 'unreadable':
      return { text: `上一次的结果没查成：${last.why ?? ''}`, tone: 'warn' };
  }
}

/**
 * 「发布到法国」按钮（#1232）：点开弹窗写明要发的提交、CI 是绿的、会带上哪几个 PR、发完引擎总开关和接活开关恢复到发版前的样子（#1256）；点「确认发布」才发，
 * 后端核它等于此刻主线头、记操作记录、写请求文件，法国上 root 的单元接活。不能点（CI 不绿、已有发版在走、没装接活单元……）就置灰并写原因。
 */
function ReleaseAction({ card, now }: { card: ReleaseCard; now: number }) {
  const release = useFranceRelease();
  const [asking, setAsking] = useState(false);
  const { action, mainline, gap } = card;
  const head = mainline.state === 'ok' ? mainline.commit : null;
  const ready = action.state === 'ready' && head !== null;
  const last = lastLine(action.last, now);
  const confirm = () => {
    if (head === null) return;
    release.mutate(head.sha, {
      onSuccess: () => {
        setAsking(false);
        toast.success(`已提交发布请求：${head.short}`, {
          description: '法国接活后，这一行显示进度；发完引擎总开关和接活开关恢复到发版前的样子。',
        });
      },
      onError: (e) => {
        setAsking(false);
        toast.error('没能提交发布请求', { description: errorText(e) });
      },
    });
  };
  return (
    <div className="space-y-2" data-release-action={action.state}>
      <Button
        type="button"
        size="sm"
        disabled={!ready || release.isPending}
        onClick={() => setAsking(true)}
        aria-label="发布到法国"
      >
        {release.isPending ? '正在提交…' : '发布到法国'}
      </Button>
      {action.state === 'blocked' ? (
        <ul className="space-y-0.5 text-meta text-ink-stall" data-release-reasons>
          {action.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
      ) : null}
      {last ? (
        <p
          data-release-last={action.last.state}
          className={cn(
            'text-meta',
            last.tone === 'ok' && 'text-ink-done',
            last.tone === 'warn' && 'text-ink-stall',
            last.tone === 'fail' && 'text-ink-fail',
            last.tone === 'plain' && 'text-muted-foreground',
          )}
        >
          {last.text}
        </p>
      ) : null}
      <AlertDialog open={asking && head !== null} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>发布到法国？</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-body">
                <p>
                  要发的提交：
                  <Tag mono className="num">
                    {head?.short}
                  </Tag>{' '}
                  {head?.title}
                </p>
                <p className="text-ink-done">主线 CI 是绿的。</p>
                {gap.state === 'ahead' ? (
                  <div>
                    <p>会带上 {gap.count} 个提交，最近合进去的 PR：</p>
                    <ul className="mt-1 space-y-0.5 text-meta">
                      {gap.prs.map((p) => (
                        <li key={p.number}>
                          <span className="num text-muted-foreground">#{p.number}</span> {p.title}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                <p className="text-meta text-muted-foreground">
                  点「确认发布」就是同意对外发布，并记一条操作记录。法国会先暂停引擎总开关、等在跑的会话收尾（最多
                  13
                  分钟），再发版、验证；发完把引擎总开关和接活开关恢复到发版前的样子（发前开着的开回，发前关着的保持关）。
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                confirm();
              }}
            >
              确认发布
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
