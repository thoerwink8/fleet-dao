import { LogIn } from 'lucide-react';
import { LOGIN_LINKS } from '../lib/api';
import { cn } from '../lib/cn';

/**
 * 没登录（接口回 401）时的入口。登录在旧驾驶舱：飞书登录由服务端 302 回到这里，账密登录去旧驾驶舱的登录页，
 * 登完回来刷新即可。这两个是站内整页跳转，不走前端路由。
 */
export function LoginPrompt({ className }: { className?: string }) {
  return (
    <div role="alert" className={cn('p-4 text-sm text-ink-2', className)}>
      <p className="flex items-center gap-2 font-medium text-ink">
        <LogIn className="size-4 shrink-0" />
        需要登录
      </p>
      <p className="mt-1 text-2xs text-muted">还没登录，或登录已过期。登录后回到这里，刷新一下就能看。</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <a
          href={LOGIN_LINKS.feishu}
          className="inline-flex h-9 items-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:opacity-90"
        >
          用飞书登录
        </a>
        <a
          href={LOGIN_LINKS.password}
          className="inline-flex h-9 items-center rounded-md border border-line px-3 text-xs font-medium text-ink hover:bg-subtle"
        >
          账密登录
        </a>
      </div>
    </div>
  );
}
