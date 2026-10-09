import { ArrowRight, Construction } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { brand } from '#brand';
import { Page } from '../components/page';
import { Button } from '../components/ui/button';

/**
 * 还没做的页（账单、战绩、判断题记录）：地址留着，打开写明「还没做」、以后会有什么、现在去哪看相关的。
 * 驾驶舱改版（2026-10-07）起它们不再占侧栏：没做的页挂在导航里，点进去是空的，只会让人白跑一趟。
 */
const PLANS: Record<
  string,
  { title: string; what: string; bullets: string[]; related: { to: string; label: string }[] }
> = {
  '/billing': {
    title: '账单',
    what: '花了多少、值不值：每个会话记模型、路由、token、耗时和所属任务。',
    bullets: [
      '订阅月费按月摊到任务，算出每完成一个任务花多少',
      '每个订阅浪费了多少额度',
      '按量渠道的月度上限和已花',
    ],
    // 原来还有一条「订阅月费」指向 /settings#fees：设置页没有这一节，点了落空，删掉
    related: [{ to: '/quota', label: '额度' }],
  },
  '/record': {
    title: '战绩',
    what: '每条路由在每类活上干得怎么样。',
    bullets: [
      '成功率、平均耗时、返工轮数，按阶段类型分开算',
      '战绩明显差的路由调度会往后放；样本少时不动',
      '约 10% 的任务试探派给非首选路由，攒战绩',
    ],
    related: [{ to: '/routing/status', label: '渠道状态' }],
  },
  '/judge': {
    title: brand.terms.judgeNav,
    what: `${brand.terms.judgeQuiz}的记录：每道题的答案、把握度和准确率。`,
    bullets: [
      '先只记不拦，攒满 50 条且准确率过线才真拦',
      '能拦不能放：不能批准合并、不能动账号、不能删东西',
      '巡检里放固定考题，准确率掉了自动退回只记不拦',
    ],
    related: [{ to: '/schedules', label: '定时任务' }],
  },
};

export default function Soon() {
  const { pathname } = useLocation();
  const plan = PLANS[pathname];
  return (
    <Page title={plan?.title ?? '还没做'} description={plan?.what ?? '这个地址还没有页面。'}>
      <div className="flex items-center gap-2 text-sm text-ink-stall">
        <Construction className="size-4" aria-hidden />
        这一页还没做
      </div>
      {plan ? (
        <>
          <p className="mt-5 text-xs text-muted-foreground">做好以后会有：</p>
          <ul className="mt-2 space-y-1.5">
            {plan.bullets.map((b) => (
              <li key={b} className="flex gap-2 text-sm">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-foreground/40" />
                {b}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div className="mt-6 flex flex-wrap gap-2">
        {plan?.related.map((r) => (
          <Button key={r.to} asChild variant="outline" size="sm">
            <Link to={r.to}>
              现在先看{r.label}
              <ArrowRight />
            </Link>
          </Button>
        ))}
        <Button asChild variant="ghost" size="sm">
          <Link to="/">回主页</Link>
        </Button>
      </div>
    </Page>
  );
}
