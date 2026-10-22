// 登录页（在外壳外面；#3533 照 Arco 改版，样稿 canvas/Login.dc.html，AuthCard）。四条路，按 shared/web-api.ts 的 AuthRoutes，显示哪几条由 /auth/config 决定：
// - 账密（passwordLogin 为真）：用户名 + 密码，POST /auth/password/login，成功回到 next。错误分清「用户名或密码不对」「锁了」「读不到后端」，
//   登录失败一律不透露账号在不在（后端对没这个人、没设过密码、密码错回同一句）。
// - 浏览器：跳 /auth/feishu/login?next=<站内路径>，飞书授权完回到 next。
// - 飞书客户端里：tt.requestAccess 拿 code，POST /auth/feishu/access（页面要先加载飞书 JSSDK 才有 tt）。
// - 开发环境：POST /auth/dev-login 免登（后端开了 devLogin 才显示）。
// 读登录配置失败要明说（连不上后端 + 重试 + 状态页），不冒充「没配好」；读成过又刷新失败，表单照旧，顶上一条橙条。
// 页面只拼 components/layout 的件，不写样式类（lint-design R13–R20）。

import { AUTH_PREFIX, AuthRoutes, safeNext } from '@fleet-dao/shared';
import { useQueryClient } from '@tanstack/react-query';
import { LogIn } from 'lucide-react';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { brand } from '#brand';
import { ApiError, errorText, keys, useApi, useAuthConfig, useMe } from '../api/client';
import type { Me } from '../api/types';
import { GatewayHealthLink } from '../components/gateway-health-link';
import { AuthCard } from '../components/layout/auth-card';
import { Button } from '../components/layout/button';
import { Form, FormItem } from '../components/layout/form';
import { Input } from '../components/layout/input';
import { LoadError, LoadingRows, LoadStale } from '../components/layout/load-state';
import { Notice } from '../components/layout/notice';
import { Stack } from '../components/layout/stack';
import { Text } from '../components/layout/text';
import { PasswordField } from '../components/password-field';
import { loginErrorText, PASSWORD_MAX, USERNAME_MAX } from '../lib/credentials';

