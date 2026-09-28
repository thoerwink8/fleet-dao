// 帅位（#446，specs/446-帅位认领简化/需求.md）本机这边的脚本（seat-lib.mjs：seat.mjs、claim.mjs、.githooks/pre-push）：
// ssh 换成照着法国 fleet-api 回话的假的，家目录用临时的，git 配置和 GitHub 都在内存里。没登法国的钥匙、连不上、
// 回的东西认不出、别人拿着、认领号对不上，每条失败路径都故意造一遍：一律明说，不当成没事。
// #446 起帅位不是锁：没有续约、没有现查（seat.mjs 没有 renew/check 了）；本机的帅位记录（~/.fleet-dao/seat/）只是
// 缓存「我是谁、第几任」，放多久都不影响能不能用；推前钩子（.githooks/pre-push）不再查认领，只跑卫生检查。
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
  stderr: string;
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
  | { status: number; json?: unknown; stdout?: string; stderr?: string }
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
  lastActivityAt: NOW.toISOString(),
  handoff: null,
  handoffAt: null,
});
const taken = (term = 3, scope = 'main') => ({
  status: 0,
  json: { ok: true, seat: lease(term, '本机', 's1', scope), now: NOW.toISOString() },
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

describe('seat.mjs：接班（永远成功，不是锁）', () => {
  it('【故意造出的失败】没有登法国的钥匙（~/.fleet-dao/france-ssh 不在）：接不了班，退出码 2，不碰 ssh', async () => {
    const w = world({ host: null });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.join('\n')).toContain('这台没有登法国的钥匙');
    expect(w.calls).toEqual([]);
  });

  it('接班：经 ssh 调 fleet-api seat take（带 --json），本地只记 scope/machine/session/term/takenAt；机器名用 doing.mjs 那个', async () => {
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
      expect.objectContaining({ scope: 'main', machine: '本机', session: 's1', term: 3 }),
    ]);
    // #446 起没有 leaseMinutes、retired 这些字段了
    expect(w.states()[0]).not.toHaveProperty('leaseMinutes');
    expect(w.states()[0]).not.toHaveProperty('retired');
    expect(typeof w.states()[0].takenAt).toBe('string');
    expect(w.out.join('\n')).toContain(
      '接班了：main 第 3 任是 本机/s1；上一任是 笔记本/s0（第 2 任），它下次 seat show 看一眼就知道该退了',
    );
  });

  it('座位原来没人：打「座位原来没人」，不是「上一任是」', async () => {
    const w = world();
    w.replies.push(taken(1));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    expect(w.out.join('\n')).toContain('接班了：main 第 1 任是 本机/s1；座位原来没人');
  });

  it('【故意造出的失败】ssh 连不上、回的不是 JSON、回的接班结果对不上、法国说没做成：都退出码 2，不记帅位', async () => {
    const w = world();
    w.replies.push({ status: 255, stderr: 'ssh: connect to host contabo port 22: Connection timed out\n' });
    expect(await w.seat(['take', '--session', 's1'])).toBe(2);
    expect(w.err.at(-1)).toContain(
      '没接上班：ssh 连不上法国：ssh: connect to host contabo port 22: Connection timed out',
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

  it('参数不对退出码 1，不碰 ssh', async () => {
    const w = world();
    expect(await w.seat(['take'])).toBe(1);
    expect(await w.seat(['take', '--session', 'a b'])).toBe(1);
    expect(await w.seat(['take', '--session', 's1', '--scope', 'prod'])).toBe(1);
    expect(await w.seat(['bogus'])).toBe(1);
    expect(w.calls).toEqual([]);
  });
});

describe('seat.mjs：show、handoff', () => {
  async function seated() {
    const w = world();
    w.replies.push(taken(3));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    w.out.length = 0;
    return w;
  }

  it('show：经 ssh 调 fleet-api seat show（不带 --json），法国给的文字原样打出来', async () => {
    const w = await seated();
    w.replies.push({ status: 0, stdout: '帅位（main）：第 3 任 本机/s1，最后活动 0 分钟前\n' });
    expect(await w.seat(['show'])).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual(['seat', 'show', '--scope', 'main']);
    expect(w.out.join('\n')).toContain('帅位（main）：第 3 任 本机/s1，最后活动 0 分钟前');
  });

  it('交接说明：带着本机记的身份存（不带 --term 了）；座位上没人法国说存不进（退出码 3）', async () => {
    const w = await seated();
    w.setStdin('#40 在等创始人拍；工人 w1 在做 #41');
    w.replies.push({ status: 0, json: { ok: true, seat: lease(3) } });
    expect(await w.seat(['handoff'])).toBe(0);
    expect(w.calls.at(-1)).toMatchObject({
      args: ['seat', 'handoff', '--machine', '本机', '--session', 's1', '--scope', 'main', '--json'],
      input: '#40 在等创始人拍；工人 w1 在做 #41',
    });
    expect(w.out.join('\n')).toContain('交接说明存上了');

    w.setStdin('座位上没人');
    w.replies.push({ status: 3, json: { ok: false, seat: null } });
    expect(await w.seat(['handoff'])).toBe(3);
    expect(w.err.at(-1)).toContain('座位上没人（还没接过班），没什么可交接的');
  });

  it('本机记录放了很久（很久没有任何活动）也照样能写交接：本地缓存没有过期这回事', async () => {
    const w = await seated();
    w.advance(6 * 60); // 6 小时过去
    w.setStdin('好久没动过了，但照样能写');
    w.replies.push({ status: 0, json: { ok: true, seat: lease(3) } });
    expect(await w.seat(['handoff'])).toBe(0);
    expect(w.out.join('\n')).toContain('交接说明存上了');
  });

  it('【故意造出的失败】这台没接过班、有好几份记录、记录坏了：都明说，不当成能写', async () => {
    const w = world();
    w.setStdin('没人接过班');
    expect(await w.seat(['handoff'])).toBe(2);
    expect(w.err.at(-1)).toContain('这台没有 main 的帅位记录');
    w.replies.push(taken(3), {
      status: 0,
      json: { ok: true, seat: lease(4, '本机', 's2'), now: NOW.toISOString() },
    });
    await w.seat(['take', '--session', 's1']);
    await w.seat(['take', '--session', 's2']);
    w.setStdin('两份都在');
    expect(await w.seat(['handoff'])).toBe(2);
    expect(w.err.at(-1)).toContain('这台有好几份 main 的帅位记录（会话 s1、s2）');
    const dir = join(w.home, '.fleet-dao', 'seat');
    writeFileSync(join(dir, readdirSync(dir)[0] ?? 'x.json'), '{"scope":"main"');
    w.setStdin('坏的');
    expect(await w.seat(['handoff', '--session', 's2'])).toBe(2);
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

  it('帅位认领：经 ssh 调 claim take（带着本机记的任期），认领号记进分支的 git 配置，单上留「在做」镜子', async () => {
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
    // #446 起没有「宽限期…没心跳就作废」这句威胁了
    expect(w.out.join('\n')).not.toContain('没心跳就作废');
    expect(w.github.claims(40)).toMatchObject([{ state: 'doing', machine: '本机', text: '开工' }]);
  });

  it('本机记录放了很久也照样能认领：本地缓存没有过期这回事', async () => {
    const w = await seated();
    w.advance(6 * 60);
    w.replies.push({ status: 0, json: { ok: true, claim: claimJson() } });
    expect(await w.claim(['take', '40', '--label', 'w1'])).toBe(0);
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

  it('【故意造出的失败】别人拿着：退出码 3，写明现在归谁；没有认领对象时退回「不是你的」；不记 git 配置、不留镜子', async () => {
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
    w.replies.push({ status: 3, json: { ok: false, reason: 'held' } });
    expect(await w.claim(['take', '40', '--label', 'w1'])).toBe(3);
    expect(w.err.at(-1)).toContain('没认领上：不是你的');
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
});

describe('claim.mjs reassign：帅位改派（#446 起不用创始人原话，不用等法国核任期）', () => {
  async function seated() {
    const w = world();
    w.replies.push(taken(3));
    expect(await w.seat(['take', '--session', 's1'])).toBe(0);
    return w;
  }

  it('给本机的工人：带着本机记的任期、创始人原话（可选）调 claim reassign，打出法国的话，单上的「在做」镜子改成新工人', async () => {
    const w = await seated();
    w.replies.push({
      status: 0,
      stdout: `改派了 ${REPO}#40：归 本机/w2，认领号 ${CLAIM_ID}（开 PR 时正文「认领」栏写它）\n原来那份作废了：引擎（认领 0a0b0c0d，改派给本机/w2（创始人原话：40 本机做））；开着的 PR 不动，旧主自己关或帅位手动关\n`,
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
    expect(w.out.join('\n')).toContain('开着的 PR 不动，旧主自己关或帅位手动关');
    expect(w.github.claims(40)).toMatchObject([{ state: 'doing', machine: '本机' }]);
  });

  it('不带 --founder 也能改派（#446 起不再要求创始人原话，只用来记一句为什么）', async () => {
    const w = await seated();
    w.replies.push({ status: 0, stdout: `改派了 ${REPO}#40：归 本机/w2，认领号 ${CLAIM_ID}\n` });
    expect(await w.claim(['reassign', '40', '--to', 'worker', '--label', 'w2', '--note', '换人做'])).toBe(0);
    expect(w.calls.at(-1)?.args).not.toContain('--founder');
    expect(w.calls.at(-1)?.args).toEqual(expect.arrayContaining(['--note', '换人做']));
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

  it('【故意造出的失败】法国仍回不是你的（防御性分支，#446 起理论上不该发生）：退出码 3，照打法国的话', async () => {
    const w = await seated();
    w.replies.push({
      status: 3,
      stdout: `没改派（${REPO}#40 没动）：引擎 在做，还活着。\n`,
    });
    expect(await w.claim(['reassign', '40', '--to', 'worker', '--label', 'w2'])).toBe(3);
    expect(w.err.at(-1)).toContain('没改派');
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

describe('给远端 shell 的参数', () => {
  it('单引号包起来，里面的单引号拆开转义', () => {
    expect(lib.shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(lib.shellQuote('$(rm -rf /)')).toBe(`'$(rm -rf /)'`);
  });
});

describe('.githooks/pre-push：只跑卫生检查（#446 起不再查认领，claim.mjs 没有 prepush 这个命令了）', () => {
  const HOOK = fileURLToPath(new URL('../../.githooks/pre-push', import.meta.url));

  function repoWithHygieneStub(hygieneExit: number) {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-hook-'));
    homes.push(dir);
    const hygieneDir = join(dir, 'packages', 'hygiene', 'src', 'bin');
    mkdirSync(hygieneDir, { recursive: true });
    writeFileSync(
      join(hygieneDir, 'pre-push.ts'),
      `import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(dir, 'hygiene.json'))}, JSON.stringify({ argv: process.argv.slice(2), stdin: readFileSync(0, 'utf8') }));\nprocess.exitCode = ${hygieneExit};\n`,
    );
    return dir;
  }
  const run = (dir: string, stdin: string) =>
    spawnSync('sh', [HOOK, 'origin', 'https://example.test/repo.git'], {
      cwd: dir,
      input: stdin,
      encoding: 'utf8',
    });
  const read = (dir: string, name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

  it('标准输入原样转给卫生检查，退出码原样交回；没有 claim.mjs 这个文件也照样跑（钩子不再碰它）', () => {
    const lines = `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${'2'.repeat(40)}\n`;
    const dir = repoWithHygieneStub(0);
    const r = run(dir, lines);
    expect(r.status).toBe(0);
    expect(read(dir, 'hygiene.json')).toEqual({
      argv: ['origin', 'https://example.test/repo.git'],
      stdin: lines,
    });
  });

  it('【故意造出的失败】卫生检查非 0：拦下（退出码原样交回）', () => {
    const dir = repoWithHygieneStub(1);
    const lines = `refs/heads/a ${'1'.repeat(40)} refs/heads/a ${'2'.repeat(40)}\n`;
    expect(run(dir, lines).status).toBe(1);
  });
});
