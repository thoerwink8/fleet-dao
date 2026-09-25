// 登录页（在外壳外面）。三条路，按 shared/web-api.ts 的 AuthRoutes：
// - 浏览器：跳 /auth/feishu/login?next=<站内路径>，飞书授权完回到 next。
// - 飞书客户端里：tt.requestAccess 拿 code，POST /auth/feishu/access（页面要先加载飞书 JSSDK 才有 tt）。
// - 开发环境：POST /auth/dev-login 免登（后端开了 devLogin 才显示）。

import { AUTH_PREFIX, AuthRoutes } from '@fleet-dao/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn, Presentation } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { errorText, keys, useApi, useAuthConfig, useMe } from '../api/client';
import type { Me } from '../api/types';
import { LogoMark } from '../components/logo';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { DEMO_URL } from '../demo/url';

export function meta() {
  return [{ title: brand.title('登录') }];
}

/** 和后端 auth.ts 的 safeNext 同一条规矩：只接受站内路径，别的一律回首页；也不回登录页自己。 */
export function safeNext(next: string | null): string {
  if (!next || next.length > 1000) return '/';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 就是要拒掉控制字符。
  if (/[\u0000-\u001f\u007f]/.test(next)) return '/';
  if (next === '/login' || next.startsWith('/login?')) return '/';
  return next;
}

interface FeishuTT {
  requestAccess?: (opts: {
    appID: string;
    scopeList: string[];
    success(res: { code: string }): void;
    fail(err: unknown): void;
  }) => void;
}

function feishuClient(): FeishuTT | undefined {
  const tt = (globalThis as { tt?: FeishuTT }).tt;
  return tt?.requestAccess ? tt : undefined;
}

export default function LoginPage() {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const me = useMe();
  const config = useAuthConfig();
  const [busy, setBusy] = useState<'feishu' | 'dev' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const tried = useRef(false);

  const done = (who: Me) => {
    qc.setQueryData(keys.me, who);
    navigate(next, { replace: true });
  };

  // 在飞书客户端里：不用点，直接拿飞书身份换登录态。
  const appId = config.data?.feishuAppId;
  useEffect(() => {
    const tt = feishuClient();
    if (!tt?.requestAccess || !appId || tried.current || me.data) return;
    tried.current = true;
    setBusy('feishu');
    tt.requestAccess({
      appID: appId,
      scopeList: [],
      success: ({ code }) => {
        api.feishuAccess(code).then(done, (e: unknown) => {
          setBusy(null);
          setError(errorText(e));
        });
      },
      fail: () => {
        setBusy(null);
        setError('飞书没给授权，可以点下面的按钮重新登录');
      },
    });
  });

  if (me.data) return <Navigate to={next} replace />;

  const feishuReady = Boolean(appId);
  const loginHref = `${AUTH_PREFIX}${AuthRoutes.feishuLogin.path}?next=${encodeURIComponent(next)}`;

  const devLogin = async (e: FormEvent) => {
    e.preventDefault();
    if (!userId.trim()) return;
    setBusy('dev');
    setError(null);
    try {
      done(await api.devLogin(userId.trim()));
    } catch (err) {
      setError(errorText(err));
      setBusy(null);
    }
  };

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <LogoMark className="size-12" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">登录{brand.product}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">
            {brand.product}只放行创始人，用飞书账号登录。
          </p>
        </div>

        <div className="mt-8 rounded-2xl border bg-card p-5 shadow-sm">
          {api.source === 'mock' ? (
            <div className="space-y-3 text-center">
              <p className="text-sm text-muted-foreground">现在是假数据模式，不用登录。</p>
              <Button className="w-full" onClick={() => navigate(next, { replace: true })}>
                进{brand.product}
              </Button>
            </div>
          ) : (
            <>
              {feishuReady && busy === null ? (
                <Button asChild className="h-10 w-full">
                  <a href={loginHref}>
                    <LogIn />
                    用飞书登录
                  </a>
                </Button>
              ) : (
                <Button className="h-10 w-full" disabled>
                  <LogIn />
                  {busy === 'feishu' ? '正在用飞书身份登录…' : '用飞书登录'}
                </Button>
              )}
              {config.isPending ? (
                <p className="mt-2 text-center text-xs text-muted-foreground">正在读登录配置…</p>
              ) : config.error ? (
                <p className="mt-2 text-center text-xs text-ink-fail">
                  连不上{brand.product}后端：{errorText(config.error)}
                </p>
              ) : !feishuReady ? (
                <p className="mt-2 text-center text-xs text-muted-foreground">飞书登录还没配置。</p>
              ) : null}

              {config.data?.devLogin ? (
                <form onSubmit={devLogin} className="mt-5 space-y-2 rounded-xl border border-dashed p-3">
                  <Label htmlFor="dev-user" className="text-xs text-muted-foreground">
                    开发环境免登：填白名单里的用户编号
                  </Label>
                  <div className="flex gap-2">
                    <Input
                      id="dev-user"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                      placeholder="用户编号"
                      autoComplete="off"
                      className="num"
                    />
                    <Button type="submit" variant="secondary" disabled={!userId.trim() || busy !== null}>
                      {busy === 'dev' ? '登录中…' : '免登'}
                    </Button>
                  </div>
                </form>
              ) : null}
            </>
          )}
          {error ? (
            <p role="alert" className="mt-3 rounded-lg bg-st-fail/10 px-3 py-2 text-sm text-ink-fail">
              {error}
            </p>
          ) : null}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          登录后回到 <span className="num">{next}</span>
        </p>
        {/* 演示版是另一个单页（假数据、不用登录），地址由构建配置给（FLEET_DEMO_URL）：整页跳过去，不走站内路由。 */}
        <a
          href={DEMO_URL}
          className="mt-6 flex items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-3 text-sm text-muted-foreground transition-colors hover:border-border-strong hover:text-foreground"
        >
          <Presentation className="size-4" aria-hidden />
          没有账号？看演示版
          <span className="text-xs text-faint">（假数据，不用登录）</span>
        </a>
      </div>
    </main>
  );
}
