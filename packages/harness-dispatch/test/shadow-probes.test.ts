// 影子自检的真实探测：凭据文件、git 凭据助手、出网规则单元和出网关的口。
// 只读探测是一段 sh 脚本：没 sandbox 时直接跑（HOME 指向临时家目录，真 git）；有 sandbox 时经假帮手 run 以「工人」身份跑
// （法国现场 #3776：内核用户进不去会话用户的家，只能以工人身份看）。systemctl 换成桩。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { shadowSelfCheck } from '@fleet-dao/harness-workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type CommandResult, type CommandSpec, runCommand } from '../src/command.ts';
import { scopeSandbox } from '../src/scope-sandbox.ts';
import { realShadowProbes } from '../src/shadow-probes.ts';

const HELPER = fileURLToPath(new URL('./fake-scope-helper.mjs', import.meta.url));
const redact = makeRedactor([]);
const res = (exitCode: number | null, stdout = '', ran = exitCode !== null): CommandResult => ({
  ran,
  exitCode,
  stdout,
  truncated: false,
  stderrTail: '',
  wallMs: 1,
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'shadow-home-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function probes(over: { systemctl?: CommandResult; port?: boolean | Error; handlers?: string[] }) {
  const seen: CommandSpec[] = [];
  const p = realShadowProbes({
    home,
    egressPort: 7344,
    redact,
    realHandlers: () => over.handlers ?? [],
    run: async (spec) => {
      seen.push(spec);
      return over.systemctl ?? res(0, 'active');
    },
    portOpen: async () => {
      if (over.port instanceof Error) throw over.port;
      return over.port ?? true;
    },
  });
  return { p, seen };
}

/** 只读探测走默认的 runCommand（真 sh、真 git），HOME 是临时家目录。 */
const direct = () =>
  realShadowProbes({ home, egressPort: 7344, redact, realHandlers: () => [] }).noWriteAccess();

function plant(rel: string, body = 'x') {
  mkdirSync(join(home, rel, '..'), { recursive: true });
  writeFileSync(join(home, rel), body);
}

describe('只读探测：会话用户家目录里的推送凭据工人一样读得到', () => {
  it('家目录干净、没挂凭据助手：过', async () => {
    expect(await direct()).toBe('pass');
  });

  it.each([['.git-credentials'], ['.config/gh/hosts.yml'], ['.netrc'], ['.ssh/id_ed25519']])(
    '有 %s：没过',
    async (rel) => {
      plant(rel);
      expect(await direct()).toBe('fail');
    },
  );

  it('.ssh 里只有公钥和 known_hosts：不算', async () => {
    plant('.ssh/id_ed25519.pub');
    plant('.ssh/known_hosts');
    expect(await direct()).toBe('pass');
  });

  it('全局 git 配置挂着凭据助手：没过', async () => {
    plant('.gitconfig', '[credential]\n\thelper = store\n');
    expect(await direct()).toBe('fail');
  });

  it('脚本没跑成、或退出码不是 0 / 10：没查成', async () => {
    const withRun = (r: CommandResult) =>
      realShadowProbes({ home, egressPort: 7344, redact, realHandlers: () => [], run: async () => r });
    expect(await withRun(res(null, '', false)).noWriteAccess()).toBe('unknown');
    expect(await withRun(res(11)).noWriteAccess()).toBe('unknown');
    expect(await withRun(res(127)).noWriteAccess()).toBe('unknown');
    expect(await withRun(res(0)).noWriteAccess()).toBe('pass');
    expect(await withRun(res(10)).noWriteAccess()).toBe('fail');
  });

  it('脚本不打印文件内容，凭据文件里的字不会出现在输出里', async () => {
    plant('.git-credentials', '这行字不许出现在探测的输出里');
    let out = '';
    const p = realShadowProbes({
      home,
      egressPort: 7344,
      redact,
      realHandlers: () => [],
      run: async (spec) => {
        const r = await runCommand(spec);
        out = r.stdout + r.stderrTail;
        return r;
      },
    });
    expect(await p.noWriteAccess()).toBe('fail');
    expect(out).not.toContain('这行字不许出现在探测的输出里');
  });
});

describe('有 sandbox：以工人身份看（内核用户进不去工人的家）', () => {
  // deps.home 是内核眼里的工人家，这里指向一个根本不存在的路径：内核自己去读只会读空。
  // 工人真正的家是假帮手 run 里 HOME 指向的临时目录，判定必须跟着它走。
  function sandboxed() {
    const log = join(home, 'scope-log.jsonl');
    const sandbox = scopeSandbox({
      sudo: [process.execPath, HELPER, log, `home=${home}`],
      helper: 'fleet-agent-scope',
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    });
    const p = realShadowProbes({
      home: '/nonexistent/fleet-agent-carpool',
      sandbox,
      egressPort: 7344,
      redact,
      realHandlers: () => [],
      timeoutMs: 30_000,
    });
    const calls = () =>
      existsSync(log)
        ? readFileSync(log, 'utf8')
            .trim()
            .split('\n')
            .map((l) => JSON.parse(l) as string[])
        : [];
    return { p, calls };
  }

  it('干净：过；经 run 跑，编号带 fleet2- 前缀、进 fleet2-shadow slice、以会话用户在 /tmp 跑', async () => {
    const { p, calls } = sandboxed();
    expect(await p.noWriteAccess()).toBe('pass');
    const [run] = calls();
    expect(run?.[0]).toBe('run');
    expect(run?.[1]).toMatch(/^fleet2-probe-[0-9a-f]{8}$/);
    expect(run?.slice(2, 9)).toEqual([
      '--slice',
      'fleet2-shadow',
      '--user',
      'fleet-agent-carpool',
      '--cwd',
      '/tmp',
      '--',
    ]);
    expect(run?.slice(9, 11)).toEqual(['/bin/sh', '-c']);
  });

  it('工人家里有凭据文件、或挂着凭据助手：没过', async () => {
    plant('.netrc');
    const a = sandboxed();
    expect(await a.p.noWriteAccess()).toBe('fail');
    rmSync(join(home, '.netrc'));
    plant('.gitconfig', '[credential]\n\thelper = store\n');
    const b = sandboxed();
    expect(await b.p.noWriteAccess()).toBe('fail');
  });

  it('帮手没跑成（命令不在）：没查成，不当成没事', async () => {
    const sandbox = scopeSandbox({
      sudo: [process.execPath, join(tmpdir(), 'no-such-helper.mjs')],
      helper: 'x',
      hostEnv: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT },
    });
    const p = realShadowProbes({
      home,
      sandbox,
      egressPort: 7344,
      redact,
      realHandlers: () => [],
      timeoutMs: 30_000,
    });
    expect(await p.noWriteAccess()).toBe('unknown');
  });
});

