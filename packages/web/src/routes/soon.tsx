import { ArrowRight, Construction } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { brand } from '#brand';
import { NAV_ITEMS } from '../components/shell/nav';
import { Button } from '../components/ui/button';

// 第二批页面（P3 之后）的占位：写清楚这页以后会有什么、现在去哪看相关的东西。
const PLANS: Record<string, { what: string; bullets: string[]; related: { to: string; label: string }[] }> = {
  '/models': {
    what: '各家模型的清单：族、型号、在哪些路由上用、什么时候上架和下架。',
    bullets: [
      '模型扫描每天跑一次，新模型自动出现在这里',
      '模型下架后，对应路由自动离线并推通知',
      '新模型先考试，考过了再进调度台',
    ],
    related: [
      { to: '/dispatch', label: '调度台' },
      { to: '/channels', label: '渠道与账号' },
    ],
  },
  '/billing': {
    what: '花了多少、值不值：每个会话记模型、路由、token、耗时和所属任务。',
    bullets: [
      '订阅月费按月摊到任务，算出每完成一个任务花多少',
      '每个订阅浪费了多少额度',
      '按量渠道的月度上限和已花',
    ],
    related: [
      { to: '/quota', label: '额度' },
      { to: '/settings#fees', label: '订阅月费' },
    ],
  },
  '/record': {
    what: '每条路由在每类活上干得怎么样。',
    bullets: [
      '成功率、平均耗时、返工轮数，按阶段类型分开算',
      '战绩明显差的路由调度会往后放；样本少时不动',
      '约 10% 的任务试探派给非首选路由，攒战绩',
    ],
    related: [{ to: '/dispatch', label: '调度台' }],
  },
  '/judge': {
    what: `${brand.terms.judgeQuiz}的记录：九个接入点，每道题的答案、把握度和准确率。`,
    bullets: [
      '先只记不拦，攒满 50 条且准确率过线才真拦',
      '能拦不能放：不能批准合并、不能动账号、不能删东西',
      '巡检里放固定考题，准确率掉了自动退回只记不拦',
    ],
    related: [{ to: '/schedules', label: '定时任务' }],
  },
  '/members': {
    what: `谁能进${brand.product}、能做什么。`,
    bullets: [
      '飞书账号登录，只放行白名单',
      '以后加人在这里加，写 GitHub 的动作由机器人代发并记下提出人',
      '每个操作都留记录',
    ],
    related: [{ to: '/audit', label: '操作记录' }],
  },
};

export default function Soon() {
  const { pathname } = useLocation();
  const item = NAV_ITEMS.find((n) => n.to === pathname);
  const plan = PLANS[pathname];
  const Icon = item?.icon ?? Construction;
  return (
    <div className="fd-rise mx-auto grid min-h-full max-w-5xl items-center gap-10 px-6 py-12 lg:grid-cols-[1fr_1.1fr]">
      <div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-1 text-xs text-muted-foreground">
          <Construction className="size-3.5" aria-hidden />
          第二批页面 · P3 之后做
        </div>
        <h1 className="mt-4 flex items-center gap-3 text-3xl font-semibold tracking-tight">
          <Icon className="size-7 text-muted-foreground" aria-hidden />
          {item?.label ?? '还没做好'}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-muted-foreground">
          {plan?.what ?? '这一页还在路上。'}
        </p>
        {plan ? (
          <ul className="mt-5 space-y-2.5">
            {plan.bullets.map((b) => (
              <li key={b} className="flex gap-2.5 text-sm">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/40" />
                {b}
              </li>
            ))}
          </ul>
        ) : null}
        {plan?.related.length ? (
          <div className="mt-6 flex flex-wrap gap-2">
            {plan.related.map((r) => (
              <Button key={r.to} asChild variant="outline" size="sm">
                <Link to={r.to}>
                  先去看{r.label}
                  <ArrowRight />
                </Link>
              </Button>
            ))}
          </div>
        ) : null}
      </div>
      <div aria-hidden className="relative hidden lg:block">
        <div className="absolute -inset-6 rounded-[28px] bg-[radial-gradient(circle_at_30%_20%,color-mix(in_oklab,var(--brand)_14%,transparent),transparent_60%)]" />
        <div className="relative space-y-3 rounded-2xl border bg-card p-5 shadow-xl [mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
          <div className="flex items-center gap-2">
            <div className="h-3 w-24 rounded-full bg-foreground/15" />
            <div className="ml-auto h-3 w-12 rounded-full bg-foreground/10" />
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0.62, 0.35, 0.8].map((v) => (
              <div key={v} className="rounded-lg border p-3">
                <div className="h-2 w-10 rounded-full bg-foreground/10" />
                <div className="num mt-2 text-xl font-semibold text-foreground/25">
                  {Math.round(v * 100)}%
                </div>
                <div className="mt-2 h-1.5 rounded-full bg-foreground/10">
                  <div className="h-full rounded-full bg-foreground/25" style={{ width: `${v * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          {[0.9, 0.7, 0.8, 0.55, 0.75].map((w) => (
            <div key={w} className="flex items-center gap-3 rounded-lg border px-3 py-2.5">
              <div className="size-2 rounded-full bg-foreground/20" />
              <div className="h-2 rounded-full bg-foreground/12" style={{ width: `${w * 60}%` }} />
              <div className="ml-auto h-2 w-10 rounded-full bg-foreground/10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
