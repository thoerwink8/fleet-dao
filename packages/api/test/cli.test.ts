// fleet-api set-password（#120）：只给白名单里的人设；密码读两遍要一致、不从参数传；每条拒绝的路都造一遍。
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CliError, type Prompter, parseSetPasswordArgs, setPassword } from '../src/cli.ts';
import { DEV_USER_ID, devFixtures, IDS } from '../src/dev-fixtures.ts';
import { createMemoryStore } from '../src/memory-store.ts';
import { verifyPassword } from '../src/password.ts';

const PASSWORD = 'initial-words-only';

function scripted(answers: string[]): Prompter & { asked: string[] } {
  const asked: string[] = [];
  const next = async (q: string) => {
    asked.push(q);
    const a = answers.shift();
    if (a === undefined) throw new Error(`没准备这个问题的答案：${q}`);
    return a;
  };
  return { asked, ask: next, askHidden: next };
}

function run(args: string[], answers: string[], store = createMemoryStore(devFixtures(new Date()))) {
  const prompt = scripted(answers);
  return {
    store,
    prompt,
    result: setPassword({
      store,
      args: parseSetPasswordArgs(args),
      prompt,
      now: () => new Date('2026-09-26T00:00:00Z'),
    }),
  };
}

describe('参数', () => {
  it('不认的参数一律拒，包括想从参数传密码的；缺人、多参数也拒', () => {
    for (const argv of [
      [],
      ['a', 'b'],
      ['a', '--password', 'x'],
      ['a', '--password=x'],
      ['a', '-p'],
      ['a', '--username'],
    ]) {
      expect(() => parseSetPasswordArgs(argv), argv.join(' ')).toThrow(CliError);
    }
    expect(parseSetPasswordArgs(['创始人甲', '--username', 'boss'])).toEqual({
      who: '创始人甲',
      username: 'boss',
    });
  });
});

describe('set-password', () => {
  it('按飞书名找到人、没用户名就问一个、密码两遍一致：设上，能验过；输出和操作记录里没有密码', async () => {
    const { store, prompt, result } = run(['创始人甲'], ['boss', PASSWORD, PASSWORD]);
    const message = await result;
    expect(message).not.toContain(PASSWORD);
    expect(prompt.asked).toHaveLength(3);
    const creds = store.data.credentials.get(DEV_USER_ID);
    expect(creds?.username).toBe('boss');
    expect(await verifyPassword(PASSWORD, creds?.passwordHash ?? '')).toBe(true);
    const entry = store.data.audit.at(-1);
    expect(entry).toMatchObject({ action: 'credentials.set', target: `user:${DEV_USER_ID}`, via: 'engine' });
    expect(JSON.stringify(store.data.audit)).not.toContain(PASSWORD);
  });

  it('按用户 id 找也行；已有用户名就不问', async () => {
    const store = createMemoryStore(devFixtures(new Date()));
    await run([DEV_USER_ID], ['boss', PASSWORD, PASSWORD], store).result;
    const again = run([DEV_USER_ID], [`${PASSWORD}-2`, `${PASSWORD}-2`], store);
    await again.result;
    expect(again.prompt.asked).toHaveLength(2);
    expect(store.data.credentials.get(DEV_USER_ID)?.username).toBe('boss');
  });

  it('不在白名单的人（机器人、停用的创始人）：拒，什么都不改', async () => {
    const data = devFixtures(new Date());
    data.users = (data.users ?? []).map((u) => (u.id === IDS.founderB ? { ...u, active: false } : u));
    const store = createMemoryStore(data);
    for (const who of [IDS.botWorker, '干活的机器人', IDS.founderB]) {
      await expect(
        run([who, '--username', 'someone'], [PASSWORD, PASSWORD], store).result,
        who,
      ).rejects.toThrow(/不在驾驶舱白名单/);
    }
    expect(store.data.credentials.size).toBe(0);
  });

  it('库里没这个人、同名的有好几个：拒', async () => {
    await expect(run(['没这个人'], []).result).rejects.toThrow(/没有/);
    const data = devFixtures(new Date());
    data.users = (data.users ?? []).map((u) =>
      u.id === IDS.founderB ? { ...u, displayName: '创始人甲' } : u,
    );
    await expect(run(['创始人甲'], [], createMemoryStore(data)).result).rejects.toThrow(/有 2 个/);
  });

  it('两遍不一样、密码太短、用户名不合格、用户名被占：拒，什么都不改', async () => {
    const cases: [string[], string[], RegExp][] = [
      [['创始人甲', '--username', 'boss'], [PASSWORD, `${PASSWORD}x`], /两遍不一样/],
      [['创始人甲', '--username', 'boss'], ['short'], /至少 10 位/],
      [['创始人甲', '--username', 'a b'], [], /用户名/],
      [['创始人甲'], ['-bad', PASSWORD, PASSWORD], /用户名/],
    ];
    for (const [args, answers, want] of cases) {
      const { store, result } = run(args, answers);
      await expect(result, args.join(' ')).rejects.toThrow(want);
      expect(store.data.credentials.size).toBe(0);
    }
    const store = createMemoryStore(devFixtures(new Date()));
    await run([IDS.founderB, '--username', 'Boss'], [PASSWORD, PASSWORD], store).result;
    await expect(run(['创始人甲', '--username', 'boss'], [PASSWORD, PASSWORD], store).result).rejects.toThrow(
      /已经有人用了/,
    );
    expect(store.data.credentials.get(DEV_USER_ID)).toBeUndefined();
  });
});

describe('命令行入口（真起一个 node 进程）', () => {
  const bin = fileURLToPath(new URL('../src/bin/fleet-api.ts', import.meta.url));
  const exec = (args: string[]) => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    return spawnSync(process.execPath, [bin, ...args], { env, encoding: 'utf8', input: '' });
  };

  it('没带库连接、参数想传密码、不认的命令：退出码 2，说清原因，不连库', () => {
    const noDb = exec(['set-password', '创始人甲']);
    expect(noDb.status).toBe(2);
    expect(noDb.stderr).toContain('DATABASE_URL');
    const withPassword = exec(['set-password', '创始人甲', '--password', 'x']);
    expect(withPassword.status).toBe(2);
    expect(withPassword.stderr).toContain('密码不从参数传');
    expect(withPassword.stderr).not.toContain('x\n');
    expect(exec(['drop-everything']).status).toBe(2);
  });
});
