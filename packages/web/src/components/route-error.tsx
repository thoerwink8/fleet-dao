// 顶层出错页和读失败横幅共用的人话：主文案说发生了什么、能做什么，原始报错收在「详情」里。
import { errMessage } from '@fleet-dao/shared/util';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router';
import { LogoMark } from './logo';

export function errorRaw(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'raw' in error && typeof error.raw === 'string') {
    return error.raw;
  }
  return '';
}

export function ErrorDetail({ summary, raw }: { summary: string; raw: string }) {
  return (
    <>
      <p data-error-summary>{summary}</p>
      {raw ? (
        <details className="mt-2 text-left">
          <summary className="cursor-pointer text-meta text-muted-foreground">详情</summary>
          <p data-error-raw className="mt-1 break-words text-meta text-muted-foreground">
            {raw}
          </p>
        </details>
      ) : null}
    </>
  );
}

function routeRaw(statusText: string, data: unknown): string {
  const extra = data == null || data === '' ? '' : typeof data === 'string' ? data : JSON.stringify(data);
  return [statusText, extra].filter((part) => part !== '').join('\n');
}

function routeBits(error: unknown): { status: number; raw: string } | null {
  if (isRouteErrorResponse(error))
    return { status: error.status, raw: routeRaw(error.statusText, error.data) };
  if (typeof error === 'object' && error !== null && 'status' in error && 'statusText' in error) {
    const row = error as { status: unknown; statusText: unknown; data?: unknown };
    if (typeof row.status === 'number' && typeof row.statusText === 'string') {
      return { status: row.status, raw: routeRaw(row.statusText, row.data) };
    }
  }
  return null;
}

/** 路由崩了时画的那一页。error 由出错边界传入（测试直接给）。 */
export function RouteErrorPage({ error }: { error: unknown }) {
  const route = routeBits(error);
  const summary = route
    ? `这一页没打开（状态 ${route.status}）。回到看板，或刷新再试一次。`
    : '页面画到一半出错了。回到看板，或刷新再试一次。';
  const raw = route ? route.raw : errMessage(error);
  return (
    <main className="grid h-dvh place-items-center bg-background p-6">
      <div className="max-w-md text-center">
        <LogoMark className="mx-auto size-10" />
        <h1 className="mt-4 text-heading font-semibold">这一页没能显示</h1>
        <ErrorDetail summary={summary} raw={raw} />
        <Link to="/" className="mt-4 inline-block text-body underline underline-offset-4">
          回到看板
        </Link>
      </div>
    </main>
  );
}

export function ErrorBoundary() {
  return <RouteErrorPage error={useRouteError()} />;
}
