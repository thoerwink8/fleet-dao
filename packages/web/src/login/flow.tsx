// 登录页三版共用的登录动作：飞书（浏览器跳转、飞书客户端里免点）、账号密码、开发免登。
// 三版只是长得不一样，登录怎么走、错了怎么说，全在这一处。

import { AUTH_PREFIX, AuthRoutes } from '@fleet-dao/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-react';
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { ApiError, errorText, keys, useApi, useAuthConfig } from '../api/client';
import type { Me } from '../api/types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { formatClock } from '../lib/format';
import { cn } from '../lib/utils';

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

export type LoginError = { kind: 'bad' | 'locked' | 'other'; text: string };

/** 账密登录失败怎么说：没这人和密码错是同一句；被锁写明锁到几点。 */
export function passwordError(e: unknown): LoginError {
  if (e instanceof ApiError && e.code === 'bad_credentials') return { kind: 'bad', text: '用户名或密码不对' };
  if (e instanceof ApiError && e.code === 'locked') {
    const until = (e.details as { until?: unknown } | undefined)?.until;
    const at = typeof until === 'string' && !Number.isNaN(Date.parse(until)) ? formatClock(until) : null;
    return {
      kind: 'locked',
      text: at
        ? `试错太多次，先锁住了：${at} 之后再试，或者用飞书登录`
        : '试错太多次，先锁住了，过一会儿再试',
    };
  }
  return { kind: 'other', text: errorText(e) };
}

export interface LoginFlow {
  source: 'http' | 'mock' | 'demo';
  /** 还在读登录配置。 */
  pending: boolean;
  /** 登录配置没读成（连不上后端）：白话说明。 */
  configError: string | null;
  feishuReady: boolean;
  /** 浏览器里用飞书登录要跳的地址。 */
  feishuHref: string;
  /** 后端明说开了账密登录才显示；读不到这一项按没开。 */
  passwordEnabled: boolean;
  devLogin: boolean;
  busy: 'feishu' | 'password' | 'dev' | null;
  error: LoginError | null;
  clearError(): void;
  /** 飞书登录：假数据模式下直接用假身份进；真后端整页跳飞书授权。 */
  feishu(): void;
  password(username: string, password: string): Promise<void>;
  dev(userId: string): Promise<void>;
}

/**
 * @param beforeEnter 登录成功、跳走之前做点什么（比如先让磨砂散开），返回的 Promise 结束才跳。
 */
export function useLoginFlow(next: string, beforeEnter?: () => Promise<void>): LoginFlow {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const config = useAuthConfig();
  const [busy, setBusy] = useState<LoginFlow['busy']>(null);
  const [error, setError] = useState<LoginError | null>(null);
  const tried = useRef(false);

  const enter = async (who: Me) => {
    qc.setQueryData(keys.me, who);
    await beforeEnter?.();
    navigate(next, { replace: true });
  };

  // 在飞书客户端里：不用点，直接拿飞书身份换登录态。
  const appId = config.data?.feishuAppId;
  useEffect(() => {
    const tt = feishuClient();
    if (!tt?.requestAccess || !appId || tried.current) return;
    tried.current = true;
    setBusy('feishu');
    tt.requestAccess({
      appID: appId,
      scopeList: [],
      success: ({ code }) => {
        api.feishuAccess(code).then(enter, (e: unknown) => {
          setBusy(null);
          setError({ kind: 'other', text: errorText(e) });
        });
      },
      fail: () => {
        setBusy(null);
        setError({ kind: 'other', text: '飞书没给授权，可以点按钮重新登录' });
      },
    });
  });

  const feishuHref = `${AUTH_PREFIX}${AuthRoutes.feishuLogin.path}?next=${encodeURIComponent(next)}`;
  const mock = api.source !== 'http';

  return {
    source: api.source,
    pending: config.isPending,
    configError: config.error ? errorText(config.error) : null,
    feishuReady: mock || Boolean(appId),
    feishuHref,
    passwordEnabled: config.data?.passwordLogin === true,
    devLogin: Boolean(config.data?.devLogin),
    busy,
    error,
    clearError: () => setError(null),
    feishu() {
      if (busy) return;
      setBusy('feishu');
      setError(null);
      if (!mock) {
        location.assign(feishuHref);
        return;
      }
      api.feishuAccess('mock').then(enter, (e: unknown) => {
        setBusy(null);
        setError({ kind: 'other', text: errorText(e) });
      });
    },
    async password(username, password) {
      if (busy) return;
      if (!username.trim() || !password) {
        setError({ kind: 'bad', text: '用户名和密码都要填' });
        return;
      }
      setBusy('password');
      setError(null);
      try {
        await enter(await api.passwordLogin(username.trim(), password));
      } catch (e) {
        setError(passwordError(e));
        setBusy(null);
      }
    },
    async dev(userId) {
      if (busy || !userId.trim()) return;
      setBusy('dev');
      setError(null);
      try {
        await enter(await api.devLogin(userId.trim()));
      } catch (e) {
        setError({ kind: 'other', text: errorText(e) });
        setBusy(null);
      }
    },
  };
}

