// 帅位只一个（#299）本机这边的脚本（seat-lib.mjs：seat.mjs、claim.mjs、推前钩子）：ssh 换成照着法国 fleet-api 回话的假的，
// 家目录用临时的，git 配置和 GitHub 都在内存里。没登法国的钥匙、连不上、回的东西认不出、不是帅位、认领号对不上，
// 每条失败路径都故意造一遍：一律明说，不当成没事；推前钩子连不上法国只警告、照推，认领对不上才拦。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeGitHub, NOW, SCRIPTS } from './helpers/doing.ts';

interface SshResult {
  status: number | null;
  stdout: string;
  stderr: string | Buffer;
  error?: string | undefined;
}
interface Io {
  ssh: (args: string[], input?: string) => SshResult;
  git: (args: string[]) => SshResult;
  gh: (args: string[], input?: string) => string;
  env: Record<string, string | undefined>;
  home: string;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  readStdin: () => Promise<string>;
  out: (text: string) => void;
  err: (text: string) => void;
}
interface SeatLib {
  FLEET_API: string;
  shellQuote(s: string): string;
  readableStderr(raw: string | Buffer): string;
  runSeat(argv: string[], io: Io): Promise<number>;
  runClaim(argv: string[], io: Io): Promise<number>;
}

const lib = (await import(pathToFileURL(join(SCRIPTS, 'seat-lib.mjs')).href)) as SeatLib;
const REPO = 'acme/fleet-dao';
const CLAIM_ID = '0f0e0d0c-0000-4000-8000-000000000001';
const OTHER_ID = '0a0b0c0d-0000-4000-8000-000000000002';

const homes: string[] = [];
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

/** 远端命令里的参数（去掉 bash … fleet-api 和引号）。 */
function remoteArgs(command: string): string[] {
  const rest = command.slice(lib.FLEET_API.length).trim();
  return [...rest.matchAll(/'((?:[^']|'\\'')*)'/g)].map((m) => (m[1] ?? '').replace(/'\\''/g, "'"));
}

type Reply =
  | { status: number; json?: unknown; stdout?: string; stderr?: string | Buffer }
  | ((args: string[]) => SshResult);

function world(opts: { host?: string | null; machine?: string } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'fleet-seat-'));
  homes.push(home);
  mkdirSync(join(home, '.fleet-dao'), { recursive: true });
  if (opts.host !== null)
    writeFileSync(join(home, '.fleet-dao', 'france-ssh'), `${opts.host ?? 'contabo'}\n`);
  const calls: { args: string[]; input?: string | undefined; host: string }[] = [];
  const replies: Reply[] = [];
  const config = new Map<string, string>([['remote.origin.url', `https://github.com/${REPO}.git`]]);
  const github = fakeGitHub();
  const out: string[] = [];
  const err: string[] = [];
  let clock = NOW.getTime();
  let stdin = '';
  const io: Io = {
    ssh(args, input) {
      const command = args.at(-1) ?? '';
      calls.push({ args: remoteArgs(command), input, host: args.at(-2) ?? '' });
      const reply = replies.shift();
      if (reply === undefined) throw new Error(`用例没给第 ${calls.length} 次 ssh 的回话：${command}`);
      if (typeof reply === 'function') return reply(remoteArgs(command));
      return {
        status: reply.status,
        stdout: reply.stdout ?? (reply.json === undefined ? '' : `${JSON.stringify(reply.json)}\n`),
        stderr: reply.stderr ?? '',
      };
    },
    git(args) {
      if (args[0] === 'config' && args[1] === '--get') {
        const v = config.get(args[2] ?? '');
        return v === undefined
          ? { status: 1, stdout: '', stderr: '' }
          : { status: 0, stdout: `${v}\n`, stderr: '' };
      }
      if (args[0] === 'config' && args.length === 3) {
        config.set(args[1] ?? '', args[2] ?? '');
        return { status: 0, stdout: '', stderr: '' };
      }
      return { status: 128, stdout: '', stderr: `假 git 不认得：${args.join(' ')}` };
    },
    gh: github.gh,
    env: { FLEET_MACHINE: opts.machine ?? '本机' },
    home,
    now: () => new Date(clock),
    sleep: async () => {},
    readStdin: async () => stdin,
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  };
  return {
    io,
    home,
    calls,
    replies,
    config,
    github,
    out,
    err,
    advance: (minutes: number) => {
      clock += minutes * 60_000;
    },
    setStdin: (text: string) => {
      stdin = text;
    },
    states: () =>
      readdirSync(join(home, '.fleet-dao', 'seat')).map((n) =>
        JSON.parse(readFileSync(join(home, '.fleet-dao', 'seat', n), 'utf8')),
      ),
    seat: (argv: string[]) => lib.runSeat(argv, io),
    claim: (argv: string[]) => lib.runClaim(argv, io),
  };
}

