// 以会话用户筛 Mirasim 用量账本的行（#1935）：不整份 cat 几十 MB 的月度文件。exec 是假的，不起进程。
import { SESSION_USERS } from '@fleet-dao/adapters';
import { describe, expect, it } from 'vitest';
import type { UserCommand, UserCommandResult } from '../../src/real/exec.ts';
import { DEFAULT_MIRASIM_HOME, grepAsUser, mirasimDepsFor } from '../../src/real/index.ts';

const [USER] = SESSION_USERS;
const base = { stdout: Buffer.alloc(0), stderr: '', timedOut: false, aborted: false };

function fakeExec(answer: (c: UserCommand) => UserCommandResult) {
  const commands: UserCommand[] = [];
  const exec = async (c: UserCommand) => {
    commands.push(c);
    return answer(c);
  };
  return { exec, commands };
}

describe('grepAsUser', () => {
  it('以会话用户跑 grep -h -F，关键字按字面认；对上的行原样回', async () => {
    const { exec, commands } = fakeExec(() => ({ ...base, code: 0, stdout: Buffer.from('a\nb\n') }));
    const out = await grepAsUser(exec, USER, ['claude:abc-1', 'def'], ['/h/usage-2026-10.ndjson']);
    expect(out).toBe('a\nb\n');
    expect(commands[0]).toMatchObject({
      user: USER,
      argv: ['/bin/grep', '-h', '-F', '-e', 'claude:abc-1', '-e', 'def', '--', '/h/usage-2026-10.ndjson'],
    });
  });

  it('一行都没对上（退出 1）回空串；读不了（退出 2、超时）抛错，不回空串冒充「没有」', async () => {
    const none = fakeExec(() => ({ ...base, code: 1 }));
    expect(await grepAsUser(none.exec, USER, ['x'], ['/f'])).toBe('');
    const broken = fakeExec(() => ({ ...base, code: 2, stderr: 'grep: /f: Permission denied' }));
    await expect(grepAsUser(broken.exec, USER, ['x'], ['/f'])).rejects.toThrow('Permission denied');
    const slow = fakeExec(() => ({ ...base, code: null, timedOut: true }));
    await expect(grepAsUser(slow.exec, USER, ['x'], ['/f'])).rejects.toThrow();
  });

  it('关键字带空白或以 - 开头：不跑，免得被当成 grep 的参数', async () => {
    const { exec, commands } = fakeExec(() => ({ ...base, code: 0 }));
    await expect(grepAsUser(exec, USER, ['-r'], ['/f'])).rejects.toThrow('关键字认不出');
    await expect(grepAsUser(exec, USER, ['a b'], ['/f'])).rejects.toThrow('关键字认不出');
    expect(commands).toHaveLength(0);
  });
});

describe('mirasimDepsFor 的用量账本', () => {
  it('目录是会话用户家里的 ~/.mirasim/insights；列目录、筛行都以他的身份经 exec', async () => {
    const { exec, commands } = fakeExec((c) =>
      c.argv[0] === '/bin/ls'
        ? { ...base, code: 0, stdout: Buffer.from('usage-2026-10.ndjson\n') }
        : { ...base, code: 1 },
    );
    const deps = mirasimDepsFor(exec, DEFAULT_MIRASIM_HOME, { command: ['node', 'bridge.js'] });
    const dir = deps.meterDir(USER);
    expect(dir).toBe(`${DEFAULT_MIRASIM_HOME.replaceAll('{user}', USER)}/.mirasim/insights`);
    const fs = deps.meterFs(USER);
    expect(await fs.readdir(dir)).toEqual(['usage-2026-10.ndjson']);
    expect(await fs.linesWith(['abc'], [`${dir}/usage-2026-10.ndjson`])).toBe('');
    expect(commands.map((c) => [c.user, c.argv[0]])).toEqual([
      [USER, '/bin/ls'],
      [USER, '/bin/grep'],
    ]);
  });
});
