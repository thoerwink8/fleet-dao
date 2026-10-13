// /france 页的「发版」卡（#1231）：主线最新提交和 CI、法国在用的提交、差几个（最近合进去的 PR）、最近做完的一个任务。
// 只读展示：每一行各自带「查成了 / 没查成 + 原因」，没查成的行写明原因，不拿空、0 或「已是最新」顶。
// 发布入口（#1255）：「发布到法国」按钮和弹窗放在「在用版本」那一行（ReleaseEntry，env-facts 的 versionExtra 挂上去），发版卡本身只读。
// 四行事实用 KeyValue（片 7，#1853）；提交号用 Tag，CI 状态用 StatusBadge。
import { type ReactNode, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { SESSION_WAIT_MS } from '../../../../deploy/france/release-request/session-wait.mjs';
import { errorText, useFrancePreflight, useFranceRelease } from '../api/client';
import type { ReleaseCard } from '../api/types';
import { formatAgo } from '../lib/format';
import { checkLine, lastLine, preflightItems, stepRows, timelineHead } from '../lib/release-timeline';
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

const STEP_TONE = {
  done: { tone: 'done', label: '走过' },
  current: { tone: 'run', label: '在走' },
  blocked: { tone: 'stall', label: '卡住' },
  failed: { tone: 'fail', label: '没成' },
  todo: { tone: 'stop', label: '没到' },
} as const;

/** 九步时间线（#2026）：第几步、在等什么、已用多久；数据来自法国的 release-train.json。 */
function ReleaseTimeline({ last, now }: { last: Last; now: number }) {
  const timeline = last.timeline;
  if (!timeline) return null;
  const rows = stepRows(timeline, last.state, last.why, now);
  return (
    <div className="space-y-1.5" data-release-timeline={last.state}>
      <p className="num text-meta font-medium" data-timeline-head>
        {timelineHead(timeline, last.state, now)}
      </p>
      <ol className="space-y-1 text-meta">
        {rows.map((r) => (
          <li
            key={r.index}
            data-step={r.index}
            data-step-state={r.state}
            className={cn('flex min-w-0 items-start gap-2', r.state === 'todo' && 'text-muted-foreground')}
          >
            <span className="w-14 shrink-0">
              <StatusBadge tone={STEP_TONE[r.state].tone} label={STEP_TONE[r.state].label} variant="dot" />
            </span>
            <span className="num w-6 shrink-0 text-muted-foreground">{r.index}</span>
            <span className="w-16 shrink-0 font-medium">{r.name}</span>
            <span className="min-w-0 break-words">{r.text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 发后体检（#2026）：「通过」或「没通过：哪几项」，下面每项一行。 */
function ReleaseCheck({ check }: { check: NonNullable<Last['check']> }) {
  const line = checkLine(check);
  return (
    <div className="space-y-1" data-release-check={line.ok ? 'ok' : 'bad'}>
      <p className={cn('text-meta font-medium', line.ok ? 'text-ink-done' : 'text-ink-fail')}>{line.text}</p>
      <ul className="space-y-0.5 text-meta">
        {check.items.map((x) => (
          <li key={x.name} className="flex min-w-0 items-start gap-2" data-check-item={x.ok ? 'ok' : 'bad'}>
            <span className="shrink-0">
              <StatusBadge tone={x.ok ? 'done' : 'fail'} label={x.ok ? '通过' : '没过'} variant="dot" />
            </span>
            <span className="shrink-0 font-medium">{x.name}</span>
            <span className="min-w-0 break-words text-muted-foreground">{x.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const PREFLIGHT_TONE = {
  ok: { tone: 'done', label: '通过' },
  block: { tone: 'fail', label: '卡住' },
  info: { tone: 'wait', label: '留意' },
} as const;

/** 确认框里的预检清单（#2026）：打开框时现读一遍；有卡住项、没读到、没跑成，确认键灰着并写哪项。 */
function preflightView(preflight: ReturnType<typeof useFrancePreflight>): {
  node: ReactNode;
  blockedWhy: string | null;
} {
  const result = preflight.data;
  if (preflight.isPending || (!result && !preflight.isError)) {
    return {
      node: <p className="text-meta text-muted-foreground">预检在跑（只读，不暂停、不发版）…</p>,
      blockedWhy: '预检还没跑完',
    };
  }
  if (preflight.isError) {
    const why = `预检没跑成：${errorText(preflight.error)}`;
    return { node: <p className="text-meta text-ink-fail">{why}</p>, blockedWhy: why };
  }
  if (!result) return { node: null, blockedWhy: '预检还没跑完' };
  if (result.state === 'unreadable') {
    const why = `预检没查成：${result.why}`;
    return { node: <p className="text-meta text-ink-stall">{why}</p>, blockedWhy: why };
  }
  const items = preflightItems(result.stdout);
  const blocks = items.filter((i) => i.kind === 'block');
  const blockedWhy =
    items.length === 0
      ? '预检没给出清单'
      : blocks.length > 0 || result.code !== 0
        ? `有 ${blocks.length} 项卡住，确认键先灰着：${blocks.map((b) => b.text).join('；')}`
        : null;
  return {
    node: (
      <ul className="space-y-1 text-meta" data-preflight-list>
        {items.map((i) => (
          <li key={i.text} className="flex min-w-0 items-start gap-2" data-preflight-item={i.kind}>
            <span className="shrink-0">
              <StatusBadge
                tone={PREFLIGHT_TONE[i.kind].tone}
                label={PREFLIGHT_TONE[i.kind].label}
                variant="dot"
              />
            </span>
            <span className="min-w-0 break-words">{i.text}</span>
          </li>
        ))}
      </ul>
    ),
    blockedWhy,
  };
}

/**
 * 「发布到法国」按钮（#1232）：点开弹窗先现跑一遍预检、清单摆在框里（#2026），写明要发的提交、会带上哪几个 PR、发完引擎总开关恢复到发版前；
 * 预检有卡住项时「确认发布」灰着并写哪项。点「确认发布」才发：后端核它等于此刻主线头、记操作记录、写请求文件，法国上 root 的单元接活。
 * 不能点（CI 不绿、已有发版在走、没装接活单元……）就置灰并写原因。发版在走、卡住、没成时下面画九步时间线；做完了写发后体检结论。
 */
function ReleaseAction({ card, now }: { card: ReleaseCard; now: number }) {
  const release = useFranceRelease();
  const preflight = useFrancePreflight();
  const [asking, setAsking] = useState(false);
  const { action, mainline, gap } = card;
  const head = mainline.state === 'ok' ? mainline.commit : null;
  const ready = action.state === 'ready' && head !== null;
  const last = lastLine(action.last, now);
  const pf = preflightView(preflight);
  const { mutate: runPreflight } = preflight;
  // 框一打开就现跑一遍预检（只读）：确认之前该看的都摆在框里
  useEffect(() => {
    if (asking) runPreflight();
  }, [asking, runPreflight]);
  // 确认框等它：成功框关、弹成功；失败弹 toast 并抛给框——框留着写原因、能再点（#2009）
  const confirm = async () => {
    if (head === null) return;
    try {
      await release.mutateAsync(head.sha);
      toast.success(`已提交发布请求：${head.short}`, {
        description: '法国接活后，这一行显示九步进度；发完引擎总开关恢复到发版前，再做发后体检。',
      });
    } catch (e) {
      toast.error('没能提交发布请求', { description: errorText(e) });
      throw e;
    }
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
      {action.last.state === 'running' ||
      action.last.state === 'blocked' ||
      action.last.state === 'failed' ? (
        <ReleaseTimeline last={action.last} now={now} />
      ) : null}
      {action.last.check ? <ReleaseCheck check={action.last.check} /> : null}
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
                <div className="space-y-1.5" data-release-preflight>
                  <div className="flex items-center gap-2">
                    <p className="font-medium">预检（打开这个框时现读的）</p>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="ml-auto"
                      loading={preflight.isPending}
                      loadingText="预检在跑…"
                      onClick={() => preflight.mutate()}
                    >
                      重新预检
                    </Button>
                  </div>
                  {pf.node}
                  {pf.blockedWhy !== null && !preflight.isPending ? (
                    <p className="text-meta text-ink-stall" data-preflight-blocked>
                      {pf.blockedWhy}
                    </p>
                  ) : null}
                </div>
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
                  点「确认发布」就是同意对外发布，并记一条操作记录。之后全自动：法国先暂停引擎总开关、等在跑的会话收尾（最多{' '}
                  {SESSION_WAIT_MS / 60_000}{' '}
                  分钟），再发版；发完把引擎总开关恢复到发版前（发前开着的开回，发前关着的保持关），各仓「让
                  AI 接活」开关发版不动；最后做发后体检。开始、成功、卡住、失败各推飞书一条。
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction
              onConfirm={confirm}
              loadingLabel="正在提交发布请求"
              disabled={pf.blockedWhy !== null}
              title={pf.blockedWhy ?? undefined}
            >
              确认发布
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
