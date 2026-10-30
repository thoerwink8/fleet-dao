// 记引导前先判类（决定 0111）：真起 bin 子进程，gh 换成假的（把 node 拷成 gh，用 NODE_OPTIONS 预加载假行为，记下每次调用）。
// 非 ai 的类别不写文件、不开单、退出 0；不带或认不出 --kind 退出 1 且一次 gh 都没调。
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';

const BIN = 'packages/conventions/src/bin/progress.ts';
const JUDGE = '三路分拣';
const root = mkdtempSync(join(tmpdir(), 'progress-kind-'));
const bin = join(root, 'bin');
const COMMENT = {
  id: 123,
  html_url: 'https://github.com/o/r/issues/1055#issuecomment-123',
  created_at: '2026-10-22T02:26:00Z',
  body: '【创始人引导·待处理】2026-10-22 02:26\n\n原话：字节是怎么做的，我们就怎么做吧',
};

/** 账本里一条待处理的 decision.handoff（行 id 123；时间用现在，免得过 30 天） */
const HANDOFF_ROW = {
  id: 123,
  at: new Date().toISOString(),
  actorKind: 'api',
  actorId: 'api:decision-handoff',
  action: 'decision.handoff',
  target: 'progress:o/r',
  after: { text: '创始人已选：字节是怎么做的，我们就怎么做吧（通知 n1）' },
  ok: true,
};

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  const preload = join(root, 'fake-gh.cjs');
  writeFileSync(
    preload,
    [
      "const fs = require('node:fs'), path = require('node:path');",
      // 假法国账本（#3741 片 2c）：GET events 回 FAKE_LEDGER 里的行；POST notes 记进 FAKE_LEDGER_LOG
      'if (process.env.FAKE_LEDGER) {',
      '  globalThis.fetch = async (url, init) => {',
      "    if (process.env.FAKE_LEDGER_DOWN) throw new Error('connect ECONNREFUSED');",
      "    if (String(url).includes('/api/nodes/events')) {",
      "      const after = Number(new URL(String(url)).searchParams.get('after'));",
      '      const events = JSON.parse(process.env.FAKE_LEDGER).filter((e) => e.id > after);',
      '      return new Response(JSON.stringify({ events, next: events.length ? events[events.length - 1].id : after }), { status: 200 });',
      '    }',
      "    if (String(url).includes('/api/nodes/notes')) {",
      "      fs.appendFileSync(process.env.FAKE_LEDGER_LOG, init.body + '\\n');",
      '      return new Response(JSON.stringify({ id: 999, created: true }), { status: 200 });',
      '    }',
      "    return new Response('not found', { status: 404 });",
      '  };',
      '}',
      "const isGh = /^gh(\\.exe)?$/.test(path.basename(process.execPath)) || process.env.FAKE_GH_WRAP === '1';",
      'if (isGh) {',
      '  const args = process.argv.slice(1).filter((a) => !/fake-gh|^[A-Za-z]:\\\\.*gh\\.exe$/.test(a));',
      "  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
      // 挂的单：issue list 回 FAKE_OPEN_ISSUES 里的号（开着的），issue view 一律 OPEN
      // node 把第一个参数当脚本路径，argv[1] 会被解析成绝对路径，所以取 basename 认子命令
      "  const sub = path.basename(args[0] || '');",
      "  if (sub === 'issue' && args[1] === 'list') {",
      "    process.stdout.write(JSON.stringify(JSON.parse(process.env.FAKE_OPEN_ISSUES || '[]').map((number) => ({ number }))));",
      '    process.exit(0);',
      '  }',
      "  if (sub === 'issue' && args[1] === 'view') {",
      "    process.stdout.write('OPEN\\n');",
      '    process.exit(0);',
      '  }',
      '  const state = process.env.FAKE_GH_STATE;',
      "  const patch = args.indexOf('PATCH') >= 0;",
      '  if (patch) {',
      "    const f = args.find((a) => a.startsWith('body='));",
      '    fs.writeFileSync(state, f.slice(5));',
      '  }',
      "  const body = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : process.env.FAKE_GH_BODY;",
      "  process.stdout.write(JSON.stringify({ id: 123, html_url: process.env.FAKE_GH_URL, created_at: '2026-10-22T02:26:00Z', body }));",
      '  process.exit(0);',
      '}',
    ].join('\n'),
  );
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, join(bin, 'gh.exe'));
  } else {
    const sh = join(bin, 'gh');
    writeFileSync(sh, `#!/bin/sh\nFAKE_GH_WRAP=1 exec "${process.execPath}" -e 0 "$@"\n`);
    chmodSync(sh, 0o755);
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** 跑一次 bin。external=true 时调用目录是个带别人远端的空仓（对外仓）。 */
function run(
  args: string[],
  opts: { external?: boolean; ledger?: unknown[]; ledgerDown?: boolean; openIssues?: number[] } = {},
) {
  const dir = mkdtempSync(join(root, 'run-'));
  const log = join(dir, 'gh.log');
  const home = join(dir, 'home');
  const promptLog = join(dir, 'prompt-log');
  const ledgerLog = join(dir, 'ledger-posts.log');
  mkdirSync(home);
  mkdirSync(promptLog);
  mkdirSync(join(home, '.fleet-dao', 'local-sessions'), { recursive: true });
  writeFileSync(
    join(home, '.fleet-dao', 'local-sessions', 'config.json'),
    JSON.stringify({ url: 'http://fr.invalid', token: 'T' }),
  );
  writeFileSync(log, '');
  writeFileSync(ledgerLog, '');
  let initCwd = process.cwd();
  if (opts.external) {
    initCwd = join(dir, 'ext');
    mkdirSync(initCwd);
    runChild('git', ['init', initCwd]);
    runChild('git', ['-C', initCwd, 'config', 'remote.origin.url', 'https://example.invalid/other/project']);
  }
  const r = runChild(process.execPath, [BIN, ...args], {
    env: {
      ...process.env,
      PATH: bin + delimiter + (process.env.PATH ?? ''),
      NODE_OPTIONS: `--require=${join(root, 'fake-gh.cjs')}`,
      FAKE_GH_LOG: log,
      FAKE_GH_STATE: join(dir, 'state.txt'),
      FAKE_GH_BODY: COMMENT.body,
      FAKE_GH_URL: COMMENT.html_url,
      GH_REPO: 'o/r',
      FAKE_LEDGER: JSON.stringify(opts.ledger ?? [HANDOFF_ROW]),
      FAKE_LEDGER_LOG: ledgerLog,
      FAKE_OPEN_ISSUES: JSON.stringify(opts.openIssues ?? []),
      ...(opts.ledgerDown ? { FAKE_LEDGER_DOWN: '1' } : {}),
      INIT_CWD: initCwd,
      HOME: home,
      USERPROFILE: home,
      FLEET_PROMPT_LOG_DIR: promptLog,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const state = join(dir, 'state.txt');
  const posts = readFileSync(ledgerLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; text: string; repo: string });
  return { ...r, calls, posts, patched: existsSync(state) ? readFileSync(state, 'utf8') : null };
}

describe('pnpm progress directive 先判类', { timeout: 0 }, () => {
  it('不带 --kind：退出 1，打出判法，一次 gh 都没调', () => {
    for (const args of [
      ['directive', '问题里的原话'],
      ['directive', '--from-inbox', '123'],
    ]) {
      const r = run(args);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('--kind');
      expect(r.stderr).toContain(JUDGE);
      expect(r.calls).toEqual([]);
    }
  });

  it('不带 --kind：打出完整三路分拣表，每类都点到、判不准的出口在内', () => {
    const r = run(['directive', '问题里的原话']);
    for (const kind of ['once', 'task', 'discuss', 'ai', 'product', 'ops']) expect(r.stderr).toContain(kind);
    expect(r.stderr).toContain('驾驶舱库');
    expect(r.stderr).not.toContain('记进 fleet-dao 的 docs/directives/');
    expect(r.stderr).toContain('本机 AI 记忆');
    expect(r.stderr).toContain('生效中的临时调整');
    expect(r.stderr).toContain('决定 0013 第 4 条');
    expect(r.stderr).toContain('判不准按产品');
  });

  it('--kind discuss：指到起稿命令，不写文件、退出 0；--from-inbox 往账本记已处理', () => {
    const r = run(['directive', '--kind', 'discuss', '一次提了好几点']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pnpm discuss:new');
    expect(r.stdout).toContain('discussion-draft');
    expect(r.calls).toEqual([]);
    const inbox = run(['directive', '--kind', 'discuss', '--from-inbox', '123']);
    expect(inbox.status).toBe(0);
    expect(inbox.patched).toBeNull();
    expect(inbox.posts).toHaveLength(1);
    expect(inbox.posts[0]?.text).toMatch(/^已处理 123：/);
    expect(inbox.posts[0]?.text).toContain('pnpm discuss:new');
  });

  it('--kind 的值认不出：退出 1，打出判法，一次 gh 都没调', () => {
    const r = run(['directive', '--kind', 'whatever', '--from-inbox', '123']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('whatever');
    expect(r.stderr).toContain(JUDGE);
    expect(r.calls).toEqual([]);
  });

  for (const kind of ['product', 'task', 'once', 'ops', 'discuss']) {
    it(`--kind ${kind}：零写入、没调 gh、退出 0，说清去处`, () => {
      const r = run(['directive', '--kind', kind, '字节是怎么做的，我们就怎么做吧']);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('没写文件');
      expect(r.calls).toEqual([]);
    });
  }

  it('去处按类别说：product 设计文档、task 开单、once 不记、ops 临时调整', () => {
    const where = (k: string) => run(['directive', '--kind', k, 'x']).stdout;
    expect(where('product')).toContain('设计文档');
    expect(where('task')).toContain('pnpm issue:new');
    expect(where('once')).toContain('不记');
    expect(where('ops')).toContain('生效中的临时调整');
  });

  it('对外仓 product：说照那个仓的记法写成结论，不提示贴原话', () => {
    const r = run(['directive', '--kind', 'product', 'x'], { external: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('原话只进私有处');
    expect(r.stdout).not.toContain('贴原话');
    expect(r.calls).toEqual([]);
  });

  it('--from-inbox 带 product：往账本记已处理并写明去处，退出 0，不再改 #1055 评论', () => {
    const r = run(['directive', '--kind', 'product', '--from-inbox', '123']);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes('PATCH'))).toBe(false);
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({ kind: 'progress.note', repo: 'o/r' });
    expect(r.posts[0]?.text).toMatch(/^已处理 123：记在 /);
    expect(r.posts[0]?.text).toContain('设计文档');
    expect(r.stdout).toContain('已标成已处理');
  });

  it('--from-inbox 旧的 10 位评论号：退出 1，说明改读账本和新用法，账本一次没碰', () => {
    const r = run(['directive', '--kind', 'product', '--from-inbox', '4398046511']);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('旧的 #1055 评论号');
    expect(r.stderr).toContain('progress read --pending');
    expect(r.posts).toEqual([]);
  });

  it('--from-inbox 的编号不在待处理里（已迁过）：退出 1，不再记', () => {
    const migrated = {
      ...HANDOFF_ROW,
      id: 124,
      action: 'progress.note',
      after: { text: '已迁 123：docs/directives/x.md' },
    };
    const r = run(['directive', '--kind', 'product', '--from-inbox', '123'], {
      ledger: [HANDOFF_ROW, migrated],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('不在 o/r 的待处理引导里');
    expect(r.posts).toEqual([]);
  });

  it('【故意造出的失败】法国账本读不到：--from-inbox 和 read --pending 都退出 2，不当成没有', () => {
    for (const args of [
      ['directive', '--kind', 'product', '--from-inbox', '123'],
      ['read', '--pending'],
    ]) {
      const r = run(args, { ledgerDown: true });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('读法国账本没成');
      expect(r.stdout).toBe('');
    }
  });

  it('--kind ai 过了判类、给了意思，到取原话那步（prompt-log 是空的，要手填）才停', () => {
    const r = run(['directive', '--kind', 'ai', '--meaning', '会话先读规矩', '--owner', '无主']);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain(JUDGE);
    expect(r.stderr).toContain('prompt-log');
    expect(r.stderr).toContain('手填');
    expect(r.stdout).not.toContain('没写文件');
  });

  it('--kind ai 不给 --meaning：退出 1，说明原话不进公开仓，一次 gh 和账本都没碰', () => {
    const r = run([
      'directive',
      '--kind',
      'ai',
      '原话-secret',
      '--at',
      '2026-10-30 10:00',
      '--owner',
      '无主',
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--meaning');
    expect(r.calls).toEqual([]);
    expect(r.posts).toEqual([]);
  });
});

describe('pnpm progress directive 记进账本（#3764）', { timeout: 0 }, () => {
  const dirsBefore = () => readdirSync('docs/directives', { recursive: true }).sort();

  it('记一条：只 POST 一条 kind=directive 的账本行；不开 PR、不写 docs/directives/、不推分支', () => {
    const before = dirsBefore();
    const r = run(
      [
        'directive',
        '--kind',
        'ai',
        '原话-secret-quote',
        '--at',
        '2026-10-30 10:00',
        '--owner',
        '无主',
        '--meaning',
        '会话先读规矩再动手',
        '--issue',
        '777',
      ],
      { openIssues: [777] },
    );
    expect({ status: r.status, stderr: r.stderr }).toEqual({ status: 0, stderr: '' });
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0]).toMatchObject({
      kind: 'directive',
      repo: 'o/r',
      issue: 777,
      text: '原话-secret-quote',
      meaning: '会话先读规矩再动手',
      category: 'ai',
      owner: '无主',
      spokenAt: '2026-10-30 10:00 +0800',
    });
    // gh 只被用来查挂的单：没有 pr、没有 create
    expect(r.calls.some((c) => c.includes('"pr"') || c.includes('"create"'))).toBe(false);
    expect(r.stdout).toContain('没写文件、没开 PR');
    expect(dirsBefore()).toEqual(before);
  });

  it('账本写不成：退出 2，说没记成，同样不写文件、不开 PR', () => {
    const before = dirsBefore();
    const r = run(
      [
        'directive',
        '--kind',
        'ai',
        'x-quote',
        '--at',
        '2026-10-30 10:00',
        '--owner',
        '无主',
        '--meaning',
        '意思',
        '--issue',
        '777',
      ],
      { ledgerDown: true, openIssues: [777] },
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('往法国账本记引导没成');
    expect(r.calls.some((c) => c.includes('"pr"'))).toBe(false);
    expect(dirsBefore()).toEqual(before);
  });

  it('read --pending 从账本读到待办引导：挂的单开着才列，列出编号、原话、主人、单；挂的单关了不列', () => {
    const row = {
      id: 321,
      at: new Date().toISOString(),
      actorKind: 'agent',
      actorId: 'node:x',
      action: 'directive',
      target: 'issue:o/r#777',
      after: {
        text: '账本里的原话',
        meaning: '账本里的意思',
        category: 'ai',
        owner: 'dir-a',
        spokenAt: '2026-10-30 10:00 +0800',
      },
      ok: true,
    };
    const open = run(['read', '--pending'], { ledger: [row], openIssues: [777] });
    expect({ status: open.status, stderr: open.stderr }).toEqual({ status: 0, stderr: '' });
    const line = open.stdout.split('\n').find((l) => l.startsWith('321\t'));
    expect(line?.split('\t')).toEqual([
      '321',
      '【创始人引导·待处理】2026-10-30 10:00 +0800',
      '账本里的原话',
      'dir-a',
      row.at,
      '#777',
    ]);
    const closed = run(['read', '--pending'], { ledger: [row], openIssues: [] });
    expect(closed.status).toBe(0);
    expect(closed.stdout).not.toContain('321\t');
  });
});
