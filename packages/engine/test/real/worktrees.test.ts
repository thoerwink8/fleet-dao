// 会话目录的落点和属主：路径按仓、分支、需求号拼（放不进目录名的明确拒），属主按 stat 认会话用户，
// 不在回 null、归了别人明确报错（不碰）。
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortError } from '../../src/ports.ts';
import { helperWorkTrees, layout, sessionUserUids } from '../../src/real/worktrees.ts';

const repo = { owner: 'acme', name: 'widgets' };

describe('落点', () => {
  const l = layout('/var/lib/fleet-work');

  it('子任务的树：<根>/<owner>_<name>/<分支去掉 fleet/>；检出副本：<需求号>.<阶段>[.<子任务>]', () => {
    expect(l.treeFor(repo, 'fleet/12-login-form')).toBe('/var/lib/fleet-work/acme_widgets/12-login-form');
    expect(l.scratchFor(repo, 12, 'triage')).toBe('/var/lib/fleet-work/acme_widgets/12.triage');
    expect(l.scratchFor(repo, 12, 'review', 'login-form')).toBe(
      '/var/lib/fleet-work/acme_widgets/12.review.login-form',
    );
  });

  it('放不进目录名的（斜杠、..、空格、坏需求号）：明确拒，不拼出别的路径', () => {
    expect(() => l.treeFor(repo, 'fleet/a/b')).toThrow(PortError);
    expect(() => l.treeFor(repo, 'fleet/..')).toThrow('放不进目录名');
    expect(() => l.treeFor({ owner: 'acme', name: 'wid gets' }, 'fleet/1-a')).toThrow('仓名');
    expect(() => l.scratchFor(repo, 0, 'triage')).toThrow('需求号');
    expect(() => l.scratchFor(repo, 3, 'review', '../x')).toThrow('子任务名');
  });

  it('会话的临时目录：<根>/_tmp/<会话编号>，不在任何工作树里；路径够短（会话里的工具在下面建 unix 套接字，超过 107 字节建不了）', () => {
    const runId = '0f6b0c3e-8f1d-4e27-9a55-6d1e2b7c9a10';
    const dir = l.tmpFor(runId);
    expect(dir).toBe(`/var/lib/fleet-work/_tmp/${runId}`);
    expect(dir.startsWith(`${l.treeFor(repo, 'fleet/12-login-form')}/`)).toBe(false);
    // tsx 的 <TMPDIR>/tsx-<uid>/<进程号>.pipe、Claude Code 的 <TMPDIR>/cc-socks-<uid>/… 都要放得下
    expect(Buffer.byteLength(`${dir}/tsx-1001/4194304.pipe`)).toBeLessThanOrEqual(107);
    expect(() => l.tmpFor('../x')).toThrow('会话编号');
    expect(() => l.tmpFor('a/b')).toThrow(PortError);
  });
});

describe('会话用户的 uid', () => {
  it('从 passwd 读会话用户；已停用的 fleet-agent-dedicated 不认', () => {
    const passwd = [
      'root:x:0:0:root:/root:/bin/bash',
      'fleet-agent-dedicated:x:1101:1101::/nonexistent:/bin/bash',
      'fleet-agent-carpool:x:1102:1102::/nonexistent:/bin/bash',
    ].join('\n');
    expect([...sessionUserUids(passwd).entries()]).toEqual([[1102, 'fleet-agent-carpool']]);
  });

  it('没有会话用户：明确报错（france.sh 没跑过），不当成没有属主', () => {
    expect(() => sessionUserUids('fleet-agent-dedicated:x:1101:1101::/h:/bin/bash')).toThrow(
      'fleet-agent-carpool',
    );
  });
});

