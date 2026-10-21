// 复杂快照在采集前明确拒绝不支持的浅仓（#3511）。
// v3 帧只保存索引、工作文件、操作状态和对象清单，不保存 Git 的 shallow 边界，浅仓的对象闭包不完整，
// 只会晚到独立恢复才缺对象。这里用真实 Git 的浅克隆、链接工作树和完整克隆，直接跑脚本 complex-snapshot.mjs，
// 用包装器记下每次 Git 调用，证明拒绝发生在 pack-objects、bundle、递归收集之前。
// 只在 Linux 跑（脚本用逐级 dirfd 打开器）；Windows 明确跳过，不冒充通过。
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChildBytes } from '../child.ts';

const SCRIPT = readFileSync(new URL('../../src/real/complex-snapshot.mjs', import.meta.url), 'utf8');
const PROBE = 'is-shallow-repository';
/** 拒绝之前不许出现的昂贵步骤：只要这些命令里有一条被调用，就说明拒绝晚了。 */
const EXPENSIVE =
  /pack-objects|bundle|rev-list|ls-files|cat-file|for-each-ref|rev-parse HEAD|stash|index-pack/;

let root: string;
let origin: string;
let full: string;
let shallow: string;
let fullLinked: string;
let shallowLinked: string;
let wrapper: string;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
    'GIT_SHALLOW_FILE',
    'GIT_COMMON_DIR',
  ]) {
    delete out[key];
  }
  return {
    ...out,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 'fleet-test@localhost',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 'fleet-test@localhost',
    ...extra,
  };
}

function git(cwd: string, args: string[]): string {
  const result = runChildBytes('git', args, { cwd, env: env() });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} 退出 ${result.status}：${result.stderr.toString('utf8').slice(0, 400)}`);
  }
  return result.stdout.toString('utf8').trim();
}

function snap(
  mode: 'inspect' | 'capture' | 'verify',
  cwd: string,
  extra: Record<string, string> = {},
  input?: Buffer,
) {
  const log = join(root, `git-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(log, '');
  const result = runChildBytes(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd,
    env: env({ FLEET_SNAP_MODE: mode, FLEET_GIT: wrapper, FLEET_TEST_GIT_LOG: log, ...extra }),
    ...(input === undefined ? {} : { input }),
    limitMs: 120_000,
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8'), calls };
}

/** 源树上不该变的东西：工作文件、索引、HEAD、引用、浅边界文件的字节摘要。 */
function fingerprint(dir: string): string {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--absolute-git-dir']);
  const hash = createHash('sha256');
  for (const file of [
    join(dir, 'dirty.txt'),
    join(gitDir, 'index'),
    join(gitDir, 'HEAD'),
    join(common, 'shallow'),
    join(common, 'packed-refs'),
  ]) {
    hash.update(`${file}\n`);
    hash.update(existsSync(file) ? readFileSync(file) : Buffer.from('<缺>'));
  }
  hash.update(git(dir, ['for-each-ref', '--format=%(objectname) %(refname)']));
  return hash.digest('hex');
}

function expectEarlyReject(result: ReturnType<typeof snap>, pattern: RegExp): void {
  expect(result.status).not.toBe(0);
  expect(result.stdout.length).toBe(0);
  expect(result.stderr).toMatch(pattern);
  expect(result.calls.length).toBeGreaterThan(0);
  expect(result.calls.filter((call) => EXPENSIVE.test(call))).toEqual([]);
  expect(result.calls.every((call) => call.includes(PROBE))).toBe(true);
}

