import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { localExec } from '../../src/real/exec.ts';
import { runBoundedStream } from '../../src/real/exec-stream.ts';

const base = {
  user: 'fleet-agent-carpool' as const,
  cwd: process.cwd(),
  timeoutMs: 10_000,
  scopeId: 'snapshot-stream-test',
};

describe('复杂快照有界进出', () => {
  it('原生Node直接加载生产TS入口，不依赖Vitest扩展名映射', () => {
    const entry = new URL('../../src/real/exec.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(entry)})`],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
  it('超过普通输出界的合法流不保留整包并逐段等待消费者', async () => {
    const hash = createHash('sha256');
    const expected = createHash('sha256');
    const block = Buffer.alloc(1024 * 1024, 31);
    for (let i = 0; i < 112; i += 1) expected.update(block);
    let bytes = 0;
    let active = false;
    const result = await localExec()({
      ...base,
      argv: [
        process.execPath,
        '-e',
        `const b=Buffer.alloc(1048576,31);(async()=>{for(let i=0;i<112;i++)if(!process.stdout.write(b))await new Promise(r=>process.stdout.once('drain',r));})();`,
      ],
      snapshotStream: {
        output: async (chunk) => {
          expect(active).toBe(false);
          active = true;
          await Promise.resolve();
          hash.update(chunk);
          bytes += chunk.length;
          active = false;
        },
      },
    });
    expect(result.code).toBe(0);
    expect(result.stdout.length).toBe(0);
    expect(bytes).toBe(112 * 1024 * 1024);
    expect(hash.digest('hex')).toBe(expected.digest('hex'));
  });

  it('双向流逐字节一致，消费者写入失败杀同 scope 且不伪成功', async () => {
    let stops = 0;
    const result = await runBoundedStream(
      {
        command: process.execPath,
        args: ['-e', 'process.stdin.pipe(process.stdout)'],
        cwd: process.cwd(),
        env: {},
      },
      {
        ...base,
        argv: [],
        snapshotStream: {
          input: (async function* () {
            yield Buffer.from('payload');
          })(),
          output: async () => {
            throw new Error('ENOSPC');
          },
        },
      },
      async () => {
        stops += 1;
      },
      100,
    );
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('ENOSPC');
    expect(stops).toBe(1);
  });

  it('阻塞消费者也受同一个 deadline 与收尾上限约束', async () => {
    const result = await runBoundedStream(
      {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("x");setInterval(()=>{},1000)'],
        cwd: process.cwd(),
        env: {},
      },
      {
        ...base,
        argv: [],
        timeoutMs: 150,
        snapshotStream: {
          output: async (_chunk, signal) => {
            await new Promise<void>((resolve) =>
              signal.addEventListener('abort', () => resolve(), { once: true }),
            );
          },
        },
      },
      undefined,
      100,
    );
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(true);
  });
});
