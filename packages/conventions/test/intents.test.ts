import { describe, expect, it } from 'vitest';
import {
  IntentsError,
  type IntentsIo,
  parseIntentsArgs,
  type RemoteRun,
  readSshTarget,
  remoteCommand,
  runIntents,
  sshRunner,
} from '../src/intents.ts';

const detail = (over: Record<string, unknown> = {}) => ({
  id: 'i-42',
  seq: 42,
  status: 'new',
  chatId: 'oc_team',
  chatKind: 'group',
  revision: 3,
  firstMessageAt: '2026-10-04T06:02:00.000Z',
  lastMessageAt: '2026-10-04T06:09:00.000Z',
  messages: [
    {
      messageId: 'om_1',
      ord: 1,
      senderUserId: 'u1',
      senderName: '甲',
      sentAt: '2026-10-04T06:02:00.000Z',
      receivedAt: '2026-10-04T06:02:01.000Z',
      source: 'event',
      msgType: 'text',
      text: '第一行  两个空格\n第二行：原样，别改 "引号" 和 <标签>',
      edits: [],
      recalledAfterLink: false,
    },
    {
      messageId: 'om_2',
      ord: 2,
      senderUserId: 'u2',
      senderName: '乙',
      sentAt: '2026-10-04T06:09:00.000Z',
      receivedAt: '2026-10-04T06:09:01.000Z',
      source: 'event',
      msgType: 'text',
      text: '又一条',
      edits: [],
      recalledAfterLink: false,
    },
  ],
  links: [],
  card: { rev: 1, attempts: 0 },
  ...over,
});

const listBody = (intents: unknown[], more = false) => JSON.stringify({ ok: true, intents, more });
const ran = (stdout: string, code = 0, stderr = ''): RemoteRun => ({ code, stdout, stderr });

function io(run: RemoteRun | Error, over: Partial<IntentsIo> = {}): IntentsIo & { calls: string[] } {
  const calls: string[] = [];
  return {
    env: { FLEET_FRANCE_SSH: 'fr' },
    home: '/home/nobody',
    readText: () => {
      throw Object.assign(new Error('nope'), { code: 'ENOENT' });
    },
    run: async (host, remote) => {
      calls.push(`${host} ${remote}`);
      if (run instanceof Error) throw run;
      return run;
    },
    ...over,
    calls,
  };
}

