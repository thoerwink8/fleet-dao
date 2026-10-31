// 影子自检的真实探测：凭据文件、git 凭据助手、出网规则单元和出网关的口。git、systemctl 换成桩，文件用临时家目录。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeRedactor } from '@fleet-dao/harness-runner';
import { shadowSelfCheck } from '@fleet-dao/harness-workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandResult, CommandSpec } from '../src/command.ts';
import { realShadowProbes } from '../src/shadow-probes.ts';

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

function probes(over: {
  git?: CommandResult;
  systemctl?: CommandResult;
  port?: boolean | Error;
  handlers?: string[];
}) {
  const seen: CommandSpec[] = [];
  const p = realShadowProbes({
    home,
    egressPort: 7344,
    redact,
    realHandlers: () => over.handlers ?? [],
    run: async (spec) => {
      seen.push(spec);
      if (spec.command[0] === 'git') return over.git ?? res(1);
      return over.systemctl ?? res(0, 'active');
    },
    portOpen: async () => {
      if (over.port instanceof Error) throw over.port;
      return over.port ?? true;
    },
  });
  return { p, seen };
}

describe('只读探测：会话用户家目录里的推送凭据工人一样读得到', () => {
  it('家目录干净、没挂凭据助手：过；git 用的是工人的 HOME', async () => {
    const { p, seen } = probes({});
    expect(await p.noWriteAccess()).toBe('pass');
    expect(seen[0]?.hostEnv?.HOME).toBe(home);
  });

  it.each([['.git-credentials'], ['.config/gh/hosts.yml'], ['.netrc'], ['.ssh/id_ed25519']])(
    '有 %s：没过',
    async (rel) => {
      mkdirSync(join(home, rel, '..'), { recursive: true });
      writeFileSync(join(home, rel), 'x');
      expect(await probes({}).p.noWriteAccess()).toBe('fail');
    },
  );

  it('.ssh 里只有公钥和 known_hosts：不算', async () => {
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_ed25519.pub'), 'x');
    writeFileSync(join(home, '.ssh', 'known_hosts'), 'x');
    expect(await probes({}).p.noWriteAccess()).toBe('pass');
  });

  it('全局 git 配置挂着凭据助手：没过；git 没跑成：没查成', async () => {
    expect(await probes({ git: res(0, 'store') }).p.noWriteAccess()).toBe('fail');
    expect(await probes({ git: res(null, '', false) }).p.noWriteAccess()).toBe('unknown');
    expect(await probes({ git: res(128) }).p.noWriteAccess()).toBe('unknown');
  });
});

describe('出网规则：单元在跑、出网关有人听', () => {
  it('都在：过', async () => {
    expect(await probes({}).p.egressRulesPresent()).toBe('pass');
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
