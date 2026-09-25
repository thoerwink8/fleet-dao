import { brand } from '#brand';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './app.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MotionConfig } from 'motion/react';
import { type ReactNode, useState } from 'react';
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteError,
} from 'react-router';
import { ApiProvider } from './api/client';
import { getApi } from './api/index';
import { FAVICON, LogoMark } from './components/logo';
import { ThemeProvider, useTheme } from './components/theme-provider';
import { Toaster } from './components/ui/sonner';
import { TooltipProvider } from './components/ui/tooltip';
import { loadDemoScope } from './demo/access';
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
// 演示版在这里先把可见范围读好，页面一出来就是按范围收好的样子（不先露再收）。
export async function clientLoader() {
  await loadDemoScope();
  return null;
}

export function HydrateFallback() {
  return (
    <div className="grid h-dvh place-items-center bg-background">
      <div className="flex flex-col items-center gap-3 text-muted-foreground">
        <LogoMark className="size-10 animate-pulse" />
        <span className="text-sm">{brand.product}启动中…</span>
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

export default function App() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false, retry: 1 } },
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
  const error = useRouteError();
  const title = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : `${brand.product}出错了`;
  const detail = isRouteErrorResponse(error)
    ? String(error.data ?? '')
    : error instanceof Error
      ? error.message
      : String(error);
  return (
    <main className="grid h-dvh place-items-center bg-background p-6">
      <div className="max-w-md text-center">
        <LogoMark className="mx-auto size-10" />
        <h1 className="mt-4 text-lg font-semibold">{title}</h1>
        <p className="mt-2 text-sm break-words text-muted-foreground">{detail}</p>
        <Link to="/" className="mt-4 inline-block text-sm underline underline-offset-4">
          回到看板
        </Link>
      </div>
    </main>
  );
}
