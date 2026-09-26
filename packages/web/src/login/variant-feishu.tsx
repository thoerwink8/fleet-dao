// 登录页 D「飞书蓝」：飞书网页版那种设计语言（中性灰底、白卡片、蓝色主按钮、小圆角）。
// 登录面板像飞书客户端：电脑上左边飞书扫码、右边账号密码，同时摆出来不切换；手机上一个大的「用飞书登录」，
// 下面直接是账号密码。整页底图是点阵上漂着的真实流程节点（design 第五节：收单 → 分诊 → 拍板期 → 写码 → 验证 → 合并）。
// 左边是驾驶舱真组件跑演示数据。配色是主题里的一套（飞书蓝），登录后切到同一套，前后长得一致。品牌仍是驾驶舱自己的。
// 草稿：扫码框先是占位，正式版接飞书的网页扫码 SDK（二维码是飞书自己的 iframe）。

import { LoaderCircle, MessageCircleQuestion, QrCode, Send } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';
import { useMe, useNotifications } from '../api/client';
import { LogoMark } from '../components/logo';
import { StatusChip, StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { formatAgo } from '../lib/format';
import { useIsMobile, useNow } from '../lib/hooks';
import type { Tone } from '../lib/status';
import { cn } from '../lib/utils';
import { DemoLink, PaletteScope, pause, ThemeToggle } from './bits';
import { ConfigNote, DevLoginForm, type LoginFlow, MockHint, PasswordForm, useLoginFlow } from './flow';
import { Showcase } from './showcase';

const enter = (i: number): CSSProperties => ({ animationDelay: `${80 + i * 90}ms` });

/** 底图：点阵上漂着流程图的几个节点和连线。原话照 design 第五节。 */
// 只在留白处漂：左右两边的空当和最底下一条；标题、副标题那块不放（卡片是不透明的，漂到下面会被盖住）。
// 前七个按流程顺序连线，后两个不连。坐标是顶栏以下那块的百分比。
const NODES: { label: string; tone: Tone; x: number; y: number }[] = [
  { label: '收单', tone: 'wait', x: 5.5, y: 52 },
  { label: '分诊', tone: 'run', x: 16, y: 95 },
  { label: '拍板期', tone: 'human', x: 33, y: 97 },
  { label: '写码', tone: 'run', x: 50, y: 95 },
  { label: '验证', tone: 'run', x: 67, y: 97 },
  { label: '合并', tone: 'done', x: 84, y: 95 },
  { label: '收尾', tone: 'done', x: 94.5, y: 60 },
  { label: '规划', tone: 'run', x: 94.5, y: 24 },
  { label: '要人拍吗', tone: 'human', x: 5.5, y: 20 },
];
const TONE_VAR: Record<Tone, string> = {
  run: 'var(--st-run)',
  wait: 'var(--st-wait)',
  human: 'var(--st-human)',
  stall: 'var(--st-stall)',
  fail: 'var(--st-fail)',
  done: 'var(--st-done)',
  stop: 'var(--st-stop)',
};

function Backdrop() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-14 bottom-0 overflow-hidden">
      <div className="absolute inset-0 bg-[radial-gradient(var(--grid)_1px,transparent_1.2px)] [background-size:22px_22px] opacity-70" />
      <div className="fd-drift absolute -inset-3 hidden md:block">
        <svg className="absolute inset-0 h-full w-full" preserveAspectRatio="none" viewBox="0 0 100 100">
          <title>流程连线</title>
          {NODES.slice(0, 7).map((n, i) => {
            const m = NODES[i + 1];
            if (!m || i >= 6) return null;
            return (
              <path
                key={n.label}
                d={`M${n.x},${n.y} C${(n.x + m.x) / 2},${n.y} ${(n.x + m.x) / 2},${m.y} ${m.x},${m.y}`}
                className="fd-flow-dash"
                fill="none"
                stroke="var(--border-strong)"
                strokeWidth="0.15"
                vectorEffect="non-scaling-stroke"
                style={{ strokeWidth: 1.2 }}
              />
            );
          })}
        </svg>
        {NODES.map((n, i) => (
          <div
            key={n.label}
            className="fd-bob absolute -translate-x-1/2 -translate-y-1/2"
            style={{ left: `${n.x}%`, top: `${n.y}%`, animationDelay: `${i * -0.9}s` }}
          >
            <div className="flex items-center gap-1.5 rounded-md border bg-card/55 px-2.5 py-1 text-xs whitespace-nowrap text-muted-foreground shadow-sm backdrop-blur-[2px] dark:bg-card/35">
              <span className="size-1.5 rounded-full" style={{ background: TONE_VAR[n.tone] }} />
              {n.label}
            </div>
          </div>
        ))}
      </div>
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_70%_60%_at_50%_45%,transparent_0%,var(--background)_100%)] opacity-60" />
    </div>
  );
}

