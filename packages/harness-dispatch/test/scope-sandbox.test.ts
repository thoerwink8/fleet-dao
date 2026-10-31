// 工人以会话用户跑的真实现（#3814）：帮手协议——先问能力、按回执身份删、scope 编号带前缀、坏输入不上命令行。
// 用假帮手（fake-scope-helper.mjs）走真的 runCommand；真帮手的边界在 deploy/test/agent-scope*.sh 里测。
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SandboxError, scopeSandbox } from '../src/scope-sandbox.ts';

const HELPER = fileURLToPath(new URL('./fake-scope-helper.mjs', import.meta.url));
let root: string;
let n = 0;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet2-scope-sandbox-test-'));
});

function fake(mode = 'ok') {
  const log = join(root, `log-${++n}.jsonl`);
  const sandbox = scopeSandbox({
    sudo: [process.execPath, HELPER, log, mode],
    helper: 'fleet-agent-scope',
    hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
  });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as string[])
      : [];
  return { sandbox, calls };
}

describe('帮手协议', () => {
  it('adopt 先问能力；release 按回执的身份删；stop 的编号带 fleet2- 前缀', async () => {
    const { sandbox, calls } = fake();
    const h = await sandbox.adopt('/var/lib/fleet-work/_fleet2/w1');
    await h.release();
    await sandbox.stop('d7-a1');
    expect(calls()).toEqual([
      ['capabilities'],
      ['adopt', '/var/lib/fleet-work/_fleet2/w1', '--user', 'fleet-agent-carpool'],
      ['capabilities'],
      ['remove', '/var/lib/fleet-work/_fleet2/w1', '--dev', '64769', '--ino', '1234', '--uid', '1001'],
      ['stop', 'fleet2-d7-a1'],
    ]);
  });

  it('旧版帮手（能力不全）不交；回执身份对不上、删的不是原来那个都拒', async () => {
    await expect(fake('old-helper').sandbox.adopt('/var/lib/fleet-work/_fleet2/w2')).rejects.toThrow(
      '不支持完整的交树、删树协议',
    );
    await expect(fake('wrong-identity').sandbox.adopt('/var/lib/fleet-work/_fleet2/w3')).rejects.toThrow(
      '回执里的目录身份不是',
    );
    const h = await fake('remove-other').sandbox.adopt('/var/lib/fleet-work/_fleet2/w4');
    await expect(h.release()).rejects.toThrow('删除回执不是原来交出去的目录');
  });

  it('帮手退出码非 0 带出原因；相对路径、编号不合法不上命令行', async () => {
    await expect(fake('adopt-fails').sandbox.adopt('/var/lib/fleet-work/_fleet2/w5')).rejects.toThrow(
      'path outside managed root',
    );
    await expect(fake('stop-fails').sandbox.stop('d8-a1')).rejects.toThrow('systemctl stop failed');
    const { sandbox, calls } = fake();
    await expect(sandbox.adopt('relative/dir')).rejects.toBeInstanceOf(SandboxError);
    await expect(sandbox.stop('x'.repeat(60))).rejects.toThrow('scope 编号不合法');
    expect(calls()).toEqual([]);
  });
});