const lease = (term: number, machine = '本机', session = 's1', scope = 'main') => ({
  scope,
  term,
  holder: { machine, session },
  previous: term > 1 ? { machine: '笔记本', session: 's0' } : null,
  acquiredAt: NOW.toISOString(),
  renewedAt: NOW.toISOString(),
  handoff: null,
  handoffAt: null,
});
const taken = (term = 3, scope = 'main') => ({
  status: 0,
  json: {
    ok: true,
    seat: lease(term, '本机', 's1', scope),
    leaseMinutes: 45,
    expiresAt: '2026-09-27T03:45:00.000Z',
    now: NOW.toISOString(),
  },
});
const claimJson = (over: Record<string, unknown> = {}) => ({
  repo: REPO,
  issue: 40,
  claimId: CLAIM_ID,
  owner: { kind: 'worker', machine: '本机', label: 'w1' },
  seat: { scope: 'main', term: 3 },
  state: 'claimed',
  active: true,
  prs: [],
  graceMinutes: 120,
  claimedAt: NOW.toISOString(),
  heartbeatAt: NOW.toISOString(),
  endedAt: null,
  endReason: null,
  note: null,
  ...over,
});

describe('seat.mjs：接班', () => {
  it('【故意造出的失败】没有登法国的钥匙（~/.fleet-dao/france-ssh 不在）：接不了班，退出码 2，不碰 ssh', async () => {
    const w = world({ host: null });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.join('\n')).toContain('这台没有登法国的钥匙');
    expect(w.calls).toEqual([]);
  });

  it('接班：经 ssh 调 fleet-api seat take（带 --json），记下第几任、租期；机器名用 doing.mjs 那个', async () => {
    const w = world();
    w.replies.push(taken(3));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    expect(w.calls).toEqual([
      {
        host: 'contabo',
        args: ['seat', 'take', '--machine', '本机', '--session', 's1', '--scope', 'main', '--json'],
        input: undefined,
      },
    ]);
    expect(w.states()).toEqual([
      expect.objectContaining({
        scope: 'main',
        machine: '本机',
        session: 's1',
        term: 3,
        leaseMinutes: 45,
        retired: null,
      }),
    ]);
    expect(w.out.join('\n')).toContain('接班了：main 第 3 任是 本机/s1；上一任是 笔记本/s0（第 2 任）');
  });

  it('【故意造出的失败】ssh 连不上、回的不是 JSON、回的接班结果对不上、法国说没做成：都退出码 2、按不是帅位算，不记帅位', async () => {
    const w = world();
    w.replies.push({ status: 255, stderr: 'ssh: connect to host contabo port 22: Connection timed out\n' });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain(
      '没接上班：ssh 连不上法国：ssh: connect to host contabo port 22: Connection timed out（按不是帅位算）',
    );
    w.replies.push({ status: 0, stdout: '接班了（这不是 JSON）\n' });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain('法国回的不是一行 JSON');
    w.replies.push({ status: 0, json: { ok: true, seat: lease(3, '笔记本', 's9') } });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain('法国回的接班结果对不上');
    w.replies.push({ status: 1, json: { ok: false, reason: 'error', why: '没做成：连不上库' } });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain('没接上班：没做成：连不上库');
    w.replies.push({
      status: 127,
      stderr: 'bash: /srv/fleet-dao-releases/current/packages/api/bin/fleet-api: No such file\n',
    });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain('退出码 127');
    expect(() => w.states()).toThrow();
  });

  it('【故意造出的失败】法国回的租期没有、认不出：不记帅位（本机判不了过期，记下就一直算数），退出码 2', async () => {
    const w = world();
    for (const leaseMinutes of [null, undefined, 0, 1.5, '45']) {
      const r = taken(3);
      w.replies.push({ ...r, json: { ...r.json, leaseMinutes } });
      expect(await w.seat(['take', '--session', 's1']), String(leaseMinutes)).toBe(2);
      expect(w.err.at(-1)).toContain('法国回的租期认不出');
    }
    expect(() => w.states()).toThrow();
  });

  it('【故意造出的失败】本机的帅位记录里租期是空的（旧版本记的）：认不出，按不是帅位算、叫重新接班，不当成永不过期', async () => {
    const w = world();
    w.replies.push(taken(3));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    const dir = join(w.home, '.fleet-dao', 'seat');
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), leaseMinutes: null }));
    }
    expect(await w.seat(['check'])).toBe(2);
    expect(w.err.at(-1)).toContain('leaseMinutes 认不出');
    expect(w.calls).toHaveLength(1);
  });

  it('参数不对退出码 1，不碰 ssh', async () => {
    const w = world();
    expect(await w.seat(['take'])).toBe(1);
    expect(await w.seat(['take', '--session', 'a b'])).toBe(1);
    expect(await w.seat(['take', '--session', 's1', '--scope', 'prod'])).toBe(1);
    expect(await w.seat(['bogus'])).toBe(1);
    expect(w.calls).toEqual([]);
  });
});