/** 几张需求卡照流程流转：在写码 → 验证中 → 已合并（真组件 StatusChip，节奏是演示的）。 */
const CYCLE: { tone: Tone; label: string; line: string }[] = [
  { tone: 'run', label: '在写码', line: '每个子任务一个会话：写码、自测、开 PR' },
  { tone: 'run', label: '验证中', line: '同步最新主线，跑 GitHub 测试' },
  { tone: 'done', label: '已合并', line: '合并队列里重测后合进主线' },
];
const TASKS = [
  { n: 12, title: '登录页加手机验证码', model: 'Opus 5.5' },
  { n: 14, title: '支付对账表：每个渠道 × 每一天', model: 'Kimi k3' },
  { n: 17, title: '站内通知 7 天没读再提醒一次', model: 'Sonnet 5' },
  { n: 19, title: '退款单导出加上退款原因', model: 'Kimi k3' },
  { n: 21, title: '商品详情页图片懒加载', model: 'Opus 5.5' },
];

function Flowing() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const reduced =
      matchMedia('(prefers-reduced-motion: reduce)').matches ||
      document.documentElement.dataset.motion === 'reduced';
    if (reduced) return;
    const t = setInterval(() => setTick((x) => x + 1), 2400);
    return () => clearInterval(t);
  }, []);
  return (
    <ul className="divide-y overflow-hidden rounded-lg border bg-card shadow-sm">
      {TASKS.map((t, i) => {
        const c = CYCLE[(tick + i) % CYCLE.length] as (typeof CYCLE)[number];
        return (
          <li key={t.n} className="flex items-center gap-3 px-4 py-3">
            <StatusDot tone={c.tone} />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="num text-xs text-muted-foreground">#{t.n}</span>
                <span className="truncate text-sm font-medium">{t.title}</span>
              </div>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                <span className="num text-foreground">{t.model}</span> · {c.line}
              </p>
            </div>
            <StatusChip key={c.label} tone={c.tone} label={c.label} className="fd-rise" />
          </li>
        );
      })}
    </ul>
  );
}

function AskCard({ className, style }: { className?: string; style?: CSSProperties }) {
  const { data: notes } = useNotifications('open');
  const now = useNow();
  const ask = notes?.items.find((n) => n.level === 'decision');
  if (!ask) return null;
  return (
    <div
      style={style}
      className={cn(
        'fd-enter flex items-start gap-3 rounded-lg border border-st-human/45 bg-card px-4 py-3 shadow-sm',
        className,
      )}
    >
      <div className="fd-breath grid size-8 shrink-0 place-items-center rounded-full bg-st-human/12 text-ink-human">
        <MessageCircleQuestion className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{ask.title}</span>
          <span className="num ml-auto shrink-0 text-[11px] text-muted-foreground">
            {formatAgo(ask.createdAt, now)}
          </span>
        </div>
        <p className="mt-0.5 truncate text-xs text-muted-foreground">{ask.body}</p>
      </div>
    </div>
  );
}

const press = 'transition-[transform,background-color,box-shadow] hover:shadow-md active:scale-[0.98]';

function FeishuButton({ flow, className }: { flow: LoginFlow; className?: string }) {
  return (
    <Button
      className={cn('h-11 text-[15px]', press, className)}
      disabled={!flow.feishuReady || flow.busy !== null}
      onClick={flow.feishu}
    >
      {flow.busy === 'feishu' ? <LoaderCircle className="animate-spin" /> : <Send />}
      {flow.busy === 'feishu' ? '正在用飞书登录…' : '用飞书登录'}
    </Button>
  );
}

/** 电脑上的扫码框（草稿是占位；正式版这里是飞书网页扫码 SDK 画的二维码）。 */
function QrBox({ flow }: { flow: LoginFlow }) {
  return (
    <div className="flex flex-col items-center text-center">
      <div className="text-sm font-medium">飞书扫码</div>
      <div className="mt-3 grid size-[172px] place-items-center rounded-lg border border-dashed border-border-strong bg-muted/60">
        <div className="flex flex-col items-center gap-2 text-muted-foreground">
          <QrCode className="size-10" strokeWidth={1.2} />
          <span className="text-xs">飞书的二维码</span>
        </div>
      </div>
      <p className="mt-3 text-xs leading-5 text-muted-foreground">打开手机飞书，扫一扫登录</p>
      <button
        type="button"
        onClick={flow.feishu}
        disabled={!flow.feishuReady || flow.busy !== null}
        className="mt-1 text-xs text-ink-run hover:underline disabled:opacity-50"
      >
        {flow.busy === 'feishu' ? '正在跳转…' : '扫不了？跳到飞书授权页'}
      </button>
    </div>
  );
}

