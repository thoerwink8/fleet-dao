// 演示版在页面上的几处：顶上的横幅、没开放的模块页、没开放的细节。
import { EyeOff, FlaskConical } from 'lucide-react';
import { Link } from 'react-router';
import { visibleNav } from '../components/shell/nav';
import { demoScope } from './access';

/** 页面最顶上那一条：一眼看出是演示版；链接过期、作废时把原因写在后面。 */
export function DemoBanner() {
  const notice = demoScope()?.notice;
  return (
    <div
      role="note"
      className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-0.5 border-b border-st-human/30 bg-st-human/10 px-4 py-1.5 text-center text-xs"
    >
      <span className="inline-flex items-center gap-1.5 font-medium text-ink-human">
        <FlaskConical className="size-3.5" aria-hidden />
        演示版·全是假数据，操作不会有任何影响
      </span>
      {notice ? <span className="text-ink-stall">{notice}</span> : null}
    </div>
  );
}

/** 整个模块没开放：说清楚，再给能看的入口。 */
export function NotOpen() {
  const items = visibleNav().flatMap((g) => g.items);
  return (
    <div className="fd-rise mx-auto grid min-h-full max-w-md place-items-center px-6 py-16 text-center">
      <div>
        <EyeOff className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h1 className="mt-4 text-lg font-semibold">演示版没开放这一块</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {items.length ? '这条演示链接能看下面这些：' : '这条演示链接暂时什么都看不了。'}
        </p>
        {items.length ? (
          <ul className="mt-4 flex flex-wrap justify-center gap-2">
            {items.map((item) => (
              <li key={item.to}>
                <Link
                  to={item.to}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-sm hover:bg-accent"
                >
                  <item.icon className="size-4 text-muted-foreground" aria-hidden />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** 某一块细节没开放（步骤清单、过程……）：照实说「有，但没开放」，不冒充「还没有」。 */
export function HiddenNote({ what }: { what: string }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-dashed px-3 py-3 text-xs text-muted-foreground">
      <EyeOff className="size-3.5 shrink-0" aria-hidden />
      演示版没开放{what}
    </p>
  );
}