describe('seat.mjs：续约、现查、退役、交接', () => {
  async function seated() {
    const w = world();
    w.replies.push(taken(3));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    w.out.length = 0;
    return w;
  }

  it('现查：对得上是帅位（经 ssh 核任期）；续约成了记下这一次', async () => {
    const w = await seated();
    w.replies.push({
      status: 0,
      json: { ok: true, term: 3, expiresAt: '2026-09-27T03:45:00.000Z', now: NOW.toISOString() },
    });
    expect(await w.seat(['check'])).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual([
      'seat',
      'check',
      '--machine',
      '本机',
      '--session',
      's1',
      '--term',
      '3',
      '--scope',
      'main',
      '--json',
    ]);
    w.advance(20);
    w.replies.push(taken(3));
    expect(await w.seat(['renew'])).toBe(0);
    expect(w.states()[0].renewedOkAt).toBe(new Date(NOW.getTime() + 20 * 60_000).toISOString());
  });

  it('【故意造出的失败】离上次续约成功超过租期：现查直接判不是帅位（退出码 3），不等法国回话', async () => {
    const w = await seated();
    const before = w.calls.length;
    w.advance(46);
    expect(await w.seat(['check'])).toBe(3);
    expect(w.err.at(-1)).toContain('离上次续约成功已经 46 分钟（租期 45 分钟）');
    expect(w.calls.length).toBe(before);
    // 续约照样能续（过期只说明联系不上），续上了现查又是帅位
    w.replies.push(taken(3));
    expect(await w.seat(['renew'])).toBe(0);
    w.replies.push({ status: 0, json: { ok: true, term: 3, expiresAt: 'x', now: 'y' } });
    expect(await w.seat(['check'])).toBe(0);
  });

  it('【故意造出的失败】换了人：现查退出码 3、记成已退役；之后续约、认领都不再去法国，交接说明照样能补', async () => {
    const w = await seated();
    w.replies.push({
      status: 3,
      json: {
        ok: false,
        reason: 'replaced',
        why: '帅位已经是 笔记本/s2（第 4 任）',
        seat: lease(4, '笔记本', 's2'),
        now: NOW.toISOString(),
      },
    });
    expect(await w.seat(['check'])).toBe(3);
    expect(w.err.at(-1)).toContain('你已经退役——停派新活');
    expect(w.states()[0].retired).toMatchObject({ why: '帅位已经是 笔记本/s2（第 4 任）' });
    const before = w.calls.length;
    expect(await w.seat(['renew'])).toBe(3);
    expect(await w.claim(['take', '41', '--label', 'w1'])).toBe(3);
    expect(w.err.at(-1)).toContain('没认领：你已经不是帅位');
    expect(w.calls.length).toBe(before);
    w.setStdin('#40 在等创始人拍；工人 w1 在做 #41');
    w.replies.push({ status: 0, json: { ok: true, seat: lease(4, '笔记本', 's2') } });
    expect(await w.seat(['handoff'])).toBe(0);
    expect(w.calls.at(-1)).toMatchObject({
      args: [
        'seat',
        'handoff',
        '--machine',
        '本机',
        '--session',
        's1',
        '--term',
        '3',
        '--scope',
        'main',
        '--json',
      ],
      input: '#40 在等创始人拍；工人 w1 在做 #41',
    });
  });

  it('【故意造出的失败】这台没接过班、有好几份记录、记录坏了：都明说，不当成是帅位', async () => {
    const w = world();
    expect(await w.seat(['check'])).toBe(2);
    expect(w.err.at(-1)).toContain('这台没有 main 的帅位记录');
    w.replies.push(taken(3), {
      status: 0,
      json: { ok: true, seat: { ...lease(4, '本机', 's2') }, leaseMinutes: 45 },
    });
    await w.seat(['take', '--session', 's1']);
    await w.seat(['take', '--session', 's2']);
    expect(await w.seat(['check'])).toBe(2);
    expect(w.err.at(-1)).toContain('这台有好几份 main 的帅位记录（会话 s1、s2）');
    const dir = join(w.home, '.fleet-dao', 'seat');
    writeFileSync(join(dir, readdirSync(dir)[0] ?? 'x.json'), '{"scope":"main"');
    expect(await w.seat(['check', '--session', 's2'])).toBe(2);
    expect(w.err.at(-1)).toMatch(/帅位记录 .+ 认不出/);
  });
});

