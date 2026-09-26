// 登录页 A「门后就是驾驶舱」：登录页背后就是真驾驶舱在跑（演示数据），蒙一层磨砂；
// 登录只是贴在上面的一小块。登录成功，磨砂散开、落进同一个画面。

import { KeyRound, LoaderCircle, Send } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { useBoard, useMe } from '../api/client';
import type { Board } from '../api/types';
import { BoardTree } from '../board/board-tree';
import { LogoMark } from '../components/logo';
import { useRepo } from '../components/repo-context';
import { SidebarNav } from '../components/shell/sidebar';
import { Topbar } from '../components/shell/topbar';
import { StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { Skeleton } from '../components/ui/skeleton';
import { useIsMobile } from '../lib/hooks';
import { taskTone } from '../lib/status';
import { cn } from '../lib/utils';
import { DemoLink, pause, ThemeToggle } from './bits';
import { ConfigNote, DevLoginForm, type LoginFlow, MockHint, PasswordForm, useLoginFlow } from './flow';
import { Showcase } from './showcase';

const BoardCanvas = lazy(() => import('../board/board-canvas').then((m) => ({ default: m.BoardCanvas })));

const noop = () => {};

/**
 * 挑几张最热闹的需求放上看板（在跑的、等拍板的优先），挑一次就不再换：看板只在换仓时重新取景，
 * 换来换去的话卡片会跑出视野。全放上去的话桌面上要缩到最远一级，卡上只剩编号，看不出在干什么。
 */
function useFeatured(board: Board | undefined, n: number): Board | undefined {
  const ids = useRef<string[] | null>(null);
  if (!board) return undefined;
  if (!ids.current) {
    const rank = (t: Board['tasks'][number]) =>
      ({ human: 0, run: 1, stall: 2, wait: 3, done: 4 })[taskTone(t) as 'run'] ?? 5;
    ids.current = [...board.tasks]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, n)
      .map((t) => t.id);
  }
  const keep = new Set(ids.current);
  return { ...board, tasks: board.tasks.filter((t) => keep.has(t.id)) };
}

/** 门后：和登录后一模一样的外壳和看板，只是数据是演示的。 */
function Cockpit() {
  const isMobile = useIsMobile();
  const { repoId } = useRepo();
  const board = useBoard(repoId);
  const { data: me } = useMe();
  const featured = useFeatured(board.data, isMobile ? 6 : 2);
  return (
    <div className="flex h-full w-full bg-background">
      <aside className="hidden w-[232px] shrink-0 border-r bg-panel md:block">
        <SidebarNav />
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar onMenu={noop} onSearch={noop} />
        <main className="relative min-h-0 flex-1 overflow-hidden">
          {!featured ? (
            <div className="grid h-full place-items-center">
              <Skeleton className="h-40 w-64 rounded-xl" />
            </div>
          ) : isMobile ? (
            <BoardTree board={featured} me={me} filter={{ stuck: false, mine: false }} onFilter={noop} />
          ) : (
            <Suspense fallback={null}>
              <BoardCanvas board={featured} me={me} />
            </Suspense>
          )}
        </main>
      </div>
    </div>
  );
}

/** 卡片上的一行「此刻」：从门后那块看板上数出来的。 */
function NowLine() {
  const { repoId } = useRepo();
  const board = useBoard(repoId);
  const tasks = board.data?.tasks ?? [];
  const run = tasks.filter((t) => taskTone(t) === 'run').length;
  const human = tasks.filter((t) => taskTone(t) === 'human').length;
  const done = tasks.filter((t) => taskTone(t) === 'done').length;
  if (!board.data) return <div className="h-5" />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone="run" className="fd-dot-live" />
        <span className="num text-foreground">{run}</span> 个在跑
      </span>
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone="human" />
        <span className="num text-foreground">{human}</span> 个等你拍板
      </span>
      <span className="inline-flex items-center gap-1.5">
        <StatusDot tone="done" />
        <span className="num text-foreground">{done}</span> 个做完
      </span>
    </div>
  );
}

