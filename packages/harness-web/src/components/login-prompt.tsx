import { LogIn } from 'lucide-react';
import { type FormEvent, useState } from 'react';
import { API_BASE, LOGIN_LINKS } from '../lib/api';
import { cn } from '../lib/cn';
import { IS_LOCAL } from '../lib/profile';

/** 本机装法：令牌在用户数据目录的 local-token 文件里；`fleet2 up` 打印的登录链接是一次性的，这里是粘贴令牌的备用入口。 */
function LocalLogin({ className }: { className?: string }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(`${API_BASE}/local/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (res.ok) window.location.reload();
      else setError(res.status === 401 ? '令牌不对' : `服务返回了 ${res.status}`);
    } catch {
      setError('连不上本机服务');
    }
  };
  return (
    <div role="alert" className={cn('p-4 text-sm text-ink-2', className)}>
      <p className="flex items-center gap-2 font-medium text-ink">
        <LogIn className="size-4 shrink-0" />
        需要本机令牌
      </p>
      <p className="mt-1 text-2xs text-muted">
        用 fleet2 up 打印的登录链接打开最省事；也可以把数据目录里 local-token 文件的内容粘贴到这里。
      </p>
      <form onSubmit={submit} className="mt-3 flex flex-wrap gap-2">
        <input
          type="password"
          aria-label="本机令牌"
          autoComplete="off"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-line px-3 font-mono text-xs"
        />
        <button
          type="submit"
          className="inline-flex h-9 items-center rounded-md bg-brand px-3 text-xs font-medium text-white hover:opacity-90"
        >
          登录
        </button>
      </form>
      {error ? <p className="mt-2 text-2xs text-danger">{error}</p> : null}
    </div>
  );
}

/**
 * 没登录（接口回 401）时的入口。登录在旧驾驶舱：飞书登录由服务端 302 回到这里，账密登录去旧驾驶舱的登录页，
 * 登完回来刷新即可。这两个是站内整页跳转，不走前端路由。本机装法（--mode desktop）换成本机令牌入口。
 */
export function LoginPrompt({ className }: { className?: string }) {
  if (IS_LOCAL) return <LocalLogin {...(className ? { className } : {})} />;
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