describe('claim.mjs：认领、报一步、做完', () => {
  async function seated(scope = 'main') {
    const w = world();
    w.replies.push(taken(3, scope));
    expect(await w.seat(['take', '--session', 's1', '--scope', scope])).toBe(0);
    return w;
  }

  it('帅位认领：经 ssh 调 claim take（带着任期），认领号记进分支的 git 配置，单上留「在做」镜子', async () => {
    const w = await seated();
    w.replies.push({ status: 0, json: { ok: true, claim: claimJson(), now: NOW.toISOString() } });
    expect(await w.claim(['take', '40', '--label', 'w1', '--note', '开工', '--branch', 'feat/40-x'])).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual([
      'claim',
      'take',
      REPO,
      '40',
      '--machine',
      '本机',
      '--session',
      's1',
      '--term',
      '3',
      '--scope',
      'main',
      '--label',
      'w1',
      '--owner',
      'worker',
      '--note',
      '开工',
      '--json',
    ]);
    expect(w.config.get('branch.feat/40-x.fleetClaim')).toBe(`${REPO}#40:${CLAIM_ID}`);
    expect(w.out.join('\n')).toContain(`认领号 ${CLAIM_ID}（开 PR 时正文「认领」栏写它）`);
    expect(w.github.claims(40)).toMatchObject([{ state: 'doing', machine: '本机', text: '开工' }]);
  });

  it('演练座位：不改单上的镜子', async () => {
    const w = await seated('drill:299');
    w.replies.push({
      status: 0,
      json: { ok: true, claim: claimJson({ seat: { scope: 'drill:299', term: 3 } }) },
    });
    expect(await w.claim(['take', '40', '--label', 'w1', '--scope', 'drill:299'])).toBe(0);
    expect(w.github.comments).toEqual([]);
  });

  it('【故意造出的失败】别人拿着、法国说不是帅位：退出码 3，写明现在归谁；不记 git 配置、不留镜子', async () => {
    const w = await seated();
    w.replies.push({
      status: 3,
      json: {
        ok: false,
        reason: 'held',
        claim: claimJson({ owner: { kind: 'engine', machine: null, label: null }, state: 'doing' }),
      },
    });
    expect(await w.claim(['take', '40', '--label', 'w1', '--branch', 'feat/40-x'])).toBe(3);
    expect(w.err.at(-1)).toContain(`没认领上：${REPO}#40 归 引擎（doing）`);
    w.replies.push({
      status: 3,
      json: { ok: false, reason: 'not_seat', why: '帅位已经是 笔记本/s2（第 4 任）' },
    });
    expect(await w.claim(['take', '40', '--label', 'w1'])).toBe(3);
    expect(w.err.at(-1)).toContain('没认领上：帅位已经是 笔记本/s2（第 4 任）');
    expect(w.config.has('branch.feat/40-x.fleetClaim')).toBe(false);
    expect(w.github.comments).toEqual([]);
  });

  it('工人报一步、登记 PR、做完：认领号对得上才记；【故意造出的失败】对不上退出码 3，写明现在归谁、别再动', async () => {
    const w = await seated();
    w.replies.push({ status: 0, json: { ok: true, claim: claimJson() } });
    await w.claim(['take', '40', '--label', 'w1']);
    w.replies.push({ status: 0, json: { ok: true, claim: claimJson({ state: 'pr_open', prs: [88] }) } });
    expect(await w.claim(['step', '40', '--claim', CLAIM_ID, '--note', '开了 PR', '--pr', '#88'])).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual([
      'claim',
      'step',
      REPO,
      '40',
      '--claim',
      CLAIM_ID,
      '--note',
      '开了 PR',
      '--pr',
      '88',
      '--json',
    ]);
    expect(w.github.claims(40)).toMatchObject([{ state: 'doing', text: '开了 PR' }]);
    w.replies.push({
      status: 3,
      json: {
        ok: false,
        claim: claimJson({ claimId: OTHER_ID, owner: { kind: 'worker', machine: '笔记本', label: 'w9' } }),
      },
    });
    expect(await w.claim(['step', '40', '--claim', CLAIM_ID])).toBe(3);
    expect(w.err.at(-1)).toContain(
      '现在归 笔记本/w9（claimed，认领 0a0b0c0d）；你的认领号 0f0e0d0c 对不上或已经结束',
    );
    w.replies.push({ status: 0, json: { ok: true, claim: claimJson({ state: 'done', active: false }) } });
    expect(await w.claim(['done', '40', '--claim', CLAIM_ID, '--note', '合进去了'])).toBe(0);
    expect(w.github.claims(40)).toMatchObject([{ state: 'done', text: '合进去了' }]);
    expect(await w.claim(['done', '40', '--claim', CLAIM_ID])).toBe(1);
    expect(await w.claim(['step', '40', '--claim', 'abc'])).toBe(1);
  });

  it('认领变了法国当场重贴 PR 上的「认领对得上」（#348）：贴了说一句；【故意造出的失败】没贴成打到标准错误，认领照样算', async () => {
    const w = await seated();
    w.replies.push({
      status: 0,
      json: { ok: true, claim: claimJson(), prStatus: { ok: true, checked: 1, posted: [88], problems: [] } },
    });
    expect(await w.claim(['take', '40', '--label', 'w1'])).toBe(0);
    expect(w.out.join('\n')).toContain('PR 上的「认领对得上」重贴了：#88');
    w.replies.push({
      status: 0,
      json: { ok: true, claim: claimJson({ prs: [88] }), prStatus: { ok: false, error: '这里没接 GitHub' } },
    });
    expect(await w.claim(['step', '40', '--claim', CLAIM_ID, '--pr', '88'])).toBe(0);
    expect(w.err.at(-1)).toContain('PR 上的「认领对得上」没重贴成（这里没接 GitHub）');
  });
});