function Card({ flow, entering }: { flow: LoginFlow; entering: boolean }) {
  const [mode, setMode] = useState<'choose' | 'password'>('choose');
  return (
    <section
      aria-label="登录"
      className={cn(
        'pointer-events-auto w-full border bg-popover/92 shadow-[0_24px_64px_-24px_var(--shadow-color)] backdrop-blur-xl transition-[opacity,transform] duration-500',
        'rounded-t-3xl border-b-0 px-5 pt-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]',
        'md:max-w-[380px] md:rounded-2xl md:border-b md:p-6',
        entering && 'pointer-events-none translate-y-3 opacity-0',
      )}
    >
      <div className="flex items-start gap-3">
        <LogoMark className="size-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <h1 className="text-lg leading-tight font-semibold tracking-tight">门后就是驾驶舱</h1>
          <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
            身后这块正在跑：一群 AI 自己接需求、拆任务、写码、跑测试、合进主线。登录进去就是这个画面。
          </p>
        </div>
        <ThemeToggle className="-mt-1 -mr-1 shrink-0" />
      </div>
      <div className="mt-3">
        <NowLine />
      </div>

      {mode === 'choose' ? (
        <div className="mt-4 grid gap-2">
          <Button
            className="h-11 w-full text-[15px]"
            disabled={!flow.feishuReady || flow.busy !== null}
            onClick={flow.feishu}
          >
            {flow.busy === 'feishu' ? <LoaderCircle className="animate-spin" /> : <Send />}
            {flow.busy === 'feishu' ? '正在用飞书登录…' : '用飞书登录'}
          </Button>
          {flow.passwordEnabled ? (
            <Button
              variant="outline"
              className="h-11 w-full text-[15px]"
              disabled={flow.busy !== null}
              onClick={() => {
                flow.clearError();
                setMode('password');
              }}
            >
              <KeyRound />
              用户名密码登录
            </Button>
          ) : null}
          <ConfigNote flow={flow} className="text-center" />
        </div>
      ) : (
        <PasswordForm
          flow={flow}
          className="mt-4"
          onCancel={() => {
            flow.clearError();
            setMode('choose');
          }}
          hint={<MockHint flow={flow} />}
        />
      )}
      {mode === 'choose' && flow.error ? (
        <p role="alert" className="mt-2 text-sm text-ink-fail">
          {flow.error.text}
        </p>
      ) : null}
      <DevLoginForm flow={flow} className="mt-3" />

      <div className="mt-4 flex items-center justify-between gap-3 border-t pt-3">
        <DemoLink />
        <span className="text-[11px] text-faint">身后是演示数据</span>
      </div>
    </section>
  );
}

export function DoorLogin({ next }: { next: string }) {
  const [entering, setEntering] = useState(false);
  const flow = useLoginFlow(next, async () => {
    setEntering(true);
    await pause(650);
  });
  return (
    <main className="relative h-dvh overflow-hidden bg-background">
      {/* 门后和卡片上的「此刻」读同一份演示数据；登录本身（flow）走外面那套真的 FleetApi。 */}
      <Showcase>
        {/* 门后：真组件跑演示数据。只给看，不能点（inert）。 */}
        <div
          inert
          aria-hidden
          className={cn(
            'absolute inset-0 transition-transform duration-700 ease-out',
            entering ? 'scale-100' : 'scale-[1.02]',
          )}
        >
          <Cockpit />
        </div>
        {/* 磨砂：登录成功时淡掉。 */}
        <div
          aria-hidden
          className={cn(
            // 磨砂只蒙在卡片周围（遮罩从卡片往外淡掉），远处的看板照样看得清在动。
            'pointer-events-none absolute inset-0 bg-background/45 backdrop-blur-md transition-opacity duration-700',
            '[mask-image:linear-gradient(to_top,black_42%,transparent_78%)]',
            'md:[mask-image:radial-gradient(ellipse_34%_46%_at_50%_50%,black_55%,transparent_100%)]',
            entering && 'opacity-0',
          )}
        />
        <div className="pointer-events-none absolute inset-0 flex items-end justify-center md:items-center md:p-6">
          <Card flow={flow} entering={entering} />
        </div>
      </Showcase>
    </main>
  );
}