describe('出网规则：单元在跑、出网关有人听', () => {
  it('都在：过；systemctl 的 cwd 是 /，不是工人的家（内核用户进不去，spawn 会失败）', async () => {
    const { p, seen } = probes({});
    expect(await p.egressRulesPresent()).toBe('pass');
    expect(seen[0]?.command).toEqual(['systemctl', 'is-active', 'fleet2-shadow-firewall.service']);
    expect(seen[0]?.cwd).toBe('/');
    expect(seen[0]?.cwd).not.toBe(home);
  });

  it('单元没在跑：没过；systemctl 没跑成：没查成', async () => {
    expect(await probes({ systemctl: res(3, 'inactive') }).p.egressRulesPresent()).toBe('fail');
    expect(await probes({ systemctl: res(null, '', false) }).p.egressRulesPresent()).toBe('unknown');
  });

  it('出网关的口被拒：没过；连超时：自检按没查成拦下', async () => {
    expect(await probes({ port: false }).p.egressRulesPresent()).toBe('fail');
    const check = await shadowSelfCheck(probes({ port: new Error('超时') }).p);
    expect(check).toMatchObject({ ok: false });
    expect(check.ok ? [] : check.why).toEqual([expect.stringContaining('没查成')]);
  });

  it('默认的连口探测：真听着的口回 true，没人听的回 false', async () => {
    const server: Server = createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    const live = realShadowProbes({
      home,
      egressPort: port,
      redact,
      realHandlers: () => [],
      run: async () => res(0, 'active'),
    });
    expect(await live.egressRulesPresent()).toBe('pass');
    await new Promise<void>((r) => server.close(() => r()));
    expect(await live.egressRulesPresent()).toBe('fail');
  });
});

describe('outbox 真实处理器', () => {
  it('装了任何一个就没过', async () => {
    expect(await probes({}).p.realHandlersAbsent()).toBe('pass');
    expect(await probes({ handlers: ['github.merge'] }).p.realHandlersAbsent()).toBe('fail');
  });
});
