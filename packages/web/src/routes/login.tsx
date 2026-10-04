// 登录页（在外壳外面）。四条路，按 shared/web-api.ts 的 AuthRoutes，显示哪几条由 /auth/config 决定：
// - 账密（passwordLogin 为真）：用户名 + 密码，POST /auth/password/login，成功回到 next。错误分清「用户名或密码不对」「锁了」「读不到后端」，
//   登录失败一律不透露账号在不在（后端对没这个人、没设过密码、密码错回同一句）。
// - 浏览器：跳 /auth/feishu/login?next=<站内路径>，飞书授权完回到 next。
// - 飞书客户端里：tt.requestAccess 拿 code，POST /auth/feishu/access（页面要先加载飞书 JSSDK 才有 tt）。
// - 开发环境：POST /auth/dev-login 免登（后端开了 devLogin 才显示）。

import { AUTH_PREFIX, AuthRoutes } from '@fleet-dao/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, LogIn, Presentation } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { ApiError, errorText, keys, useApi, useAuthConfig, useMe } from '../api/client';
import type { Me } from '../api/types';
import { LogoMark } from '../components/logo';
import { PasswordField } from '../components/password-field';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { DEMO_URL } from '../demo/url';
import { loginErrorText, PASSWORD_MAX, USERNAME_MAX } from '../lib/credentials';

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
  const [busy, setBusy] = useState<'feishu' | 'dev' | 'password' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const tried = useRef(false);
  const usernameRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const focused = useRef(false);

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

  // 只有后端明说开着才显示账密表单（passwordLogin 没给 = 不认这一项的旧后端，当没开）。
  const passwordReady = config.data?.passwordLogin === true;
  // 表单一出来光标就在用户名栏（只做一次，之后别抢走用户手里的焦点）。
  useEffect(() => {
    if (!passwordReady || focused.current || me.data) return;
    focused.current = true;
    usernameRef.current?.focus();
  }, [passwordReady, me.data]);

  if (me.data) return <Navigate to={next} replace />;

  const feishuReady = Boolean(appId);
  const devReady = config.data?.devLogin === true;
  // 配置读到了、一个登录入口都没开：明说，不留一个灰按钮让人猜。
  const nothingReady = Boolean(config.data) && !passwordReady && !feishuReady && !devReady;
  const loginHref = `${AUTH_PREFIX}${AuthRoutes.feishuLogin.path}?next=${encodeURIComponent(next)}`;

  const passwordSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy !== null) return;
    if (!username.trim() || !password) {
      setError('请填写用户名和密码。');
      (username.trim() ? passwordRef : usernameRef).current?.focus();
      return;
    }
    setBusy('password');
    setError(null);
    try {
      done(await api.passwordLogin(username.trim(), password));
    } catch (err) {
      setError(loginErrorText(err));
      setBusy(null);
      // 密码错了：清掉密码栏、光标回到密码栏重输；用户名留着
      if (err instanceof ApiError && err.code === 'bad_credentials') {
        setPassword('');
        passwordRef.current?.focus();
      }
    }
  };

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

  const errorBox = error ? (
    <p role="alert" className="mt-3 rounded-lg bg-st-fail/10 px-3 py-2 text-sm text-ink-fail">
      {error}
    </p>
  ) : null;

  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center text-center">
          <LogoMark className="size-12" />
          <h1 className="mt-4 text-xl font-semibold tracking-tight">登录{brand.product}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{brand.product}只放行创始人。</p>
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
              {config.isPending ? (
                <p className="text-center text-sm text-muted-foreground">正在读登录配置…</p>
              ) : null}
              {config.error ? (
                <div className="space-y-2 text-center">
                  <p className="text-sm text-ink-fail">
                    连不上{brand.product}后端：{errorText(config.error)}
                  </p>
                  <Button type="button" variant="outline" size="sm" onClick={() => void config.refetch()}>
                    重试
                  </Button>
                </div>
              ) : null}

              {passwordReady ? (
                <form onSubmit={passwordSubmit} method="post" className="space-y-4" aria-label="账号密码登录">
                  <div className="space-y-1.5">
                    <Label htmlFor="login-username">用户名</Label>
                    <Input
                      ref={usernameRef}
                      id="login-username"
                      name="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      autoComplete="username"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      maxLength={USERNAME_MAX}
                      readOnly={busy === 'password'}
                    />
                  </div>
                  <PasswordField
                    id="login-password"
                    label="密码"
                    value={password}
                    onChange={setPassword}
                    autoComplete="current-password"
                    maxLength={PASSWORD_MAX}
                    readOnly={busy === 'password'}
                    inputRef={passwordRef}
                  />
                  {errorBox}
                  <Button
                    type="submit"
                    className="h-10 w-full"
                    disabled={busy !== null}
                    aria-busy={busy === 'password'}
                  >
                    {busy === 'password' ? (
                      <>
                        <LoaderCircle className="animate-spin" aria-hidden />
                        登录中…
                      </>
                    ) : (
                      '登录'
                    )}
                  </Button>
                </form>
              ) : null}

              {passwordReady && (feishuReady || busy === 'feishu') ? (
                <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground" aria-hidden>
                  <span className="h-px flex-1 bg-border" />或<span className="h-px flex-1 bg-border" />
                </div>
              ) : null}

              {busy === 'feishu' ? (
                <Button className="h-10 w-full" disabled>
                  <LogIn />
                  正在用飞书身份登录…
                </Button>
              ) : feishuReady ? (
                <Button asChild variant={passwordReady ? 'outline' : 'default'} className="h-10 w-full">
                  <a href={loginHref}>
                    <LogIn />
                    用飞书登录
                  </a>
                </Button>
              ) : null}

              {nothingReady ? (
                <div role="alert" className="rounded-lg bg-st-fail/10 px-3 py-2.5 text-sm text-ink-fail">
                  <p className="font-medium">登录没有配好：请在服务器上设置账密或飞书。</p>
                  <p className="mt-1 text-xs">
                    后端的登录配置里，账密、飞书、开发免登都没有开，所以这里没有能点的入口。
                  </p>
                </div>
              ) : null}

              {devReady ? (
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
          {passwordReady ? null : errorBox}
        </div>
        <p className="mt-4 text-center text-xs text-muted-foreground">
          登录后回到 <span className="num">{next}</span>
        </p>
        {passwordReady ? (
          <p className="mt-2 text-center text-xs text-muted-foreground">
            还没设过账密？先用飞书登录，到「设置 →
            账密登录」里设第一次；飞书进不去时，请管理员在服务器上设（运维文档「账密登录」一节）。
          </p>
        ) : null}
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