describe('属主', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'fleet-trees-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('不在回 null；归会话用户回用户名；归了别人（不是会话用户）明确报错', async () => {
    const uid = statSync(root).uid;
    const mine = helperWorkTrees({ root, uids: new Map([[uid, 'fleet-agent-carpool']]) });
    expect(await mine.ownerOf(join(root, 'nope'))).toBeNull();
    expect(await mine.ownerOf(root)).toBe('fleet-agent-carpool');

    const foreign = helperWorkTrees({ root, uids: new Map([[uid + 1, 'fleet-agent-carpool']]) });
    await expect(foreign.ownerOf(root)).rejects.toMatchObject({ code: 'WORKTREE_FOREIGN' });
  });

  it('列会话临时目录：_tmp 还没建过回空；有就列完整路径', async () => {
    const trees = helperWorkTrees({ root });
    expect(await trees.listTmp()).toEqual([]);
    const a = trees.tmpFor('run-a');
    const b = trees.tmpFor('run-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    expect((await trees.listTmp()).sort()).toEqual([a, b]);
  });

  it('【故意造出的失败】_tmp 读不了（这里是个文件）：明确报错，不当成一个都没有', async () => {
    writeFileSync(join(root, '_tmp'), 'not a dir');
    await expect(helperWorkTrees({ root }).listTmp()).rejects.toMatchObject({ code: 'WORKTREE_UNREADABLE' });
  });
});

describe('清理事务分页的真实装配（帮手回执由测试摆布）', () => {
  const root = '/var/lib/fleet-work';
  const namespace = {
    lex: `${root}/.cleanup-transactions`,
    real: `${root}/.cleanup-transactions`,
    dev: '1',
    ino: '2',
    uid: '0',
  };
  const hash = (n: number) => n.toString(16).padStart(64, '0');
  const tail = { id: 'e'.repeat(64), pathHash: hash(120), phase: 'RECOVERY_REQUIRED' };
  const head = { version: 1, state: 'ok', namespace, generation: 'd'.repeat(64) };
  const firstPage = { ...head, rows: [], truncated: true, after: null, next: hash(99) };
  const lastPage = { ...head, rows: [tail], truncated: false, after: hash(99), next: null };
  let dir: string;
  let trees: ReturnType<typeof helperWorkTrees>;
  // 假帮手只认能力和 cleanup-status：按调用顺序吐 pages.json 里的回执，吐完了按读失败退出。
  function pages(list: unknown[]) {
    writeFileSync(join(dir, 'pages.json'), JSON.stringify(list));
    writeFileSync(join(dir, 'used'), '0');
  }
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-cleanup-pages-'));
    const helper = join(dir, 'fake-scope.mjs');
    const features = [
      'tree-usage',
      'identity-remove',
      'cleanup-status',
      'cleanup-rollback',
      'locked-adopt',
      'temporary-files',
    ];
    writeFileSync(
      helper,
      [
        "import { readFileSync, writeFileSync } from 'node:fs';",
        'const [action] = process.argv.slice(2);',
        `const dir = ${JSON.stringify(dir)};`,
        `if (action === 'capabilities') { process.stdout.write(JSON.stringify({ version: 1, state: 'ok', features: ${JSON.stringify(features)} })); process.exit(0); }`,
        "const used = Number(readFileSync(dir + '/used', 'utf8'));",
        "writeFileSync(dir + '/used', String(used + 1));",
        "const list = JSON.parse(readFileSync(dir + '/pages.json', 'utf8'));",
        "if (action !== 'cleanup-status' || used >= list.length) process.exit(1);",
        'process.stdout.write(JSON.stringify(list[used]));',
      ].join('\n'),
    );
    trees = helperWorkTrees({ root, helper, sudo: [process.execPath] });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('完整读取：cleanupNamespace/pendingCleanup 读完全部页，尾部待恢复事务照报', async () => {
    pages([firstPage, lastPage]);
    expect(await trees.cleanupNamespace()).toEqual([tail]);
    pages([firstPage, lastPage]);
    expect(await trees.pendingCleanup()).toEqual([tail]);
  });

  it('partial：只读到首页（空行）或缺页时仍是“清理事务列表不完整”，不当全清', async () => {
    pages([firstPage]);
    await expect(trees.cleanupNamespace()).rejects.toThrow('清理事务列表不完整');
    pages([{ ...firstPage, generation: undefined, next: undefined }]);
    await expect(trees.pendingCleanup()).rejects.toThrow('清理事务列表不完整');
  });
});
