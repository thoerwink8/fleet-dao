import { brand } from '#brand';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './app.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { type ReactNode, useEffect, useState } from 'react';
import { Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteError } from 'react-router';
import { ApiProvider } from './api/client';
import { getApi } from './api/index';
import { retryUnlessGateway } from './api/poll-backoff';
import { FAVICON, LogoMark } from './components/logo';
import { RouteErrorPage } from './components/route-error';
import { ThemeProvider, useTheme } from './components/theme-provider';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { listenForInstall } from './lib/pwa/install';
import { registerServiceWorker } from './lib/pwa/register';
import { THEME_BOOT_SCRIPT } from './lib/theme';

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" data-palette="graphite" data-mode="dark" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <title>{brand.title()}</title>
        <link rel="icon" href={FAVICON} />
        {/* 装成 APP（#2050）：manifest 在 public/，service worker 见 lib/pwa/register.ts */}
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
        <meta name="theme-color" content="#15161a" />
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: 固定的主题启动脚本，不含任何外部输入；要在首次绘制前挂上主题，避免闪色。 */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

// 根路由带一个 clientLoader：构建时只渲染下面的启动画面，应用本体只在浏览器里跑。
export async function clientLoader() {
  return null;
}

export function HydrateFallback() {
  return (
    <div className="grid h-dvh place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <LogoMark className="size-10 animate-pulse" />
        <span className="text-body">{brand.product}启动中…</span>
      </div>
    </div>
  );
}

function Motion({ children }: { children: ReactNode }) {
  const { pref } = useTheme();
  return (
    <MotionConfig reducedMotion={pref.motion === 'reduced' ? 'always' : 'user'}>{children}</MotionConfig>
  );
}

// beforeinstallprompt 页面一加载就可能来、错过了没有第二次：模块一载入就挂，不等组件挂上
listenForInstall();

export default function App() {
  useEffect(() => registerServiceWorker(), []);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: retryUnlessGateway },
        },
      }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ApiProvider api={getApi()}>
        <ThemeProvider>
          <Motion>
            <TooltipProvider delayDuration={250}>
              <Outlet />
              <Toaster position="bottom-right" />
            </TooltipProvider>
          </Motion>
        </ThemeProvider>
      </ApiProvider>
    </QueryClientProvider>
  );
}

export function ErrorBoundary() {
  return <RouteErrorPage error={useRouteError()} />;
}