beforeAll(() => {
  if (process.platform !== 'linux') return;
  root = mkdtempSync(join(tmpdir(), 'fleet-snap-shallow-'));
  origin = join(root, 'origin');
  mkdirSync(origin);
  git(origin, ['init', '-q', '-b', 'main']);
  for (let i = 1; i <= 3; i += 1) {
    writeFileSync(join(origin, 'a.txt'), `version${i}\n`);
    git(origin, ['add', '.']);
    git(origin, ['commit', '-q', '-m', `commit${i}`]);
  }
  full = join(root, 'full');
  shallow = join(root, 'shallow');
  git(root, ['clone', '-q', `file://${origin}`, full]);
  git(root, ['clone', '-q', '--depth=1', `file://${origin}`, shallow]);
  fullLinked = join(root, 'full-linked');
  shallowLinked = join(root, 'shallow-linked');
  git(full, ['worktree', 'add', '-q', '-b', 'side', fullLinked, 'HEAD']);
  git(shallow, ['worktree', 'add', '-q', '-b', 'side', shallowLinked, 'HEAD']);
  for (const dir of [full, shallow, fullLinked, shallowLinked])
    writeFileSync(join(dir, 'dirty.txt'), 'dirty\n');
  wrapper = join(root, 'git-wrapper.sh');
  // 记下每次 Git 调用；只在「是不是浅仓」的探测上按模式造失败、空输出、垃圾输出，其余照常转给真实 Git。
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FLEET_TEST_GIT_LOG"',
      'case "$*" in',
      `  *${PROBE}*)`,
      '    case "$FLEET_TEST_PROBE" in',
      '      fail) echo boom >&2; exit 3 ;;',
      '      empty) exit 0 ;;',
      '      garbage) echo maybe; exit 0 ;;',
      '      blank) echo; exit 0 ;;',
      '      multi) printf "false\\nfalse\\n"; exit 0 ;;',
      '    esac ;;',
      'esac',
      'exec git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
}, 120_000);

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('复杂快照拒绝不支持的浅仓', { timeout: 0 }, () => {
  it('夹具里的浅克隆确实是浅的，完整克隆不是', () => {
    expect(git(shallow, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(git(shallowLinked, ['rev-parse', '--is-shallow-repository'])).toBe('true');
    expect(git(full, ['rev-parse', '--is-shallow-repository'])).toBe('false');
    expect(git(fullLinked, ['rev-parse', '--is-shallow-repository'])).toBe('false');
  });

  for (const [label, dir] of [
    ['浅普通克隆', () => shallow],
    ['浅克隆的链接工作树', () => shallowLinked],
  ] as const) {
    for (const mode of ['inspect', 'capture'] as const) {
      it(`${label}的 ${mode} 在任何昂贵步骤之前明确拒绝，源树不变`, () => {
        const cwd = dir();
        const before = fingerprint(cwd);
        const result = snap(mode, cwd);
        expectEarlyReject(result, /浅仓不能自包含保全，保留原树/);
        expect(fingerprint(cwd)).toBe(before);
        expect(readFileSync(join(cwd, 'dirty.txt'), 'utf8')).toBe('dirty\n');
      });
    }
  }

  it('完整克隆和它的链接工作树照常 inspect、capture，并能在独立空仓恢复', () => {
    for (const cwd of [full, fullLinked]) {
      const before = fingerprint(cwd);
      const inspected = snap('inspect', cwd);
      expect(inspected.stderr).toBe('');
      expect(inspected.status).toBe(0);
      const captured = snap('capture', cwd);
      expect(captured.stderr).toBe('');
      expect(captured.status).toBe(0);
      expect(captured.stdout.length).toBeGreaterThan(0);
      const verified = snap('verify', cwd, {}, captured.stdout);
      expect(verified.stderr).toBe('');
      expect(verified.status).toBe(0);
      expect(fingerprint(cwd)).toBe(before);
    }
  });

  it('每次 collect 都现测，不跨调用缓存', () => {
    const first = snap('inspect', full);
    const second = snap('inspect', full);
    expect(first.calls.filter((call) => call.includes(PROBE))).toHaveLength(1);
    expect(second.calls.filter((call) => call.includes(PROBE))).toHaveLength(1);
  });

  for (const probe of ['fail', 'empty', 'garbage', 'blank', 'multi'] as const) {
    it(`读浅仓判定得到「${probe}」时拒绝，不当成完整仓`, () => {
      for (const mode of ['inspect', 'capture'] as const) {
        const before = fingerprint(full);
        const result = snap(mode, full, { FLEET_TEST_PROBE: probe });
        expectEarlyReject(result, /浅仓判定没看成|浅仓判定认不出/);
        expect(fingerprint(full)).toBe(before);
      }
    });
  }

  it('环境里的 GIT_SHALLOW_FILE 指向空文件，也不能让真实浅仓冒充完整仓', () => {
    const empty = join(root, 'empty-shallow-file');
    writeFileSync(empty, '');
    for (const mode of ['inspect', 'capture'] as const) {
      const result = snap(mode, shallow, { GIT_SHALLOW_FILE: empty });
      expectEarlyReject(result, /浅仓不能自包含保全，保留原树/);
    }
  });

  it('环境里的 GIT_SHALLOW_FILE 指向别的浅文件，也不能让完整仓被误当成浅仓', () => {
    const other = join(git(shallow, ['rev-parse', '--path-format=absolute', '--git-common-dir']), 'shallow');
    expect(readFileSync(other, 'utf8').trim()).toMatch(/^[0-9a-f]{40}$/);
    const before = fingerprint(full);
    const inspected = snap('inspect', full, { GIT_SHALLOW_FILE: other });
    expect(inspected.stderr).toBe('');
    expect(inspected.status).toBe(0);
    const captured = snap('capture', full, { GIT_SHALLOW_FILE: other });
    expect(captured.stderr).toBe('');
    expect(captured.status).toBe(0);
    const verified = snap('verify', full, { GIT_SHALLOW_FILE: other }, captured.stdout);
    expect(verified.stderr).toBe('');
    expect(verified.status).toBe(0);
    expect(fingerprint(full)).toBe(before);
  });
});