describe('claim.mjs reassign：帅位改派（#348）', () => {
  async function seated() {
    const w = world();
    w.replies.push(taken(3));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    return w;
  }

  it('给本机的工人：带着任期、创始人原话调 claim reassign，打出法国的话，单上的「在做」镜子改成新工人', async () => {
    const w = await seated();
    w.replies.push({
      status: 0,
      stdout: `改派了 ${REPO}#40：归 本机/w2，认领号 ${CLAIM_ID}（开 PR 时正文「认领」栏写它）\n原来那份作废了：引擎（认领 0a0b0c0d）\n引擎的工作流 req:${REPO}#40 叫停了\n原来那份开着的 PR 关了（分支留着）：#88\n`,
    });
    expect(
      await w.claim(['reassign', '40', '--to', 'worker', '--label', 'w2', '--founder', '40 本机做']),
    ).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual([
      'claim',
      'reassign',
      REPO,
      '40',
      '--to',
      'worker',
      '--machine',
      '本机',
      '--session',
      's1',
      '--term',
      '3',
      '--scope',
      'main',
      '--label',
      'w2',
      '--founder',
      '40 本机做',
    ]);
    expect(w.out.join('\n')).toContain('原来那份开着的 PR 关了（分支留着）：#88');
    expect(w.github.claims(40)).toMatchObject([{ state: 'doing', machine: '本机' }]);
  });

  it('给引擎：带 --reason 走交单；【故意造出的失败】不带 --reason、--to 认不出、给本机不带 --label：退出码 1，不碰 ssh', async () => {
    const w = await seated();
    const before = w.calls.length;
    expect(await w.claim(['reassign', '40', '--to', 'engine'])).toBe(1);
    expect(await w.claim(['reassign', '40', '--to', 'robot'])).toBe(1);
    expect(await w.claim(['reassign', '40', '--to', 'worker'])).toBe(1);
    expect(await w.claim(['reassign', '40', '--to', 'engine', '--reason', 'r', '--label', 'w'])).toBe(1);
    expect(w.calls.length).toBe(before);
    w.replies.push({ status: 0, stdout: `已交给 fleet：${REPO}#40\n` });
    expect(
      await w.claim(['reassign', '40', '--to', 'engine', '--reason', '交给引擎', '--founder', '给引擎']),
    ).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual(
      expect.arrayContaining(['--to', 'engine', '--reason', '交给引擎', '--founder', '给引擎']),
    );
    expect(w.github.comments).toEqual([]);
  });

  it('【故意造出的失败】原来的还活着没带原话：退出码 3，打出法国的话；改派成了但旧 PR 没关成：退出码 2，照实打出要人补的', async () => {
    const w = await seated();
    w.replies.push({
      status: 3,
      stdout: `没改派（${REPO}#40 没动）：引擎 在做，还活着。要强制改派带上创始人原话 --founder "…"：原来那份当场作废\n`,
    });
    expect(await w.claim(['reassign', '40', '--to', 'worker', '--label', 'w2'])).toBe(3);
    expect(w.err.at(-1)).toContain('要强制改派带上创始人原话');
    w.replies.push({
      status: 1,
      stdout: `改派了 ${REPO}#40：归 本机/w2，认领号 ${CLAIM_ID}\n原来那份的 PR 没处理（GitHub 没接上：限流了）：撤自动合并、关掉要人补\n`,
    });
    expect(await w.claim(['reassign', '40', '--to', 'worker', '--label', 'w2', '--founder', 'x'])).toBe(2);
    expect(w.err.at(-1)).toContain('撤自动合并、关掉要人补');
    w.replies.push({ status: 255, stderr: 'ssh: Could not resolve hostname contabo\n' });
    expect(await w.claim(['reassign', '40', '--to', 'worker', '--label', 'w2', '--founder', 'x'])).toBe(2);
    expect(w.err.at(-1)).toContain('不知道法国那边做没做');
  });
});