function Panel({ flow }: { flow: LoginFlow }) {
  // 两套只挂一套：账号密码表单的输入框编号是固定的，挂两份会重号。
  const isMobile = useIsMobile();
  return (
    <section
      aria-label="登录"
      style={enter(1)}
      className="fd-enter rounded-lg border bg-card/95 p-5 shadow-[0_12px_32px_-16px_var(--shadow-color)] backdrop-blur md:p-8"
    >
      <h2 className="text-lg font-semibold md:text-xl">登录驾驶舱</h2>
      <p className="mt-0.5 text-sm text-muted-foreground">只放行创始人</p>

      {/* 电脑：扫码 | 或 | 账号密码，同时摆出来 */}
      {isMobile ? null : (
        <div className="mt-6 grid grid-cols-[1fr_auto_1.15fr] gap-6">
          <QrBox flow={flow} />
          <div className="flex flex-col items-center gap-2 text-xs text-faint">
            <span className="w-px flex-1 bg-border" />或<span className="w-px flex-1 bg-border" />
          </div>
          <div>
            {flow.passwordEnabled ? (
              <PasswordForm
                flow={flow}
                autoFocus={false}
                submitClassName={press}
                hint={<MockHint flow={flow} />}
              />
            ) : (
              <p className="text-sm text-muted-foreground">账号密码登录没开，用飞书扫码。</p>
            )}
          </div>
        </div>
      )}

      {/* 手机：大按钮 + 账号密码，不切换 */}
      {isMobile ? (
        <div className="mt-4 grid gap-3">
          <FeishuButton flow={flow} />
          {flow.passwordEnabled ? (
            <>
              <div className="flex items-center gap-3 text-xs text-faint">
                <span className="h-px flex-1 bg-border" />
                或用账号密码
                <span className="h-px flex-1 bg-border" />
              </div>
              <PasswordForm flow={flow} autoFocus={false} submitClassName={press} className="gap-2.5" />
            </>
          ) : null}
        </div>
      ) : null}

      <ConfigNote flow={flow} className="mt-3" />
      {flow.error && !flow.passwordEnabled ? (
        <p role="alert" className="mt-2 text-sm text-ink-fail">
          {flow.error.text}
        </p>
      ) : null}
      <DevLoginForm flow={flow} className="mt-4" />
      <div className="mt-4 border-t pt-3 md:mt-6 md:pt-4">
        <DemoLink />
      </div>
    </section>
  );
}

export function FeishuLogin({ next }: { next: string }) {
  const [leaving, setLeaving] = useState(false);
  const flow = useLoginFlow(next, async () => {
    setLeaving(true);
    await pause(300);
  });
  useMe();
  return (
    <PaletteScope
      palette="feishu"
      className={cn('relative min-h-dvh transition-opacity duration-300', leaving && 'opacity-0')}
    >
      <Showcase>
        <Backdrop />
        <div className="relative">
          <header className="flex h-14 items-center gap-2 border-b bg-card/85 px-4 backdrop-blur md:px-8">
            <LogoMark className="size-7" />
            <span className="font-semibold">驾驶舱</span>
            <ThemeToggle className="ml-auto" />
          </header>
          <main className="mx-auto grid max-w-[1240px] grid-cols-1 gap-4 px-4 py-4 md:min-h-[calc(100dvh-3.5rem)] md:grid-cols-[minmax(0,1fr)_600px] md:content-center md:gap-12 md:px-8 md:py-10">
            <div className="order-2 grid min-w-0 grid-cols-1 content-start gap-3 md:order-1">
              <h1 style={enter(0)} className="fd-enter hidden text-3xl leading-tight font-semibold md:block">
                一群 AI 自己接需求、写码、合并
              </h1>
              <p
                style={enter(0)}
                className="fd-enter mb-3 hidden text-sm leading-6 text-muted-foreground md:block"
              >
                你在飞书里说一句，驾驶舱拆任务、派模型写码、跑测试、合进主线；重大方案和发布、花钱、删数据，排成卡片等你点头。下面是登录后的样子（演示数据）。
              </p>
              <AskCard style={enter(2)} />
              <div style={enter(3)} className="fd-enter">
                <Flowing />
              </div>
            </div>
            <div className="order-1 md:order-2">
              <p className="mb-3 text-sm text-muted-foreground md:hidden">
                一群 AI 自己接需求、写码、合并；你只管点头。
              </p>
              <Panel flow={flow} />
            </div>
          </main>
        </div>
      </Showcase>
    </PaletteScope>
  );
}
