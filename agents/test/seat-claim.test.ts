// 认领账和推前钩子（#299；帅位座位整张删掉，见 #531）：本机这边的脚本（seat-lib.mjs：claim.mjs、推前钩子）。
// ssh 换成照着法国 fleet-api 回话的假的，家目录用临时的，git 配置和 GitHub 都在内存里。没登法国的钥匙、连不上、
// 回的东西认不出，每条失败路径都故意造一遍：一律明说，不当成没事；推前钩子连不上法国只警告、照推，认领对不上才拦。
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    claim: (argv: string[]) => lib.runClaim(argv, io),
  };
}

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

describe('claim.mjs：帅位座位删掉之后（#531）', () => {
  it('take/step/done/release/reassign 一概拒收（退出码 1），不碰 ssh', async () => {
    const w = world();
    for (const argv of [
      ['take', '40', '--label', 'w1'],
      ['step', '40', '--claim', CLAIM_ID],
      ['done', '40', '--claim', CLAIM_ID, '--note', 'x'],
      ['release', '40', '--claim', CLAIM_ID, '--note', 'x'],
      ['reassign', '40', '--to', 'worker', '--label', 'w2'],
    ]) {
      expect(await w.claim(argv), argv.join(' ')).toBe(1);
    }
    expect(w.err.join('\n')).toContain('#531');
    expect(w.calls).toEqual([]);
  });

  it('show：经 ssh 调 fleet-api claim show，原样打出来；【故意造出的失败】没钥匙、连不上、回不可读、退出码非 0 一律退出码 2', async () => {
    const w = world();
    w.replies.push({ status: 0, stdout: '认领 acme/fleet-dao#40：本机/w1（claimed）\n' });
    expect(await w.claim(['show'])).toBe(0);
    expect(w.calls.at(-1)?.args).toEqual(['claim', 'show', REPO]);
    expect(w.out.at(-1)).toContain('本机/w1');

    const noKey = world({ host: null });
    expect(await noKey.claim(['show'])).toBe(2);
    expect(noKey.err.at(-1)).toContain('这台没有登法国的钥匙');

    w.replies.push({ status: 255, stderr: 'ssh: connect to host contabo port 22: Connection timed out\n' });
    expect(await w.claim(['show'])).toBe(2);
    expect(w.err.at(-1)).toContain('ssh 连不上法国');

    w.replies.push({ status: 0, stdout: 'garbage not first line\n' });
    expect(await w.claim(['show'])).toBe(0); // show 不带 --json，原文照打

    w.replies.push({ status: 1, stdout: '没做成\n' });
    expect(await w.claim(['show'])).toBe(2);
  });
});

describe('推前钩子（claim.mjs prepush）', () => {
  const pushed = (branch: string, sha = 'a'.repeat(40)) =>
    `refs/heads/${branch} ${sha} refs/heads/${branch} ${'b'.repeat(40)}\n`;

  it('没带认领的分支、删分支：不查、不去法国，照推', async () => {
    const w = world();
    w.setStdin(`${pushed('feat/x')}refs/heads/y ${'0'.repeat(40)} refs/heads/y ${'b'.repeat(40)}\n`);
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

  it('认领连不上：GBK 原字节打出能读的原因，退出码 2', async () => {
    const w = world();
    w.replies.push({ status: 255, stderr: gbkLine() });
    expect(await w.claim(['show'])).toBe(2);
    const line = w.err.at(-1) ?? '';
    expect(line).toContain('ssh 连不上法国：');
    expect(line).toContain(phrase);
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