describe('推前钩子（claim.mjs prepush）', () => {
  const pushed = (branch: string, sha = 'a'.repeat(40)) =>
    `refs/heads/${branch} ${sha} refs/heads/${branch} ${'b'.repeat(40)}\n`;

  it('没带认领的分支、删分支：不查、不去法国，照推', async () => {
    const w = world();
    w.setStdin(pushed('feat/x') + `refs/heads/y ${'0'.repeat(40)} refs/heads/y ${'b'.repeat(40)}\n`);
    expect(await w.claim(['prepush'])).toBe(0);
    expect(w.calls).toEqual([]);
  });

  it('认领还归你：照推，说一句；【故意造出的失败】作废了、改派了、库里没有：拦下（退出码 1），写明现在归谁', async () => {
    const w = world();
    w.config.set('branch.feat/40-x.fleetClaim', `${REPO}#40:${CLAIM_ID}`);
    w.setStdin(pushed('feat/40-x'));
    w.replies.push({ status: 0, json: { claims: [claimJson()], missing: [], now: NOW.toISOString() } });
    expect(await w.claim(['prepush'])).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual(['claim', 'show', REPO, '40', '--all', '--json']);
    expect(w.out.at(-1)).toContain('还归你');

    w.replies.push({
      status: 0,
      json: {
        claims: [claimJson({ state: 'voided', active: false, endReason: '过了宽限期（120 分钟）没心跳' })],
      },
    });
    expect(await w.claim(['prepush'])).toBe(1);
    expect(w.err.at(-1)).toContain('你的认领已经结束（voided：过了宽限期（120 分钟）没心跳）');

    w.replies.push({
      status: 0,
      json: {
        claims: [claimJson({ claimId: OTHER_ID, owner: { kind: 'engine', machine: null, label: null } })],
      },
    });
    expect(await w.claim(['prepush'])).toBe(1);
    expect(w.err.at(-1)).toContain('现在归 引擎（认领 0a0b0c0d，还活着）');

    w.replies.push({ status: 0, json: { claims: [], missing: [40] } });
    expect(await w.claim(['prepush'])).toBe(1);
    expect(w.err.at(-1)).toContain('库里没有这张单的认领');
  });

  it('【故意造出的失败】连不上法国、没有登法国的钥匙：只警告、照推（合并闸那一侧照样查）；git 配置认不出：拦下', async () => {
    const w = world();
    w.config.set('branch.feat/40-x.fleetClaim', `${REPO}#40:${CLAIM_ID}`);
    w.setStdin(pushed('feat/40-x'));
    w.replies.push({ status: 255, stderr: 'ssh: Could not resolve hostname contabo\n' });
    expect(await w.claim(['prepush'])).toBe(0);
    expect(w.err.at(-1)).toContain('这次没查 acme/fleet-dao#40 的认领，照推（合并闸那一侧照样查）');

    rmSync(join(w.home, '.fleet-dao', 'france-ssh'));
    expect(await w.claim(['prepush'])).toBe(0);
    expect(w.err.at(-1)).toContain('这台没有登法国的钥匙');

    w.config.set('branch.feat/40-x.fleetClaim', 'garbage');
    expect(await w.claim(['prepush'])).toBe(1);
    expect(w.err.at(-1)).toContain('fleetClaim「garbage」认不出');
  });
});

