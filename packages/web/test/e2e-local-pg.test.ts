// e2e 起栈前查本机库（e2e/support/stack.ts 的 assertLocalPgUp）：E2E_PG_ADMIN_URL 指着本机、端口连不上时停下，说 pnpm pg:local start。
import { createServer, type Server } from 'node:net';
import { describe, expect, test } from 'vitest';
import { assertLocalPgUp } from '../e2e/support/stack.ts';

function listen(): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer((s) => s.destroy());
    server.listen(0, '127.0.0.1', () => {
      const a = server.address();
      resolve({ server, port: typeof a === 'object' && a !== null ? a.port : 0 });
    });
  });
}

describe('e2e 起栈前查本机库', () => {
  test('本机端口连得上：放行；没设、指着别的机器、认不出的连接串：不在这里查', async () => {
    const { server, port } = await listen();
    try {
      await expect(
        assertLocalPgUp(`postgres://postgres@127.0.0.1:${port}/postgres`),
      ).resolves.toBeUndefined();
      await expect(
        assertLocalPgUp(`postgres://postgres@localhost:${port}/postgres`),
      ).resolves.toBeUndefined();
    } finally {
      server.close();
    }
    await expect(assertLocalPgUp(undefined)).resolves.toBeUndefined();
    await expect(
      assertLocalPgUp('postgres://postgres@db.example.test:5432/postgres'),
    ).resolves.toBeUndefined();
    await expect(assertLocalPgUp('不是连接串')).resolves.toBeUndefined();
  });

  test('【故意造出的失败】本机端口没人听：报连不上，提示 pnpm pg:local start 和端口', async () => {
    const { server, port } = await listen();
    await new Promise((r) => server.close(r));
    await expect(assertLocalPgUp(`postgres://postgres@127.0.0.1:${port}/postgres`)).rejects.toThrow(
      new RegExp(`127\\.0\\.0\\.1:${port}，连不上.*pnpm pg:local start.*FLEET_LOCAL_PG_PORT=${port}`),
    );
  });
});
