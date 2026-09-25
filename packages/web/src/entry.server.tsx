// 只在构建时跑一次：纯前端单页模式下，把外壳（启动画面）渲染成 dist/client/index.html。
// 自己写这一份，是为了不让框架在构建时往 package.json 里自动加 isbot 并重装依赖。
import { renderToReadableStream } from 'react-dom/server';
import { type EntryContext, ServerRouter } from 'react-router';

export default async function handleRequest(
  request: Request,
  status: number,
  headers: Headers,
  context: EntryContext,
) {
  const body = await renderToReadableStream(<ServerRouter context={context} url={request.url} />);
  await body.allReady;
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
}