describe('ssh 标准错误里的中文（Windows 上是 GBK）', () => {
  const phrase = '不知道这样的主机。';
  const prefix = 'ssh: Could not resolve hostname contabo: ';
  // 「不知道这样的主机。」的 GBK：两字节一个字，句号是 A1 A3。写死，不靠运行时编码器。
  const gbkPhrase = [
    0xb2, 0xbb, 0xd6, 0xaa, 0xb5, 0xc0, 0xd5, 0xe2, 0xd1, 0xf9, 0xb5, 0xc4, 0xd6, 0xf7, 0xbb, 0xfa, 0xa1,
    0xa3,
  ];
  const gbkLine = () => Buffer.concat([Buffer.from(prefix), Buffer.from(gbkPhrase), Buffer.from('\r\n')]);
  const escapedLine = () =>
    `${prefix}${gbkPhrase.map((b) => `\\${b.toString(8).padStart(3, '0')}`).join('')}\r\n`;

  it('GBK 原字节还原成能读的中文', () => {
    expect(lib.readableStderr(gbkLine())).toBe(`${prefix}${phrase}\r\n`);
  });

  it('ssh 的 \\NNN 转义还原成同一句中文', () => {
    const escaped = escapedLine();
    expect(escaped).toContain('\\262\\273\\326\\252');
    expect(lib.readableStderr(escaped)).toBe(`${prefix}${phrase}\r\n`);
  });

  it('UTF-8 原字节的中文照旧能读，不按 GBK 解', () => {
    expect(lib.readableStderr(Buffer.from(`${prefix}${phrase}\n`, 'utf8'))).toBe(`${prefix}${phrase}\n`);
    // C2 A5 两边都合法：UTF-8 是 ¥，GB18030 是「楼」。先认 UTF-8 才不会解错。
    expect(lib.readableStderr(Buffer.from([0xc2, 0xa5]))).toBe('¥');
  });

  it('【故意造出的失败】坏字节、坏的 \\NNN、ASCII 反斜杠：不抛错，原样留着', () => {
    const bad = Buffer.concat([
      Buffer.from('ping '),
      Buffer.from([0xff, 0xfe, 0x80]),
      Buffer.from(' contabo'),
    ]);
    expect(lib.readableStderr(bad)).toBe('ping \\377\\376\\200 contabo');
    expect(lib.readableStderr('pre \\377 post')).toBe('pre \\377 post');
    expect(lib.readableStderr('C:\\Users\\a')).toBe('C:\\Users\\a');
  });

  it('现查连不上：GBK 原字节和转义串都打出能读的原因，退出码 2', async () => {
    for (const stderr of [gbkLine(), escapedLine()]) {
      const w = world();
      w.replies.push(taken(3));
      expect(await w.seat(['take', '--session', 's1'])).toBe(0);
      w.replies.push({ status: 255, stderr });
      expect(await w.seat(['check'])).toBe(2);
      const line = w.err.at(-1) ?? '';
      expect(line).toContain('ssh 连不上法国：');
      expect(line).toContain(phrase);
    }
  });

  it('认领连不上：GBK 原字节打出能读的原因，退出码 2', async () => {
    const w = world();
    w.replies.push({ status: 255, stderr: gbkLine() });
    expect(await w.claim(['show'])).toBe(2);
    const line = w.err.at(-1) ?? '';
    expect(line).toContain('ssh 连不上法国：');
    expect(line).toContain(phrase);
  });

  it('【故意造出的失败】标准错误是空 Buffer：不当成有输出，改看标准输出', async () => {
    const w = world();
    w.replies.push({ status: 127, stderr: Buffer.alloc(0), stdout: 'bash: fleet-api: No such file\n' });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain('bash: fleet-api: No such file');
    expect(w.err.at(-1)).not.toContain('没有输出');
  });
});

