// 假后端：真的 HTTP 服务，记下每个请求（方法、路径、请求头、JSON 体），按测试给的规则回。
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

/** hang = 一直不回；其余照写的状态码和 JSON 体回。 */
export type Reply = { status: number; body?: unknown; raw?: string } | 'hang';
export type Responder = (req: RecordedRequest, index: number) => Reply;

export interface FakeBackend {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export async function startFakeBackend(responder: Responder): Promise<FakeBackend> {
  const requests: RecordedRequest[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(recorded);
      const reply = responder(recorded, requests.length - 1);
      if (reply === 'hang') return;
      const payload = reply.raw ?? (reply.body === undefined ? '' : JSON.stringify(reply.body));
      res.writeHead(reply.status, payload ? { 'content-type': 'application/json' } : {});
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** 一个刚关掉的端口：连上去必然被拒。 */
export async function deadUrl(): Promise<string> {
  const backend = await startFakeBackend(() => ({ status: 200 }));
  await backend.close();
  return backend.url;
}