export function meta() {
  return [{ title: brand.title('登录') }];
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
  const [error, setError] = useState<{ text: string; cause: unknown } | null>(null);
  const report = (cause: unknown, text: string) => setError({ text, cause });
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
          report(e, errorText(e));
        });
      },
      fail: () => {
        setBusy(null);
        report(null, '飞书没给授权，可以点下面的按钮重新登录');
      },
    });
  });

  // 只有 mock 下有的预览：/login?preview（账密 + 飞书）、?preview=password、?preview=feishu。
  // mock 里 /api/me 永远读得到、会自动登录跳走，截不到真页面；带 preview 就不跳、不显示「假数据模式」那句，摆出真登录表单。
  // 真后端下 api.source 不是 mock，这个参数完全无效。
  const preview = api.source === 'mock' ? params.get('preview') : null;
  const previewing = preview !== null;
  // 只有后端明说开着才显示账密表单（passwordLogin 没给 = 不认这一项的旧后端，当没开）。
  const passwordReady = previewing ? preview !== 'feishu' : config.data?.passwordLogin === true;
  // 表单一出来光标就在用户名栏（只做一次，之后别抢走用户手里的焦点）。
  useEffect(() => {
    if (!passwordReady || focused.current || me.data) return;
    focused.current = true;
    usernameRef.current?.focus();
  }, [passwordReady, me.data]);

  if (me.data && !previewing) return <Navigate to={next} replace />;

  const feishuReady = previewing ? preview !== 'password' : Boolean(appId);
  const devReady = config.data?.devLogin === true;
  // 配置读到了、一个登录入口都没开：明说，不留一个灰按钮让人猜。
  const nothingReady = Boolean(config.data) && !passwordReady && !feishuReady && !devReady;
  const loginHref = `${AUTH_PREFIX}${AuthRoutes.feishuLogin.path}?next=${encodeURIComponent(next)}`;
  const connectText = (cause: unknown) => `连不上${brand.product}后端：${errorText(cause)}`;

  const passwordSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy !== null) return;
    if (!username.trim() || !password) {
      report(null, '请填写用户名和密码。');
      (username.trim() ? passwordRef : usernameRef).current?.focus();
      return;
    }
    setBusy('password');
    setError(null);
    try {
      done(await api.passwordLogin(username.trim(), password));
    } catch (err) {
      report(err, loginErrorText(err));
      setBusy(null);
      // 密码错了：清掉密码栏、光标回密码栏重输；用户名留着
      if (err instanceof ApiError && err.code === 'bad_credentials') {
        setPassword('');
        passwordRef.current?.focus();
      }
    }
  };

  const devLogin = async () => {
    if (!userId.trim()) return;
    setBusy('dev');
    setError(null);
    try {
      done(await api.devLogin(userId.trim()));
    } catch (err) {
      report(err, errorText(err));
      setBusy(null);
    }
  };

  const errorBox = error ? (
    <Notice tone="fail">
      <Stack gap="sm">
        <span>{error.text}</span>
        <GatewayHealthLink error={error.cause} />
      </Stack>
    </Notice>
  ) : null;

  return (
    <AuthCard
      logo
      title={`登录${brand.product}`}
      footer={
        <Stack gap="sm" align="center">
          <Text size="meta" tone="muted">
            {brand.product}只放行创始人。登录后回到{' '}
            <Text size="meta" mono>
              {next}
            </Text>
          </Text>
          {passwordReady ? (
            <Text size="meta" tone="muted">
              还没设过账密？先用飞书登录，到「设置 →
              账密登录」里设第一次。飞书进不去时，请管理员在服务器上设。
            </Text>
          ) : null}
        </Stack>
      }
    >
      <Stack>
        {api.source === 'mock' && !previewing ? (
          <Stack align="center">
            <Text tone="secondary">现在是假数据模式，不用登录。</Text>
            <Button block onClick={() => navigate(next, { replace: true })}>
              进{brand.product}
            </Button>
          </Stack>
        ) : (
          <>
            {config.isPending ? <LoadingRows rows={2} /> : null}
            {config.error && !config.data ? (
              <Stack gap="sm">
                <LoadError
                  error={config.error}
                  text={`没读到登录配置：${connectText(config.error)}`}
                  onRetry={() => void config.refetch()}
                />
                <GatewayHealthLink error={config.error} />
              </Stack>
            ) : null}
            {config.error && config.data ? (
              <Stack gap="sm">
                <LoadStale error={config.error} what="登录配置" onRetry={() => void config.refetch()} />
                <GatewayHealthLink error={config.error} />
              </Stack>
            ) : null}

            {passwordReady ? (
              <Form aria-label="账号密码登录" method="post" onSubmit={() => void passwordSubmit()}>
                <FormItem label="用户名" layout="vertical" htmlFor="login-username">
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
                </FormItem>
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
                  variant="primary"
                  block
                  loading={busy === 'password'}
                  {...(busy !== null && busy !== 'password' ? { disabledReason: '正在登录，请稍等' } : {})}
                >
                  {busy === 'password' ? '登录中…' : '登录'}
                </Button>
              </Form>
            ) : null}

            {passwordReady && (feishuReady || busy === 'feishu') ? (
              <Stack align="center">
                <Text size="meta" tone="muted">
                  或
                </Text>
              </Stack>
            ) : null}

            {busy === 'feishu' ? (
              <Button block disabledReason="飞书客户端里不用点，正在拿飞书身份换登录">
                <LogIn />
                正在用飞书身份登录…
              </Button>
            ) : feishuReady ? (
              // 样稿：只有飞书这一条路时它是蓝的主按钮；旁边已经有账密表单的「登录」主按钮时，它退成描边按钮（一块一个主按钮）
              <Button block variant={passwordReady ? 'outline' : 'primary'} href={loginHref} native>
                <LogIn />
                用飞书登录
              </Button>
            ) : null}

            {nothingReady ? (
              <Notice tone="fail" title="登录没有配好：请在服务器上设置账密或飞书。">
                后端的登录配置里，账密、飞书、开发免登都没有开，所以这里没有能点的入口。
              </Notice>
            ) : null}

            {devReady ? (
              <Form aria-label="开发环境免登" onSubmit={() => void devLogin()}>
                <FormItem
                  label="开发环境免登：填白名单里的用户编号"
                  layout="vertical"
                  htmlFor="dev-user"
                  help="只在后端打开了开发免登的开发环境里出现。"
                >
                  <Stack direction="horizontal" gap="sm">
                    <Input
                      id="dev-user"
                      value={userId}
                      onChange={(e) => setUserId(e.target.value)}
                      placeholder="用户编号"
                      autoComplete="off"
                    />
                    <Button
                      type="submit"
                      loading={busy === 'dev'}
                      {...(!userId.trim() || (busy !== null && busy !== 'dev')
                        ? { disabledReason: busy !== null ? '正在登录，请稍等' : '先填用户编号' }
                        : {})}
                    >
                      {busy === 'dev' ? '登录中…' : '免登'}
                    </Button>
                  </Stack>
                </FormItem>
              </Form>
            ) : null}
          </>
        )}
        {passwordReady ? null : errorBox}
      </Stack>
    </AuthCard>
  );
}