describe('给远端 shell 的参数', () => {
  it('单引号包起来，里面的单引号拆开转义', () => {
    expect(lib.shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(lib.shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
  });
});

describe('.githooks/pre-push：只跑卫生检查', () => {
  const HOOK = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url));

  function repoWithStub(hygieneExit: number) {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-hook-'));
    homes.push(dir);
    const hygieneDir = join(dir, 'packages', 'hygiene', 'src', 'bin');
    mkdirSync(hygieneDir, { recursive: true });
    writeFileSync(
      join(hygieneDir, 'pre-push.ts'),
      `import { readFileSync, writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(join(dir, 'hygiene.json'))}, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8') }));
process.exitCode = ${hygieneExit};
`,
    );
    return dir;
  }
  const run = (dir: string, stdin: string) =>
    spawnSync('sh', [HOOK, 'origin', 'https://example.test/repo.git'], {
      cwd: dir,
      input: stdin,
      encoding: 'utf8',
    });

  it('卫生检查收到 git 给的几行和参数，退出码原样交回', () => {
    const lines = `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${'2'.repeat(40)}
`;
    const dir = repoWithStub(0);
    expect(run(dir, lines).status).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'hygiene.json'), 'utf8'))).toEqual({
      argv: ['origin', 'https://example.test/repo.git'],
      stdin: lines,
    });
    expect(run(repoWithStub(1), lines).status).toBe(1);
  });

  it('【故意造出的失败】钩子不引用技能目录里的脚本：core.hooksPath 常指向主检出，在别的工作树里跑时那个路径可能不存在', () => {
    expect(readFileSync(HOOK, 'utf8')).not.toMatch(/^[^#]*agents\/skills\//m);
  });
});
