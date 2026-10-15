import { ArrowRight, Construction } from 'lucide-react';
import { Link, useLocation } from 'react-router';
import { EmptyState } from '../components/layout/empty-state';
import { Page } from '../components/layout/page';
import { Section } from '../components/layout/section';
import { Button } from '../components/ui/button';

/**
 * 还没做的页（账单）：地址留着，打开写明「还没做」、以后会有什么、现在去哪看相关的。
 * 驾驶舱改版起它不再占侧栏：没做的页挂在导航里，点进去是空的，只会让人白跑一趟。
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
};

export default function Soon() {
  const { pathname } = useLocation();
  const plan = PLANS[pathname];
  return (
    <Page title={plan?.title ?? '还没做'} description={plan?.what ?? '这个地址还没有页面。'} keepDescription>
      <Section>
        <EmptyState
          icon={Construction}
          title="这一页还没做"
          action={
            <div className="flex flex-wrap justify-center gap-2">
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
          }
        />
      </Section>
      {plan ? (
        <Section title="做好以后会有：" className="mt-4">
          <ul className="space-y-1.5">
            {plan.bullets.map((b) => (
              <li key={b} className="flex gap-2 text-body">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-muted-foreground" />
                {b}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
    </Page>
  );
}
