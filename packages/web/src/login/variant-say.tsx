// 登录页 B「先说一句」：页面只有一个问题「想让 AI 做什么？」。打一句需求或点一个示例，
// 这条需求照真实流程（docs/design.md 第五节那张图）在眼前走一遍：收单 → 分诊 → 拍板期 → 需求文档和「我理解为」卡
// → 规划拆子任务 → 每个子任务一个会话写码、自测、开 PR → 验证 → 合并队列 → 收尾。
// 走到拍板期弹出登录：这段时间 AI 不往下推，要追问、延长、跳过得是你本人。
// 会话时间线用真组件（RunTimeline），路由、模型、渠道来自演示数据，时间按 90 倍快进。

import type { StageKind } from '@fleet-dao/shared';
import {
  ArrowUp,
  Check,
  FileText,
  Hourglass,
  KeyRound,
  LoaderCircle,
  RotateCcw,
  Send,
  X,
} from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useAllBoards, useRouting } from '../api/client';
import type { Run } from '../api/types';
import { LogoMark } from '../components/logo';
import { RunTimeline } from '../components/run-timeline';
import { StatusChip, StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { formatDuration } from '../lib/format';
import { cn } from '../lib/utils';
import { DemoLink, PaletteScope, pause, ThemeToggle } from './bits';
import { ConfigNote, DevLoginForm, type LoginFlow, MockHint, PasswordForm, useLoginFlow } from './flow';
import { Showcase } from './showcase';

/** 一段剧本：一句话、写成需求文档后「我理解为」怎么说、拆成哪两个子任务。 */
interface Script {
  say: string;
  title: string;
  understood: string;
  subtasks: [string, string];
}

const EXAMPLES: Script[] = [
  {
    say: '下单页加优惠券，自动帮顾客选最省的那张',
    title: '下单页加优惠券',
    understood: '结算时列出能用的券，默认选省得最多的一张，顾客可以改',
    subtasks: ['券的接口和算价', '下单页的选券界面'],
  },
  {
    say: '订单导出太慢了，改成后台生成，好了发飞书告诉我',
    title: '订单导出改成后台生成',
    understood: '导出放到后台慢慢做，做好了发飞书通知，附下载链接',
    subtasks: ['后台生成导出文件', '导出进度和下载入口'],
  },
  {
    say: '博客文章页加个目录，滚到哪一节就高亮哪一节',
    title: '文章页加目录',
    understood: '文章页侧边加目录，跟着滚动高亮当前这一节',
    subtasks: ['从正文生成目录', '目录的界面和滚动高亮'],
  },
];

function scriptFor(text: string): Script {
  const hit = EXAMPLES.find((e) => e.say === text);
  if (hit) return hit;
  const title = text.length > 18 ? `${text.slice(0, 18)}…` : text;
  return { say: text, title, understood: text, subtasks: ['后端部分', '界面部分'] };
}

/** 流程图上的几步（原话照 design 第五节）。 */
const FLOW = ['收单', '分诊', '拍板期', '需求文档', '规划', '执行', '验证', '合并', '收尾'] as const;
type FlowStep = (typeof FLOW)[number];

/** 一个会话：派给谁、为什么、干多久（快进前的分钟）。 */
interface Step {
  stage: StageKind;
  routeId: string;
  modelName: string;
  whyRoute: string;
  mins: number;
  doing: string;
}

type Beat =
  | { kind: 'runs'; flow: FlowStep; steps: Step[] }
  | { kind: 'window' }
  | { kind: 'note'; flow: FlowStep; mins: number; text: string };

function beatsFor(s: Script): Beat[] {
  return [
    { kind: 'note', flow: '收单', mins: 0.1, text: '几秒内收单，开成 #231' },
    {
      kind: 'runs',
      flow: '分诊',
      steps: [
        {
          stage: 'triage',
          routeId: 'jev',
          modelName: 'Jev',
          whyRoute: '分诊是判断题：清不清楚、多大、哪类、风险',
          mins: 0.5,
          doing: '在判断清不清楚、多大、哪类、有没有风险',
        },
      ],
    },
    { kind: 'window' },
    {
      kind: 'runs',
      flow: '需求文档',
      steps: [
        {
          stage: 'spec',
          routeId: 'r-ca-sonnet',
          modelName: 'Sonnet 5',
          whyRoute: '小方案，AI 自己定，写进需求文档',
          mins: 4,
          doing: '在归纳方案、写需求文档',
        },
      ],
    },
    {
      kind: 'runs',
      flow: '规划',
      steps: [
        {
          stage: 'plan',
          routeId: 'r-ca-opus',
          modelName: 'Opus 5.5',
          whyRoute: '规划要想得深',
          mins: 5,
          doing: `在写方案、拆成两个子任务：${s.subtasks.join('、')}`,
        },
      ],
    },
    {
      kind: 'runs',
      flow: '执行',
      steps: [
        {
          stage: 'execute',
          routeId: 'r-rl-kimi',
          modelName: 'Kimi k3',
          whyRoute: `子任务 A：${s.subtasks[0]}`,
          mins: 9,
          doing: '每个子任务一个会话，在写码、自测、开 PR',
        },
        {
          stage: 'ui',
          routeId: 'r-cb-opus',
          modelName: 'Opus 5.5',
          whyRoute: `子任务 B：${s.subtasks[1]}`,
          mins: 11,
          doing: '每个子任务一个会话，在写码、自测、开 PR',
        },
      ],
    },
    {
      kind: 'note',
      flow: '验证',
      mins: 6,
      text: '同步最新主线、跑 GitHub 测试；不是高风险改动，不要第二意见',
    },
    {
      kind: 'note',
      flow: '合并',
      mins: 3,
      text: '不碰发布、花钱、删数据，不用等人点头；合并队列在最新主线上重测后合进去',
    },
    { kind: 'note', flow: '收尾', mins: 1, text: '写好结果文档，记下用量、耗时' },
  ];
}

/** 快进倍数：真实 1 秒 = 90 秒。 */
const SPEED = 90;
const QUEUE_MS = 24_000;
const WINDOW_MIN = 30;

interface Sim {
  script: Script;
  beats: Beat[];
  /** 正在走第几拍。 */
  at: number;
  /** 这一拍从模拟时钟的什么时候开始。 */
  beatStart: number;
  now: number;
  runs: Run[];
  /** 拍板期：在等人。 */
  waiting: boolean;
  startedAt: number;
  understood: boolean;
  done: boolean;
}

let seq = 0;

function scheduleRuns(steps: Step[], from: number): Run[] {
  seq += 1;
  return steps.map((s, i) => {
    const queuedAt = from + i * 15_000;
    const startedAt = queuedAt + QUEUE_MS;
    return {
      id: `say-${seq}-${i}`,
      stage: s.stage,
      routeId: s.routeId,
      modelName: s.modelName,
      whyRoute: s.whyRoute,
      queuedAt: new Date(queuedAt).toISOString(),
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(startedAt + s.mins * 60_000).toISOString(),
      outcome: 'ok',
      inputTokens: Math.round(s.mins * 21_000),
      outputTokens: Math.round(s.mins * 3_100),
    } as Run;
  });
}

/** 此刻能看见的会话：还没开始的不显示，没结束的去掉结束时间。 */
function visibleRuns(runs: Run[], now: number): Run[] {
  return runs
    .filter((r) => Date.parse(r.queuedAt) <= now)
    .map((r) => {
      if (r.endedAt && Date.parse(r.endedAt) <= now) return r;
      const { endedAt: _e, outcome: _o, ...rest } = r;
      return r.startedAt && Date.parse(r.startedAt) <= now ? rest : { ...rest, startedAt: undefined };
    }) as Run[];
}

/** 进入第 i 拍：排好这一拍的会话。 */
function enter(s: Sim, i: number, at: number): Sim {
  const beat = s.beats[i];
  if (!beat) return { ...s, at: i, now: at, done: true };
  const runs = beat.kind === 'runs' ? [...s.runs, ...scheduleRuns(beat.steps, at)] : s.runs;
  return { ...s, at: i, beatStart: at, now: at, runs, waiting: beat.kind === 'window' };
}

function beatEnd(s: Sim): number {
  const beat = s.beats[s.at];
  if (!beat) return s.now;
  if (beat.kind === 'note') return s.beatStart + beat.mins * 60_000;
  if (beat.kind === 'window') return Number.POSITIVE_INFINITY;
  const mine = s.runs.filter((r) => Date.parse(r.queuedAt) >= s.beatStart);
  return Math.max(...mine.map((r) => Date.parse(r.endedAt ?? r.queuedAt)));
}

function useSim() {
  const [sim, setSim] = useState<Sim | null>(null);
  const last = useRef(0);
  const running = Boolean(sim && !sim.waiting && !sim.done);
  useEffect(() => {
    if (!running) return;
    last.current = performance.now();
    const timer = setInterval(() => {
      const t = performance.now();
      const dt = (t - last.current) * SPEED;
      last.current = t;
      setSim((s) => {
        if (!s || s.waiting || s.done) return s;
        const now = s.now + dt;
        const end = beatEnd(s);
        if (now < end) return { ...s, now };
        const cur = s.beats[s.at];
        const next = enter(s, s.at + 1, end + 10_000);
        // 需求文档写完，推一张「我理解为」卡（不挡路，活照常往下做）。
        return cur?.kind === 'runs' && cur.flow === '需求文档' ? { ...next, understood: true } : next;
      });
    }, 200);
    return () => clearInterval(timer);
  }, [running]);
  return {
    sim,
    start(text: string) {
      const t0 = Date.now();
      const script = scriptFor(text);
      const base: Sim = {
        script,
        beats: beatsFor(script),
        at: 0,
        beatStart: t0,
        now: t0,
        runs: [],
        waiting: false,
        startedAt: t0,
        understood: false,
        done: false,
      };
      setSim(enter(base, 0, t0));
    },
    /** 拍板期到点（演示里快进 30 分钟）。 */
    closeWindow() {
      setSim((s) =>
        s?.waiting ? enter({ ...s, waiting: false }, s.at + 1, s.now + WINDOW_MIN * 60_000) : s,
      );
    },
    reset: () => setSim(null),
  };
}

function flowOf(sim: Sim): FlowStep {
  if (sim.done) return '收尾';
  const beat = sim.beats[sim.at];
  return beat?.kind === 'window' ? '拍板期' : (beat?.flow ?? '收单');
}

/** 流程图上的几步，走到哪亮到哪。 */
function FlowBar({ current, done }: { current: FlowStep; done: boolean }) {
  const idx = FLOW.indexOf(current);
  return (
    <ol className="flex flex-wrap gap-x-1 gap-y-1.5 text-xs" aria-label="流程">
      {FLOW.map((f, i) => (
        <li
          key={f}
          className={cn(
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5',
            i < idx || done ? 'text-muted-foreground' : 'text-faint',
            i === idx &&
              !done &&
              (f === '拍板期'
                ? 'bg-st-human/15 font-medium text-ink-human'
                : 'bg-st-run/12 font-medium text-ink-run'),
          )}
        >
          {i < idx || done ? <Check className="size-3" aria-hidden /> : null}
          {f}
        </li>
      ))}
    </ol>
  );
}

function WindowCard({ onAct, onSkip }: { onAct(): void; onSkip(): void }) {
  return (
    <div className="fd-rise flex flex-col gap-3 rounded-2xl border border-st-human/50 bg-st-human/[0.07] p-4 sm:flex-row sm:items-center">
      <div className="grid size-9 shrink-0 place-items-center rounded-full bg-st-human/15 text-ink-human">
        <Hourglass className="size-5" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">拍板期 · 默认 30 分钟</div>
        <div className="mt-0.5 text-sm text-muted-foreground">
          这段时间 AI 不往下推。你可以在讨论群或驾驶舱里追问，也可以延长、暂停、跳过；到点 AI
          读完讨论记录，归纳方案往下做。
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={onAct}>跳过拍板期</Button>
        <Button variant="outline" onClick={onAct}>
          追问一句
        </Button>
        <Button variant="ghost" onClick={onSkip}>
          快进到点
        </Button>
      </div>
    </div>
  );
}

function Stage({
  sim,
  onWindow,
  onSkip,
  onReset,
}: {
  sim: Sim;
  onWindow(): void;
  onSkip(): void;
  onReset(): void;
}) {
  const { data: routing } = useRouting();
  const runs = visibleRuns(sim.runs, sim.now);
  const beat = sim.beats[sim.at];
  const live = runs.filter((r) => r.startedAt && !r.endedAt);
  const current = flowOf(sim);
  const tone = sim.waiting ? 'human' : sim.done ? 'done' : 'run';
  const label = sim.waiting ? '拍板期' : sim.done ? '已合并' : '在干活';
  let line: string;
  if (sim.done) line = '合进主线了；结果文档写好了，用量和耗时记下了。';
  else if (sim.waiting) line = '分诊完了：说得清楚、改动小、是功能开发、不碰发布花钱删数据。进拍板期。';
  else if (beat?.kind === 'note') line = beat.text;
  else if (live.length) {
    const step = beat?.kind === 'runs' ? beat.steps.find((s) => s.routeId === live[0]?.routeId) : undefined;
    line = `${live.map((r) => r.modelName).join('、')} ${step?.doing ?? ''}`;
  } else line = '排队等空位…';
  return (
    <div className="grid w-full gap-4">
      <div className="flex items-start gap-3">
        <div className="grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-xs font-semibold text-background">
          你
        </div>
        <p className="min-w-0 flex-1 rounded-2xl rounded-tl-sm border bg-card px-4 py-2.5 text-[15px] shadow-sm">
          {sim.script.say}
        </p>
      </div>
      <section className="rounded-2xl border bg-card p-4 shadow-sm md:p-5" aria-label="这条需求走到哪了">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="num text-sm text-muted-foreground">#231</span>
          <span className="font-semibold">{sim.script.title}</span>
          <StatusChip tone={tone} label={label} />
          <span className="num ml-auto text-xs text-muted-foreground">
            已用 {formatDuration(sim.now - sim.startedAt)}（快进 90 倍）
          </span>
        </div>
        <FlowBar current={current} done={sim.done} />
        <p className="mt-3 mb-4 text-sm text-muted-foreground">{line}</p>
        {runs.length ? <RunTimeline runs={runs} routing={routing} now={sim.now} /> : null}
      </section>
      {sim.waiting ? <WindowCard onAct={onWindow} onSkip={onSkip} /> : null}
      {sim.understood ? (
        <div className="fd-rise flex items-start gap-3 rounded-2xl border bg-card p-4 text-sm">
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">「我理解为」卡片 · 发到飞书</div>
            <p className="mt-0.5 text-muted-foreground">
              我理解为：{sim.script.understood}。不挡路，活照常开工；理解错了点「改一下」，任务停下重新规划。
            </p>
          </div>
        </div>
      ) : null}
      {sim.done ? (
        <div className="flex justify-center">
          <Button variant="outline" onClick={onReset}>
            <RotateCcw />
            再说一句
          </Button>
        </div>
      ) : null}
    </div>
  );
}

/** 此刻驾驶舱里有几个会话在干活（演示数据），说明它是活的。 */
function LiveLine() {
  const { boards } = useAllBoards();
  const n = boards.reduce((sum, b) => sum + b.now.length, 0);
  if (!boards.length) return null;
  return (
    <p className="mt-8 inline-flex items-center gap-2 text-xs text-muted-foreground">
      <StatusDot tone="run" />
      此刻驾驶舱里 <span className="num text-foreground">{n}</span> 个 AI 会话在干活
    </p>
  );
}

/** 登录面板：顶上按钮、「要你拍板」都打开它。就地画在这一块里（不走传送门），好跟着这一版的配色。 */
function LoginSheet({
  flow,
  mode,
  reason,
  onMode,
  onClose,
}: {
  flow: LoginFlow;
  mode: 'choose' | 'password';
  reason: 'ask' | 'header';
  onMode(m: 'choose' | 'password'): void;
  onClose(): void;
}) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-end bg-background/55 backdrop-blur-sm sm:place-items-center sm:p-6">
      <section
        role="dialog"
        aria-modal
        aria-label="登录"
        className="fd-rise w-full rounded-t-3xl border bg-popover p-5 shadow-2xl sm:max-w-[400px] sm:rounded-3xl sm:p-6"
      >
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-lg font-semibold tracking-tight">
              {reason === 'ask' ? '跳过、延长、追问，得是你本人' : '登录驾驶舱'}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {reason === 'ask'
                ? '驾驶舱只放行创始人。登录后，拍板期里的需求在驾驶舱和飞书卡片上都能延长、暂停、跳过。'
                : '只放行创始人。'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="先不登录"
            className="-mt-1 -mr-1 grid size-8 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>
        {mode === 'choose' ? (
          <div className="mt-5 grid gap-2">
            <FeishuButton flow={flow} className="h-11 rounded-full" />
            {flow.passwordEnabled ? (
              <Button variant="outline" className="h-11 rounded-full" onClick={() => onMode('password')}>
                <KeyRound />
                用户名密码登录
              </Button>
            ) : null}
            <ConfigNote flow={flow} className="text-center" />
            {flow.error ? (
              <p role="alert" className="text-center text-sm text-ink-fail">
                {flow.error.text}
              </p>
            ) : null}
          </div>
        ) : (
          <PasswordForm
            flow={flow}
            className="mt-5"
            inputClassName="rounded-xl"
            submitClassName="rounded-full"
            onCancel={() => {
              flow.clearError();
              onMode('choose');
            }}
            hint={<MockHint flow={flow} />}
          />
        )}
        <DevLoginForm flow={flow} className="mt-3" />
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <DemoLink>{reason === 'ask' ? '没有账号？去演示版里试' : '没有账号？看演示版'}</DemoLink>
          {reason === 'ask' ? (
            <button
              type="button"
              onClick={onClose}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              先不登，快进到点
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function FeishuButton({ flow, className, short }: { flow: LoginFlow; className?: string; short?: boolean }) {
  return (
    <Button className={className} disabled={!flow.feishuReady || flow.busy !== null} onClick={flow.feishu}>
      {flow.busy === 'feishu' ? <LoaderCircle className="animate-spin" /> : <Send />}
      {flow.busy === 'feishu' ? '登录中…' : short ? '飞书登录' : '用飞书登录'}
    </Button>
  );
}

export function SayLogin({ next }: { next: string }) {
  const [leaving, setLeaving] = useState(false);
  const flow = useLoginFlow(next, async () => {
    setLeaving(true);
    await pause(350);
  });
  const { sim, start, closeWindow, reset } = useSim();
  const [text, setText] = useState('');
  const [sheet, setSheet] = useState<{ mode: 'choose' | 'password'; reason: 'ask' | 'header' } | null>(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) start(text.trim());
  };
  const openLogin = (mode: 'choose' | 'password', reason: 'ask' | 'header') => {
    flow.clearError();
    setSheet({ mode, reason });
  };

  return (
    <PaletteScope
      palette="celadon"
      className={cn('relative h-dvh overflow-hidden transition-opacity duration-300', leaving && 'opacity-0')}
    >
      <div className="flex h-full flex-col">
        <header className="flex h-14 shrink-0 items-center gap-2 px-4 md:h-16 md:px-8">
          <LogoMark className="size-7" />
          <span className="font-semibold tracking-tight">驾驶舱</span>
          <div className="ml-auto flex items-center gap-1.5">
            <ThemeToggle />
            <FeishuButton flow={flow} short className="h-8 rounded-full px-3 text-[13px]" />
            {flow.passwordEnabled ? (
              <Button
                variant="outline"
                className="h-8 rounded-full px-3 text-[13px]"
                onClick={() => openLogin('password', 'header')}
              >
                <KeyRound />
                账号密码
              </Button>
            ) : null}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto">
          <Showcase>
            <div
              className={cn(
                'mx-auto flex w-full max-w-3xl flex-col px-4 pb-10 md:px-6',
                sim ? 'pt-4 md:pt-8' : 'min-h-full justify-center pt-2 pb-24 md:pb-32',
              )}
            >
              {sim ? (
                <Stage
                  sim={sim}
                  onWindow={() => openLogin('choose', 'ask')}
                  onSkip={closeWindow}
                  onReset={() => {
                    setText('');
                    reset();
                  }}
                />
              ) : (
                <div className="text-center">
                  <p className="text-sm text-muted-foreground">
                    驾驶舱：一群 AI 自己接需求、拆任务、写码、跑测试、合进主线
                  </p>
                  <h1 className="mt-3 text-[40px] leading-[1.1] font-light tracking-tight md:text-7xl">
                    想让 AI 做什么？
                  </h1>
                  <form onSubmit={submit} className="relative mx-auto mt-8 max-w-2xl md:mt-10">
                    <label htmlFor="say" className="sr-only">
                      说一句需求
                    </label>
                    <input
                      id="say"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      placeholder="比如：下单页加优惠券"
                      autoComplete="off"
                      className="h-14 w-full rounded-full border bg-card pr-14 pl-6 text-base shadow-[0_12px_40px_-16px_var(--shadow-color)] outline-none transition-shadow focus:border-ring focus:ring-4 focus:ring-ring/30 md:h-16 md:text-lg"
                    />
                    <Button
                      type="submit"
                      size="icon"
                      disabled={!text.trim()}
                      aria-label="交给 AI"
                      className="absolute top-2 right-2 size-10 rounded-full md:size-12"
                    >
                      <ArrowUp />
                    </Button>
                  </form>
                  <div className="mx-auto mt-5 flex max-w-2xl flex-wrap justify-center gap-2">
                    {EXAMPLES.map((e) => (
                      <button
                        key={e.say}
                        type="button"
                        onClick={() => {
                          setText(e.say);
                          start(e.say);
                        }}
                        className="rounded-full border bg-card/60 px-3.5 py-1.5 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
                      >
                        {e.title}
                      </button>
                    ))}
                  </div>
                  <p className="mt-6 text-xs text-faint">
                    不用登录就能试：会话、模型、路由都是演示数据，时间快进 90 倍。
                  </p>
                  <DemoLink className="mt-3">没有账号？看演示版</DemoLink>
                  <div>
                    <LiveLine />
                  </div>
                </div>
              )}
            </div>
          </Showcase>
        </main>
      </div>
      {sheet ? (
        <LoginSheet
          flow={flow}
          mode={sheet.mode}
          reason={sheet.reason}
          onMode={(mode) => setSheet({ ...sheet, mode })}
          onClose={() => {
            setSheet(null);
            if (sheet.reason === 'ask' && sim?.waiting) closeWindow();
          }}
        />
      ) : null}
    </PaletteScope>
  );
}
