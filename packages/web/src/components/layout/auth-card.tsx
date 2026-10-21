// 登录页的卡片（样子照 canvas/fd3.css 的 .auth .auth-card）：浅灰底整屏居中，一张 400 宽的白卡片，上面品牌名和一句话，下面是表单。
// 用在外壳外面（登录页没有顶栏和左菜单）。不收 className 和 style。
import type { ReactNode } from 'react';
import { cn } from '../../lib/utils';

export function AuthCard({
  title,
  description,
  footer,
  embedded,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  /** 卡片下面的灰字：版本、帮助。 */
  footer?: ReactNode;
  /** 放在别的页面里陈列时用：不撑满整屏高。登录页自己不传。 */
  embedded?: boolean;
  children: ReactNode;
}) {
  return (
    <main className={cn('flex items-center justify-center bg-page p-6', !embedded && 'min-h-screen')}>
      <div className="flex w-full max-w-100 flex-col gap-4">
        <section className="flex flex-col gap-6 rounded-md bg-card p-8">
          <header className="flex flex-col gap-2">
            <h1 className="text-title text-ink">{title}</h1>
            {description ? <p className="text-body text-ink-3">{description}</p> : null}
          </header>
          {children}
        </section>
        {footer ? <div className="text-center text-meta text-ink-3">{footer}</div> : null}
      </div>
    </main>
  );
}