/** 错误那一行：被锁用「停」的颜色，其余用「失败」的颜色。 */
export function LoginErrorLine({ error, className }: { error: LoginError | null; className?: string }) {
  if (!error) return null;
  return (
    <p
      role="alert"
      className={cn(
        'rounded-lg px-3 py-2 text-sm',
        error.kind === 'locked' ? 'bg-st-stall/12 text-ink-stall' : 'bg-st-fail/10 text-ink-fail',
        className,
      )}
    >
      {error.text}
    </p>
  );
}

/** 账号密码表单。三版共用一份，外观靠 className 调。 */
export function PasswordForm({
  flow,
  onCancel,
  cancelLabel = '返回',
  className,
  inputClassName,
  submitClassName,
  autoFocus = true,
  hint,
}: {
  flow: LoginFlow;
  onCancel?: () => void;
  cancelLabel?: string;
  className?: string;
  inputClassName?: string;
  submitClassName?: string;
  autoFocus?: boolean;
  hint?: ReactNode;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const locked = flow.error?.kind === 'locked';
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void flow.password(username, password);
  };
  return (
    <form onSubmit={submit} className={cn('grid gap-3', className)} noValidate aria-label="用户名密码登录">
      <div className="grid gap-1.5">
        <Label htmlFor="login-username" className="text-xs text-muted-foreground">
          用户名
        </Label>
        <Input
          id="login-username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          // biome-ignore lint/a11y/noAutofocus: 点了「用户名密码登录」才出这张表，焦点直接落进来。
          autoFocus={autoFocus}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          className={cn('h-10', inputClassName)}
        />
      </div>
      <div className="grid gap-1.5">
        <Label htmlFor="login-password" className="text-xs text-muted-foreground">
          密码
        </Label>
        <div className="relative">
          <Input
            id="login-password"
            name="password"
            type={show ? 'text' : 'password'}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={cn('h-10 pr-10', inputClassName)}
          />
          <button
            type="button"
            onClick={() => setShow(!show)}
            className="absolute inset-y-0 right-0 grid w-10 place-items-center text-muted-foreground hover:text-foreground"
            aria-label={show ? '藏起密码' : '显示密码'}
          >
            {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>
      <LoginErrorLine error={flow.error} />
      {hint}
      <div className="flex gap-2">
        <Button
          type="submit"
          className={cn('h-10 flex-1', submitClassName)}
          disabled={flow.busy !== null || locked}
        >
          {flow.busy === 'password' ? <LoaderCircle className="animate-spin" /> : <KeyRound />}
          {flow.busy === 'password' ? '登录中…' : '登录'}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" className="h-10" onClick={onCancel}>
            {cancelLabel}
          </Button>
        ) : null}
      </div>
    </form>
  );
}

/** 假数据模式下能登上的账号，写在表单下面好让人试（真后端不显示）。 */
export function MockHint({ flow }: { flow: LoginFlow }) {
  if (flow.source !== 'mock') return null;
  return (
    <p className="text-xs text-muted-foreground">
      假数据模式：用户名 <span className="num text-foreground">demo</span>、密码{' '}
      <span className="num text-foreground">demo-password</span> 能登上；连错 5 次会锁 15 分钟。
    </p>
  );
}

/** 开发环境免登（后端开了 devLogin 才有）。 */
export function DevLoginForm({ flow, className }: { flow: LoginFlow; className?: string }) {
  const [userId, setUserId] = useState('');
  if (!flow.devLogin) return null;
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void flow.dev(userId);
      }}
      className={cn('space-y-2 rounded-xl border border-dashed p-3', className)}
    >
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
        <Button type="submit" variant="secondary" disabled={!userId.trim() || flow.busy !== null}>
          {flow.busy === 'dev' ? '登录中…' : '免登'}
        </Button>
      </div>
    </form>
  );
}

/** 登录配置没读成、飞书没配置时的一行说明（不拿空冒充能用）。 */
export function ConfigNote({ flow, className }: { flow: LoginFlow; className?: string }) {
  if (flow.pending) return <p className={cn('text-xs text-muted-foreground', className)}>正在读登录配置…</p>;
  if (flow.configError)
    return (
      <p role="alert" className={cn('text-xs text-ink-fail', className)}>
        连不上后端：{flow.configError}
      </p>
    );
  if (!flow.feishuReady)
    return <p className={cn('text-xs text-muted-foreground', className)}>飞书登录还没配置。</p>;
  return null;
}
