// 记引导前先判类（决定 0111）：真起 bin 子进程，gh 换成假的（把 node 拷成 gh，用 NODE_OPTIONS 预加载假行为，记下每次调用）。
// 非 ai 的类别不写文件、不开单、退出 0；不带或认不出 --kind 退出 1 且一次 gh 都没调。
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
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

beforeAll(() => {
  mkdirSync(bin, { recursive: true });
  const preload = join(root, 'fake-gh.cjs');
  writeFileSync(
    preload,
    [
      "const fs = require('node:fs'), path = require('node:path');",
      "const isGh = /^gh(\\.exe)?$/.test(path.basename(process.execPath)) || process.env.FAKE_GH_WRAP === '1';",
      'if (isGh) {',
      '  const args = process.argv.slice(1).filter((a) => !/fake-gh|^[A-Za-z]:\\\\.*gh\\.exe$/.test(a));',
      "  fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(args) + '\\n');",
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
function run(args: string[], opts: { external?: boolean } = {}) {
  const dir = mkdtempSync(join(root, 'run-'));
  const log = join(dir, 'gh.log');
  const home = join(dir, 'home');
  const promptLog = join(dir, 'prompt-log');
  mkdirSync(home);
  mkdirSync(promptLog);
  writeFileSync(log, '');
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
      INIT_CWD: initCwd,
      HOME: home,
      USERPROFILE: home,
      FLEET_PROMPT_LOG_DIR: promptLog,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  const state = join(dir, 'state.txt');
  return { ...r, calls, patched: existsSync(state) ? readFileSync(state, 'utf8') : null };
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
    expect(r.stderr).toContain('docs/directives/');
    expect(r.stderr).toContain('本机 AI 记忆');
    expect(r.stderr).toContain('生效中的临时调整');
    expect(r.stderr).toContain('决定 0013 第 4 条');
    expect(r.stderr).toContain('判不准按产品');
  });

  it('--kind discuss：指到起稿命令，不写文件、退出 0；--from-inbox 评论改成已处理', () => {
    const r = run(['directive', '--kind', 'discuss', '一次提了好几点']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('pnpm discuss:new');
    expect(r.stdout).toContain('discussion-draft');
    expect(r.calls).toEqual([]);
    const inbox = run(['directive', '--kind', 'discuss', '--from-inbox', '123']);
    expect(inbox.status).toBe(0);
    expect(inbox.patched).toMatch(/^【创始人引导·已处理】/);
    expect(inbox.patched).toContain('pnpm discuss:new');
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

  it('--from-inbox 带 product：评论改写成已处理并写明去处，退出 0', () => {
    const r = run(['directive', '--kind', 'product', '--from-inbox', '123']);
    expect(r.status).toBe(0);
    expect(r.calls.some((c) => c.includes('PATCH'))).toBe(true);
    expect(r.patched).not.toBeNull();
    expect(r.patched).toMatch(/^【创始人引导·已处理】/);
    expect(r.patched).toContain('记在 ');
    expect(r.patched).toContain('设计文档');
    expect(r.stdout).toContain('已标成已处理');
  });

  it('--kind ai 照旧走记录流程：过了判类，到取原话那步（prompt-log 是空的，要手填）才停', () => {
    const r = run(['directive', '--kind', 'ai']);
    expect(r.status).toBe(1);
    expect(r.stderr).not.toContain(JUDGE);
    expect(r.stderr).toContain('没记');
    expect(r.stdout).not.toContain('没写文件');
  });
});
