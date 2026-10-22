import { randomUUID } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  directiveIssueDraft,
  formatDirective,
  parseDirective,
  recordDirective,
  resolveDirective,
} from '../src/directives.ts';
import {
  flushPrivateQuotes,
  privatizeDirective,
  quotesDir,
  savePrivateQuote,
} from '../src/private-quotes.ts';
import { progressSessionId } from '../src/progress-session.ts';
import { runChild } from './child.ts';

const homes: string[] = [];
const home = () => {
  const h = mkdtempSync(join(tmpdir(), 'private-quotes-'));
  homes.push(h);
  return h;
};
afterEach(() => {
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
const q = () => ({
  id: randomUUID(),
  spokenAt: '2026-10-18T10:00:00Z',
  text: '合成不可公开原文',
  machine: 'fixture-machine',
  lineage: 'fixture-session',
  remote: ['https://fixture', 'synthetic-password@fixture.invalid/project'].join(':'),
  directiveId: null,
});
const fail = async () => ({ code: 1, stdout: '合成不可公开原文', stderr: 'synthetic-password' });
describe('私有原话先本机再上传', () => {
  it('缺meaning先拒绝，不存、不上传', async () => {
    const h = home();
    let called = false;
    await expect(
      privatizeDirective(
        { text: '合成原话', atDate: new Date(), owner: 'fixture-session' },
        {
          home: h,
          machine: 'fixture',
          lineage: 'fixture-session',
          remote: null,
          meaning: undefined,
          api: async () => {
            called = true;
            return fail();
          },
        },
      ),
    ).rejects.toThrow('--meaning');
    expect(called).toBe(false);
    expect(existsSync(quotesDir(h))).toBe(false);
  });
  it('上传失败原文留私有文件，所有公开材料只有意思和私有编号；正文只走stdin', async () => {
    const h = home(),
      quote = q();
    let seen = false;
    const result = await privatizeDirective(
      {
        text: quote.text,
        atDate: new Date(quote.spokenAt),
        at: '2026-10-18 18:00 +0800',
        owner: 'fixture-session',
        source: '手填',
      },
      {
        home: h,
        machine: quote.machine,
        lineage: quote.lineage,
        remote: quote.remote,
        meaning: '按既定规则执行',
        api: async (args, stdin) => {
          expect(args).toEqual(['quote', 'put']);
          expect(args.join(' ')).not.toContain(quote.text);
          const payload = JSON.parse(stdin!)[0];
          expect(readFileSync(join(quotesDir(h), payload.id + '.json'), 'utf8')).toContain(quote.text);
          seen = true;
          return fail();
        },
      },
    );
    expect(seen).toBe(true);
    expect(result.remaining).toBe(1);
    const d = result.directive;
    const publicText = JSON.stringify({
      file: formatDirective({ ...d, id: '20261018180000', issue: 3109, log: [] }),
      issue: directiveIssueDraft(d),
    });
    expect(publicText).toContain('按既定规则执行');
    expect(publicText).toContain('原话：私有处');
    expect(publicText).not.toContain(quote.text);
    expect(publicText).not.toContain('synthetic-password');
  });
  it('逐id确认才删，坏回执/网络异常不删；随后补传可恢复', async () => {
    const h = home(),
      quote = q();
    savePrivateQuote(h, quote);
    expect(
      await flushPrivateQuotes(h, async () => ({
        code: 0,
        stdout: JSON.stringify({ ids: [randomUUID()] }),
        stderr: '',
      })),
    ).toEqual({ sent: 0, remaining: 1 });
    expect(
      await flushPrivateQuotes(h, async () => {
        throw new Error(quote.text);
      }),
    ).toEqual({ sent: 0, remaining: 1 });
    expect(
      await flushPrivateQuotes(h, async (args, stdin) => ({
        code: 0,
        stdout: JSON.stringify({ ids: [JSON.parse(stdin!)[0].id] }),
        stderr: '',
      })),
    ).toEqual({ sent: 1, remaining: 0 });
    expect(readdirSync(quotesDir(h))).toEqual([]);
  });
  it('损坏数据不上传、不回显，已有文件不覆盖', async () => {
    const h = home(),
      quote = q();
    savePrivateQuote(h, quote);
    expect(() => savePrivateQuote(h, quote)).toThrow();
    writeFileSync(join(quotesDir(h), quote.id + '.json'), '合成敏感坏JSON');
    let called = false;
    expect(
      await flushPrivateQuotes(h, async () => {
        called = true;
        return fail();
      }),
    ).toEqual({ sent: 0, remaining: 1 });
    expect(called).toBe(false);
    if (process.platform !== 'win32') expect(statSync(quotesDir(h)).mode & 0o777).toBe(0o700);
  });
});

describe('真实progress入口', { timeout: 0 }, () => {
  it('对外仓普通和收件箱入口缺meaning都先拒绝，不回显原文和remote', () => {
    const h = home();
    expect(runChild('git', ['init', h]).status).toBe(0);
    expect(
      runChild('git', [
        '-C',
        h,
        'config',
        'remote.origin.url',
        ['https://fixture', 'synthetic-password@fixture.invalid/project'].join(':'),
      ]).status,
    ).toBe(0);
    for (const args of [
      ['directive', '--kind', 'ai'],
      ['directive', '--kind', 'ai', '--from-inbox', '123'],
    ]) {
      const result = runChild(process.execPath, ['packages/conventions/src/bin/progress.ts', ...args], {
        env: { ...process.env, INIT_CWD: h, USERPROFILE: h, HOME: h },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('--meaning');
      expect(result.stderr + result.stdout).not.toContain('synthetic-password');
    }
  });
  it('补传入口在没有node_modules的同步检出也能启动', () => {
    const h = home();
    mkdirSync(join(h, 'packages/conventions'), { recursive: true });
    mkdirSync(join(h, 'packages/shared/src'), { recursive: true });
    mkdirSync(join(h, 'agents'), { recursive: true });
    cpSync('packages/conventions/src', join(h, 'packages/conventions/src'), { recursive: true });
    cpSync('packages/shared/src/private-quotes.ts', join(h, 'packages/shared/src/private-quotes.ts'));
    cpSync('packages/shared/src/ci-policy-bridge.ts', join(h, 'packages/shared/src/ci-policy-bridge.ts'));
    cpSync('agents/hooks', join(h, 'agents/hooks'), { recursive: true });
    writeFileSync(join(h, 'package.json'), JSON.stringify({ type: 'module' }));
    const env: NodeJS.ProcessEnv = { ...process.env, USERPROFILE: h, HOME: h, INIT_CWD: h, NODE_PATH: '' };
    // 两个颜色变量同时在时，node 自己往 stderr 打一行警告，不是这个入口写的。
    if (env.FORCE_COLOR && env.NO_COLOR) delete env.NO_COLOR;
    const result = runChild(
      process.execPath,
      [join(h, 'packages/conventions/src/bin/progress.ts'), 'quotes:flush'],
      {
        cwd: h,
        env,
      },
    );
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('成功 0');
  });
});

it('原生会话号覆盖Claude和Codex，坏来源不得借另一会话', () => {
  expect(
    progressSessionId({ CLAUDE_CODE_SESSION_ID: 'fixture-claude', CODEX_THREAD_ID: 'fixture-codex' }),
  ).toBe('fixture-claude');
  expect(progressSessionId({ CODEX_THREAD_ID: 'fixture-thread', CODEX_SESSION_ID: 'fixture-root' })).toBe(
    'fixture-thread',
  );
  expect(progressSessionId({ CODEX_SESSION_ID: 'fixture-root' })).toBe('fixture-root');
  expect(progressSessionId({})).toBeNull();
  expect(() =>
    progressSessionId({ CLAUDE_CODE_SESSION_ID: 'bad/id', CODEX_THREAD_ID: 'fixture-thread' }),
  ).toThrow('未借其他会话');
});

it('积压离线只发一批，不逐条串联；新引导只试本条', async () => {
  const h = home();
  for (let i = 0; i < 105; i++) savePrivateQuote(h, q());
  let calls = 0;
  expect(
    await flushPrivateQuotes(h, async (_args, stdin) => {
      calls++;
      expect(JSON.parse(stdin!)).toHaveLength(100);
      return fail();
    }),
  ).toEqual({ sent: 0, remaining: 105 });
  expect(calls).toBe(1);
  const original = q();
  const result = await privatizeDirective(
    { text: original.text, atDate: new Date(original.spokenAt), owner: 'fixture-session' },
    {
      home: h,
      machine: 'fixture',
      lineage: 'fixture-session',
      remote: null,
      meaning: '公开意思',
      api: async (_args, stdin) => {
        calls++;
        const batch = JSON.parse(stdin!);
        expect(batch).toHaveLength(1);
        return { code: 0, stdout: JSON.stringify({ ids: [batch[0].id] }), stderr: '' };
      },
    },
  );
  expect(calls).toBe(2);
  expect(result.sent).toBe(1);
  expect(result.remaining).toBe(105);
  expect(result.directive.owner).toBe('fixture-session');
});

it('公开引导读回私有编号，原文解析模式不吞首尾空白', () => {
  const quote = q(),
    id = '20261018180000';
  const raw = formatDirective({
    id,
    issue: 3109,
    at: '2026-10-18 18:00 +0800',
    owner: 'fixture-session',
    source: '私有记录',
    text: '可公开意思',
    log: [],
    privateQuoteId: quote.id,
  });
  expect(parseDirective(raw, 'fixture.md')).toMatchObject({
    text: '可公开意思',
    privateQuoteId: quote.id,
    owner: 'fixture-session',
  });
  const original = ' \n合成原话 \n';
  expect(
    resolveDirective(
      { text: original, at: '2026-10-18 18:00', owner: '无主', preserveText: true },
      { status: 'none', why: 'fixture' },
      { entries: [] },
      'fixture-codex',
    ).text,
  ).toBe(original);
});

it('私有目录被软链替换时拒绝存取，不向外部目录写原文', async () => {
  const h = home(),
    outside = home();
  mkdirSync(join(h, '.fleet-dao'), { recursive: true });
  symlinkSync(outside, join(h, '.fleet-dao/private'), process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => savePrivateQuote(h, q())).toThrow('目录不安全');
  expect(readdirSync(outside)).toEqual([]);
  mkdirSync(join(outside, 'quotes'));
  await expect(flushPrivateQuotes(h, fail)).rejects.toThrow('不可安全读取');
});

it('外仓成功上传后真实recordDirective发布链只传意思和私有编号', async () => {
  const h = home(),
    quote = q();
  const saved = await privatizeDirective(
    {
      text: quote.text,
      atDate: new Date(quote.spokenAt),
      at: '2026-10-18 18:00 +0800',
      owner: 'fixture-session',
      source: '手填',
    },
    {
      home: h,
      machine: quote.machine,
      lineage: quote.lineage,
      remote: quote.remote,
      meaning: '可公开意思',
      api: async (_args, stdin) => ({
        code: 0,
        stdout: JSON.stringify({ ids: [JSON.parse(stdin!)[0].id] }),
        stderr: '',
      }),
    },
  );
  expect(saved.remaining).toBe(0);
  const publicCalls: unknown[] = [];
  const made = await recordDirective(
    saved.directive,
    {
      git: async (args, opts) => {
        publicCalls.push({ args, opts });
        return { code: 0, stdout: args[0] === 'ls-tree' ? '' : 'a'.repeat(40), stderr: '' };
      },
      gh: async (args) => {
        publicCalls.push(args);
        return {
          code: 0,
          stdout:
            args[0] === 'issue'
              ? 'OPEN'
              : args[1] === 'create'
                ? 'https://github.com/fixture/fixture/pull/1'
                : args[1] === 'view'
                  ? JSON.stringify({ labels: [{ name: '域:engine' }, { name: '性质:process' }] })
                  : '',
          stderr: '',
        };
      },
    },
    3109,
  );
  expect(made.issue).toBe(3109);
  const published = JSON.stringify(publicCalls);
  expect(published).toContain('可公开意思');
  expect(published).toContain('原话：私有处');
  expect(published).not.toContain(quote.text);
  expect(published).not.toContain('synthetic-password');
});