describe('pnpm intents：参数', () => {
  it('不带子命令就是 list；--all、--json 认得', () => {
    expect(parseIntentsArgs([])).toEqual({ kind: 'list', all: false, json: false });
    expect(parseIntentsArgs(['--all', '--json'])).toEqual({ kind: 'list', all: true, json: true });
    expect(parseIntentsArgs(['list', '--all'])).toEqual({ kind: 'list', all: true, json: false });
    expect(parseIntentsArgs(['show', '42', '--json'])).toEqual({ kind: 'show', seq: 42, json: true });
  });

  it.each([
    [['show']],
    [['show', 'abc']],
    [['show', '0']],
    [['show', '4;rm -rf /']],
    [['show', '1', '2']],
    [['list', 'x']],
    [['list', '--limit', '3']],
    [['drop', '1']],
  ])('认不出的一律拒（退出码 2），不猜：%j', (argv) => {
    const err = (() => {
      try {
        parseIntentsArgs(argv);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(IntentsError);
    expect((err as IntentsError).exitCode).toBe(2);
  });

  it('法国上的命令只由这里拼：list 只认 new 或 all，show 只带整数', () => {
    expect(remoteCommand({ kind: 'list', all: false, json: false })).toMatch(
      /fleet-api intent list --status new --limit 500 --json$/,
    );
    expect(remoteCommand({ kind: 'list', all: true, json: false })).toContain('--status all');
    expect(remoteCommand({ kind: 'show', seq: 7, json: false })).toMatch(/fleet-api intent show 7 --json$/);
  });
});

describe('pnpm intents：ssh 名字（C1）', () => {
  it('环境变量优先，其次 france-ssh 第一行（跳过空行和注释）', () => {
    expect(readSshTarget({ env: { FLEET_FRANCE_SSH: ' fr ' }, home: '/h', readText: () => 'x' })).toBe('fr');
    expect(readSshTarget({ env: {}, home: '/h', readText: () => '\n# 注释\n  paris  \nother\n' })).toBe(
      'paris',
    );
  });

  it('没配：退出码 2、写「没配法国 ssh」，不说没有意图', async () => {
    const r = await runIntents([], io(ran('x'), { env: {} }));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('读不到：');
    expect(r.stderr).toContain('没配法国 ssh');
    expect(r.stdout).toBe('');
    expect(`${r.stdout}${r.stderr}`).not.toContain('0 条');
  });

  it('文件是空的、名字像 ssh 选项：都拒', () => {
    const e = (text: string) =>
      (() => {
        try {
          readSshTarget({ env: {}, home: '/h', readText: () => text });
        } catch (err) {
          return err as IntentsError;
        }
      })();
    expect(e('')?.exitCode).toBe(2);
    expect(e('-oProxyCommand=evil')?.exitCode).toBe(2);
    expect(() =>
      readSshTarget({ env: { FLEET_FRANCE_SSH: '-oX=1' }, home: '/h', readText: () => '' }),
    ).toThrow(/认不出/);
  });
});

describe('pnpm intents：读成了', () => {
  it('列出原话原样、谁说的、什么时候、归纳、已开成哪张单', async () => {
    const linked = detail({
      id: 'i-41',
      seq: 41,
      status: 'linked',
      summary: { text: '要加一个按钮', by: '指挥官会话 · Claude', at: '2026-10-04T07:00:00.000Z', covers: 2 },
      links: [{ issue: 'thoerwink8/fleet-dao#812', by: 'cli', at: '2026-10-04T07:01:00.000Z' }],
    });
    const fake = io(ran(listBody([detail(), linked])));
    const r = await runIntents(['--all'], fake);
    expect(r.code).toBe(0);
    expect(fake.calls[0]).toContain('intent list --status all');
    expect(r.stdout).toContain('读成了：全部意图 2 条');
    expect(r.stdout).toContain('意图 42');
    expect(r.stdout).toContain('第一行  两个空格\n    第二行：原样，别改 "引号" 和 <标签>');
    expect(r.stdout).toContain('说话的：甲、乙');
    expect(r.stdout).toContain('10-04 14:02 – 10-04 14:09（北京时间）');
    expect(r.stdout).toContain('AI 归纳：还没有');
    expect(r.stdout).toContain('已开成：还没开单');
    expect(r.stdout).toContain('AI 归纳（指挥官会话 · Claude 写的，不是原话');
    expect(r.stdout).toContain('已开成：thoerwink8/fleet-dao#812');
  });

  it('撤回的标出来：开单后撤回的提醒人定要不要从单子里删', async () => {
    const d = detail({
      status: 'linked',
      links: [{ issue: 'o/r#1', by: 'cli', at: '2026-10-04T07:01:00.000Z' }],
    });
    (d.messages[1] as Record<string, unknown>).recalledAt = '2026-10-04T08:00:00.000Z';
    (d.messages[1] as Record<string, unknown>).recalledAfterLink = true;
    const r = await runIntents(['show', '42'], io(ran(JSON.stringify({ ok: true, intent: d }))));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('开单后在飞书撤回了');
    expect(r.stdout).toContain('1 条原话');
  });

  it('--json 原样交回约定的形状', async () => {
    const r = await runIntents(['--json'], io(ran(listBody([detail()]))));
    expect(r.code).toBe(0);
    const body = JSON.parse(r.stdout);
    expect(body.ok).toBe(true);
    expect(body.intents[0].messages[0].text).toContain('第二行：原样');
  });

  it('真的一条都没有：明写「0 条」、退出码 0（C4）', async () => {
    const r = await runIntents([], io(ran(listBody([]))));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('0 条');
    expect(r.stdout).not.toContain('读不到');
  });

  it('列表被截了（more）：说明后面还有，不当成全部', async () => {
    const r = await runIntents([], io(ran(listBody([detail()], true))));
    expect(r.stdout).toContain('后面还有没列的');
  });
});

describe('pnpm intents：读不到绝不冒充「没有」（C2、C3）', () => {
  const notEmptyClaim = (r: { stdout: string; stderr: string }) => {
    expect(`${r.stdout}${r.stderr}`).not.toContain('没有未处理');
    expect(`${r.stdout}${r.stderr}`).not.toContain('0 条');
  };

  it('ssh 连不上（退出码 255）：非 0、读不到：原因', async () => {
    const r = await runIntents(
      [],
      io(ran('', 255, 'ssh: connect to host x port 22: Connection timed out\n')),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^读不到：ssh 连不上法国：.*Connection timed out/);
    notEmptyClaim(r);
  });

  it('超时、起不了 ssh：非 0', async () => {
    for (const reason of ['timeout', 'ssh-failed'] as const) {
      const r = await runIntents([], io(new IntentsError(reason, '原因在这')));
      expect(r.code).toBe(1);
      expect(r.stderr).toBe('读不到：原因在这');
      notEmptyClaim(r);
    }
  });

  it('法国上命令没跑成：带上它自己说的原因（连不上库）', async () => {
    const body = JSON.stringify({ ok: false, reason: 'error', why: '没做成：连不上库' });
    const r = await runIntents([], io(ran(body, 1)));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('连不上库');
    notEmptyClaim(r);
  });

  it('法国上命令没跑成、也没按约定说话：把 stderr 末行带上', async () => {
    const r = await runIntents([], io(ran('', 2, 'bash: 没有那个文件\n')));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('退出码 2');
    expect(r.stderr).toContain('没有那个文件');
    notEmptyClaim(r);
  });

  it.each([
    ['空输出', ''],
    ['半截 JSON', '{"ok":true,"intents":['],
    ['不是 JSON', 'Running as unit: run-123.service'],
    ['缺 more', JSON.stringify({ ok: true, intents: [] })],
    ['单段的形状当成列表', JSON.stringify({ ok: true, intent: detail() })],
    ['ok 为 false 却退出 0', JSON.stringify({ ok: false, reason: 'error', why: 'x' })],
    ['原话缺字段', listBody([{ ...detail(), messages: [{ ord: 1 }] }])],
  ])('退出 0 但回来的认不出（%s）：非 0、「认不出」，不当成空列表', async (_name, stdout) => {
    const r = await runIntents([], io(ran(stdout)));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^读不到：/);
    expect(r.stderr).toContain('认不出');
    notEmptyClaim(r);
  });

  it('--json 读不到：标准输出打一行 ok:false，不打 []、不打空列表', async () => {
    const r = await runIntents(['--json'], io(ran('', 255, 'refused')));
    expect(r.code).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body).toMatchObject({ ok: false, reason: 'ssh-failed' });
    expect(body.intents).toBeUndefined();
    expect(r.stderr).toContain('读不到：');
  });

  it('参数不对：退出码 2，不去连 ssh', async () => {
    const fake = io(ran(listBody([])));
    const r = await runIntents(['show', 'x'], fake);
    expect(r.code).toBe(2);
    expect(fake.calls).toEqual([]);
  });

  it('show 指的意图不存在：法国回 not_found，非 0 并带原因', async () => {
    const body = JSON.stringify({ ok: false, reason: 'not_found', why: '没有意图 9' });
    const r = await runIntents(['show', '9'], io(ran(body, 1)));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('没有意图 9');
  });
});

describe('pnpm intents：真起 ssh 这一层', () => {
  it('本机没有 ssh 命令：抛 ssh-failed 并说装 OpenSSH', async () => {
    await expect(sshRunner(5_000, 'fleet-no-such-ssh-binary')('fr', 'true')).rejects.toMatchObject({
      reason: 'ssh-failed',
      message: expect.stringContaining('OpenSSH'),
    });
  });

  it('子进程非 0 退出：退出码和输出原样交回（交给 readOutcome 判，不在这里吞）', async () => {
    // 用 node 当「ssh」：node 认不出 -o，退出码非 0、stderr 有话
    const r = await sshRunner(30_000, process.execPath)('fr', 'true');
    expect(r.code).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });
});
