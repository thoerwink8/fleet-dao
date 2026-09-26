// 登录页 C「你只管拍板」：驾驶舱里人只做一件事——拍板。登录本身就是你的第一张「要你拍板」卡，
// 下面压着的是 AI 们此刻真在等人拍的几张（演示数据里的提醒，会自己冒出新的）。

import { KeyRound, LoaderCircle, Lock, MessageCircleQuestion, Send } from 'lucide-react';
import { useState } from 'react';
import { useAllBoards, useNotifications } from '../api/client';
import { LogoMark } from '../components/logo';
import { StatusDot } from '../components/status';
import { Button } from '../components/ui/button';
import { formatAgo } from '../lib/format';
import { useNow } from '../lib/hooks';
import { noticeLevelMeta, taskTone, toneText } from '../lib/status';
import { cn } from '../lib/utils';
import { DemoLink, PaletteScope, pause, ThemeToggle } from './bits';
import { ConfigNote, DevLoginForm, type LoginFlow, MockHint, PasswordForm, useLoginFlow } from './flow';
import { Showcase } from './showcase';

function Counts() {
  const { data } = useNotifications('open');
  const { boards } = useAllBoards();
  const items = data?.items ?? [];
  const decide = items.filter((n) => n.level === 'decision').length;
  const alert = items.filter((n) => n.level === 'alert').length;
  const done = boards.flatMap((b) => b.tasks).filter((t) => taskTone(t) === 'done').length;
  const cell = (n: number, label: string, tone: 'human' | 'stall' | 'done') => (
    <div className="min-w-0">
      <div className={cn('num text-3xl font-semibold tracking-tight md:text-4xl', toneText[tone])}>
        {data ? n : '—'}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground">{label}</div>
    </div>
  );
  return (
    <div className="grid grid-cols-3 gap-4 border-t pt-4">
      {cell(decide, '张在等你拍', 'human')}
      {cell(alert, '件卡住在报警', 'stall')}
      {cell(done, '个需求已做完', 'done')}
    </div>
  );
}

/** 压在登录卡下面的：AI 们此刻在等人拍的卡。只给看，登录后才能点。 */
function Deck() {
  const { data } = useNotifications('open');
  const now = useNow();
  const items = (data?.items ?? []).filter((n) => n.level !== 'daily').slice(0, 4);
  return (
    <ol className="relative grid gap-2" aria-label="等你拍板的卡（演示数据）">
      {items.map((n, i) => {
        const meta = noticeLevelMeta[n.level];
        return (
          <li
            key={n.id}
            className="fd-rise flex items-start gap-3 rounded-xl border bg-card/80 px-4 py-3 backdrop-blur"
            style={{ opacity: 1 - i * 0.16 }}
          >
            <StatusDot tone={meta.tone} className="mt-1.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="truncate text-sm font-medium">{n.title}</span>
                <span className="num ml-auto shrink-0 text-[11px] text-muted-foreground">
                  {formatAgo(n.createdAt, now)}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">{n.body}</p>
            </div>
            <Lock className="mt-1 size-3.5 shrink-0 text-faint" aria-label="登录后能拍" />
          </li>
        );
      })}
    </ol>
  );
}

function LoginAsk({ flow }: { flow: LoginFlow }) {
  const [mode, setMode] = useState<'choose' | 'password'>('choose');
  return (
    <section
      aria-label="登录"
      className="relative rounded-2xl border border-st-human/55 bg-popover p-5 shadow-[0_30px_80px_-30px_var(--shadow-color)] ring-4 ring-st-human/10 md:p-6"
    >
      <div className="flex items-start gap-3">
        <div className="grid size-10 shrink-0 place-items-center rounded-full bg-st-human/15 text-ink-human">
          <MessageCircleQuestion className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-ink-human">驾驶舱在问你 · 刚刚</div>
          <h2 className="mt-0.5 text-lg leading-snug font-semibold">要进来，先确认是你</h2>
          <p className="mt-1 text-sm text-muted-foreground">只放行创始人。确认之后，下面这几张就归你拍。</p>
        </div>
      </div>
      {mode === 'choose' ? (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <Button
            className="h-11 bg-st-human text-white hover:bg-st-human/90"
            disabled={!flow.feishuReady || flow.busy !== null}
            onClick={flow.feishu}
          >
            {flow.busy === 'feishu' ? <LoaderCircle className="animate-spin" /> : <Send />}
            {flow.busy === 'feishu' ? '确认中…' : '用飞书确认'}
          </Button>
          {flow.passwordEnabled ? (
            <Button
              variant="outline"
              className="h-11"
              disabled={flow.busy !== null}
              onClick={() => {
                flow.clearError();
                setMode('password');
              }}
            >
              <KeyRound />
              用户名密码
            </Button>
          ) : null}
          <ConfigNote flow={flow} className="sm:col-span-2" />
          {flow.error ? (
            <p role="alert" className="text-sm text-ink-fail sm:col-span-2">
              {flow.error.text}
            </p>
          ) : null}
        </div>
      ) : (
        <PasswordForm
          flow={flow}
          className="mt-4"
          submitClassName="bg-st-human text-white hover:bg-st-human/90"
          onCancel={() => {
            flow.clearError();
            setMode('choose');
          }}
          hint={<MockHint flow={flow} />}
        />
      )}
      <DevLoginForm flow={flow} className="mt-3" />
      <div className="mt-4 border-t pt-3">
        <DemoLink>没有账号？去演示版里随便拍（假数据）</DemoLink>
      </div>
    </section>
  );
}

export function DecideLogin({ next }: { next: string }) {
  const [leaving, setLeaving] = useState(false);
  const flow = useLoginFlow(next, async () => {
    setLeaving(true);
    await pause(400);
  });
  return (
    <PaletteScope
      palette="tokyo"
      className={cn('min-h-dvh transition-opacity duration-300', leaving && 'opacity-0')}
    >
      <Showcase>
        <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 md:px-8">
          <header className="flex h-14 shrink-0 items-center gap-2 md:h-16">
            <LogoMark className="size-7" />
            <span className="font-semibold tracking-tight">驾驶舱</span>
            <ThemeToggle className="ml-auto" />
          </header>
          <main className="grid flex-1 content-start gap-6 pb-8 md:grid-cols-[1fr_440px] md:content-center md:gap-14 md:pb-16">
            <div className="min-w-0 md:self-center">
              <h1 className="text-[28px] leading-[1.15] font-extrabold tracking-tight md:text-6xl md:leading-[1.05]">
                AI 把活干完了，
                <br />
                <span className="text-ink-human">只差你点头。</span>
              </h1>
              <p className="mt-3 max-w-md text-sm text-muted-foreground md:mt-6 md:text-base">
                驾驶舱让一群 AI
                自己接需求、写码、跑测试、合进主线；重大方案，和发布、花钱、删数据这几件，排成卡片等你拍。
                <span className="hidden md:inline">右边压着的就是它们此刻在问的。</span>
              </p>
              <div className="mt-8 hidden md:block">
                <Counts />
              </div>
            </div>
            <div className="grid min-w-0 gap-3">
              <LoginAsk flow={flow} />
              <Deck />
              <p className="text-center text-[11px] text-faint">下面几张是演示数据，会自己冒出新的</p>
            </div>
          </main>
        </div>
      </Showcase>
    </PaletteScope>
  );
}
