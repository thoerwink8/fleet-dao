// 复杂快照 verify 的两段对象核对走有界批量 cat-file：真实 Git 隔离仓，按进程调用计数证明不再逐对象起 Git。
// 基准只打印实际平台、规模和耗时，不拿毫秒数当闸门。
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runChildBytes } from '../child.ts';

const SCRIPT = readFileSync(new URL('../../src/real/complex-snapshot.mjs', import.meta.url), 'utf8');
const BATCH = 4096;
// 恢复段专用的格式，和 collect 带 objectsize 的格式分得开。
const RESTORE_CHECK = /%\(objecttype\)$/;
const PHYSICAL_CHECK = /cat-file --batch-all-objects --batch-check=%\(objectname\)$/;
const BULK = BATCH + 300;

interface SnapObject {
  sha: string;
  type: string;
}
interface SnapState {
  objects: SnapObject[];
}

let root: string;
let repo: string;
let wrapper: string;
let frame: Buffer;
let state: SnapState;

function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const out = { ...process.env };
  for (const key of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
    'GIT_NAMESPACE',
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

function git(cwd: string, args: string[], input?: Buffer | string): Buffer {
  const result = runChildBytes('git', args, { cwd, env: env(), ...(input === undefined ? {} : { input }) });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} 退出 ${result.status}：${result.stderr.toString('utf8').slice(0, 400)}`);
  }
  return result.stdout;
}

function snap(mode: 'capture' | 'verify', input: Buffer | undefined, extra: Record<string, string> = {}) {
  const log = join(root, `git-${Math.random().toString(16).slice(2)}.log`);
  writeFileSync(log, '');
  const result = runChildBytes(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: repo,
    env: env({ FLEET_SNAP_MODE: mode, FLEET_GIT: wrapper, FLEET_TEST_GIT_LOG: log, ...extra }),
    ...(input === undefined ? {} : { input }),
    limitMs: 120_000,
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: result.status, stdout: result.stdout, stderr: result.stderr.toString('utf8'), calls };
}

function parseFrame(bytes: Buffer): [string, Buffer][] {
  const parts: [string, Buffer][] = [];
  let at = 0;
  for (;;) {
    const nl = bytes.indexOf(10, at);
    const line = bytes.subarray(at, nl).toString('ascii');
    at = nl + 1;
    if (line === 'END') break;
    const space = line.lastIndexOf(' ');
    const length = Number(line.slice(space + 1));
    parts.push([line.slice(0, space), bytes.subarray(at, at + length)]);
    at += length;
  }
  expect(at).toBe(bytes.length);
  return parts;
}

function buildFrame(parts: [string, Buffer][]): Buffer {
  const out: Buffer[] = [];
  for (const [name, value] of parts) out.push(Buffer.from(`${name} ${value.length}\n`), value);
  out.push(Buffer.from('END\n'));
  return Buffer.concat(out);
}

function replace(name: string, value: Buffer): Buffer {
  return buildFrame(parseFrame(frame).map(([key, bytes]) => [key, key === name ? value : bytes]));
}

function withObjects(objects: SnapObject[]): Buffer {
  return replace('JSON', Buffer.from(JSON.stringify({ ...state, objects })));
}

function byType(type: string, from = 0): number {
  const index = state.objects.findIndex((obj, i) => i >= from && obj.type === type);
  if (index < 0) throw new Error(`夹具缺 ${type}`);
  return index;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'fleet-snap-batch-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  wrapper = join(root, 'git-wrapper.sh');
  // 记下每次 Git 调用；只在恢复段的批量核对上按模式造坏输出、失败或被杀，其余照常转给真实 Git。
  writeFileSync(
    wrapper,
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FLEET_TEST_GIT_LOG"',
      'case "$*" in',
      "  *'fetch --no-tags '* )",
      '    if [ -n "$FLEET_TEST_EXTRA_PACK" ]; then',
      '      git index-pack --stdin --strict < "$FLEET_TEST_EXTRA_PACK" >/dev/null || exit 4',
      '    fi ;;',
      "  *'cat-file --batch-all-objects --batch-check=%(objectname)')",
      '    case "$FLEET_TEST_PHYSICAL_MODE" in',
      '      empty) exit 0 ;;',
      '      cut) git "$@" | head -c -1; exit 0 ;;',
      "      invalid) printf 'invalid\\n'; exit 0 ;;",
      '      blank) git "$@"; printf \'\\n\'; exit 0 ;;',
      '      duplicate) git "$@"; git "$@" | head -n 1; exit 0 ;;',
      '      limit) awk \'BEGIN {for(i=0;i<250001;i++) printf "%040x\\n",i}\'; exit 0 ;;',
      '      buffer) awk \'BEGIN {for(i=0;i<250003;i++) printf "%040x\\n",i}\'; exit 0 ;;',
      '      reverse) git "$@" | sort -r; exit 0 ;;',
      '      fail) echo boom >&2; exit 3 ;;',
      '      kill) kill -9 $$ ;;',
      '    esac ;;',
      "  *'%(objecttype) %(objectsize)')",
      '    case "$FLEET_TEST_SIZE_MODE" in',
      '      identity) git "$@" | sed \'1s/^[0-9a-f]*/ffffffffffffffffffffffffffffffffffffffff/\'; exit 0 ;;',
      '      type) git "$@" | sed \'1s/ [a-z]* / bogus /\'; exit 0 ;;',
      '      cut) git "$@" | head -c -1; exit 0 ;;',
      '      single) git "$@" | sed \'1s/ [0-9]*$/ 268435457/\'; exit 0 ;;',
      '      total) git "$@" | sed \'s/ [0-9]*$/ 268435456/\'; exit 0 ;;',
      '    esac ;;',
      "  *'%(objecttype)')",
      '    case "$FLEET_TEST_GIT_MODE" in',
      '      drop) git "$@" | sed \'$d\'; exit 0 ;;',
      '      cut) git "$@" | head -c -1; exit 0 ;;',
      '      garbage) git "$@" | sed \'1s/ .*/ bogus/\'; exit 0 ;;',
      '      fail) cat >/dev/null; echo boom >&2; exit 3 ;;',
      '      kill) cat >/dev/null; kill -9 $$ ;;',
      '    esac ;;',
      'esac',
      'exec git "$@"',
      '',
    ].join('\n'),
  );
  chmodSync(wrapper, 0o755);
  git(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'base.txt'), 'base\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '-m', 'base']);
  // 旧 commit/tree/blob 仅被普通 reflog 指着；bulk 场景也必须真实恢复它们。
  writeFileSync(join(repo, 'base.txt'), 'amended\n');
  git(repo, ['add', '.']);
  git(repo, ['commit', '-q', '--amend', '-m', 'amended']);
  git(repo, ['tag', '-a', 'v1', '-m', 'annotated']);
  // 不检出的旁支放足够多的 blob，凑出多批；工作树保持很小。
  const lines: string[] = [];
  for (let i = 1; i <= BULK; i += 1) {
    const data = `bulk ${i}\n`;
    lines.push('blob', `mark :${i}`, `data ${Buffer.byteLength(data)}`, data);
  }
  lines.push('commit refs/heads/bulk', `mark :${BULK + 1}`, 'committer t <fleet-test@localhost> 0 +0000');
  lines.push('data 5', 'bulk', 'from refs/heads/main');
  for (let i = 1; i <= BULK; i += 1) lines.push(`M 100644 :${i} d${i % 7}/f${i}.txt`);
  lines.push('');
  git(repo, ['fast-import', '--quiet'], lines.join('\n'));
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n');
  const stray = git(repo, ['hash-object', '-w', '--stdin'], 'source stray\n').toString('utf8').trim();
  const captured = snap('capture', undefined);
  if (captured.status !== 0) throw new Error(`capture 失败：${captured.stderr}`);
  frame = captured.stdout;
  const json = parseFrame(frame).find(([name]) => name === 'JSON');
  if (!json) throw new Error('帧缺 JSON');
  state = JSON.parse(json[1].toString('utf8'));
  expect(state.objects.some((obj) => obj.sha === stray)).toBe(false);
  expect(captured.calls.some((call) => PHYSICAL_CHECK.test(call))).toBe(false);
}, 0);

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('复杂快照恢复的批量对象核对', { timeout: 0 }, () => {
  it('多批真实对象全部核对通过，cat-file 按批起进程而不是逐对象', () => {
    const types = new Set(state.objects.map((obj) => obj.type));
    expect([...types].sort()).toEqual(['blob', 'commit', 'tag', 'tree']);
    expect(state.objects.length).toBeGreaterThan(BATCH);
    const result = snap('verify', frame);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    const restored = JSON.parse(result.stdout.toString('utf8')) as SnapState;
    expect(restored.objects).toEqual(state.objects);
    const batches = Math.ceil(state.objects.length / BATCH);
    expect(result.calls.filter((call) => RESTORE_CHECK.test(call))).toHaveLength(2 * batches);
    expect(result.calls.filter((call) => PHYSICAL_CHECK.test(call))).toHaveLength(1);
    expect(result.calls.filter((call) => /cat-file -t /.test(call))).toEqual([]);
    expect(result.calls.length).toBeLessThan(100);
    expect(result.calls.length).toBeLessThan(state.objects.length / 10);
  });

  it('恢复仓额外物理 blob 被实际枚举，不拿声明裁剪（不假设 fetch 导入 BUNDLE 冗余对象）', () => {
    const stray = git(repo, ['hash-object', '-w', '--stdin'], 'bundle-only stray\n').toString('utf8').trim();
    const path = join(root, 'extra.pack');
    writeFileSync(path, git(repo, ['pack-objects', '--stdout'], `${stray}\n`));
    // 真实 Git 同 refs 的 fetch 可能根本不读冗余 PACK。只在新恢复仓导入真实额外对象，独证末次枚举。
    const result = snap('verify', frame, { FLEET_TEST_EXTRA_PACK: path });
    expect(result.status).toBe(0);
    const restored = JSON.parse(result.stdout.toString('utf8')) as SnapState;
    expect(restored.objects).toContainEqual({ sha: stray, type: 'blob' });
    expect(restored.objects).toHaveLength(state.objects.length + 1);
    expect(restored.objects).not.toEqual(state.objects);
  });

  it.each([
    ['empty', /物理对象枚举输出为空或截断/],
    ['cut', /物理对象枚举输出为空或截断/],
    ['invalid', /物理对象枚举输出认不出/],
    ['blank', /物理对象枚举输出认不出/],
    ['duplicate', /物理对象枚举重复/],
    ['limit', /恢复物理对象太多/],
    ['buffer', /git cat-file：.*ENOBUFS/],
    ['fail', /git cat-file：退出码 3（boom）/],
    ['kill', /git cat-file：退出码 null/],
  ])('物理对象枚举%s时明确失败', (mode, error) => {
    const result = snap('verify', frame, { FLEET_TEST_PHYSICAL_MODE: mode });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(error);
    expect(result.stdout.length).toBe(0);
  });

  it('物理对象枚举乱序时仍按实际 oid 排序', () => {
    const result = snap('verify', frame, { FLEET_TEST_PHYSICAL_MODE: 'reverse' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.toString('utf8')).objects).toEqual(state.objects);
  });

  it.each([
    ['identity', /对象闭包核对输出认不出/],
    ['type', /对象闭包核对输出认不出/],
    ['cut', /对象闭包核对输出截断/],
    ['single', /对象解压预算越界/],
    ['total', /对象解压预算越界/],
  ])('恢复实际对象的类型/大小读取%s时拒绝', (mode, error) => {
    const result = snap('verify', frame, { FLEET_TEST_SIZE_MODE: mode });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(error);
    expect(result.stdout.length).toBe(0);
    expect(result.calls.filter((call) => PHYSICAL_CHECK.test(call))).toHaveLength(1);
  });

  it('PACK 缺对象时 BUNDLE 导入前就拒绝，不能靠成果包补', () => {
    // index-pack --strict 自己会拦下被树指着的缺口；附注标签只被引用指着，只有这一段核对拦得住。
    const victim = state.objects[byType('tag')];
    if (!victim) throw new Error('夹具缺附注标签');
    const stray = git(repo, ['hash-object', '-w', '--stdin'], 'stray\n').toString('utf8').trim();
    const list = state.objects.filter((obj) => obj.sha !== victim.sha).map((obj) => obj.sha);
    const pack = git(repo, ['pack-objects', '--stdout'], `${[...list, stray].join('\n')}\n`);
    const result = snap('verify', replace('PACK', pack));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`对象包缺 ${victim.sha}，不能靠成果包补`);
    expect(result.calls.some((call) => call.includes('fetch'))).toBe(false);
  });

  it('声明的类型不对、对象号换成不存在的、重复对象号都在恢复段拒绝', () => {
    const second = byType('blob', BATCH);
    const wrongType = state.objects.map((obj, i) => (i === second ? { ...obj, type: 'tree' } : obj));
    const typed = snap('verify', withObjects(wrongType));
    expect(typed.status).not.toBe(0);
    expect(typed.stderr).toContain(`对象包里的 ${state.objects[second]?.sha} 应是 tree，实际 blob`);

    const tag = byType('tag');
    const fake = 'f'.repeat(40);
    expect(state.objects.some((obj) => obj.sha === fake)).toBe(false);
    const missing = state.objects.map((obj, i) => (i === tag ? { sha: fake, type: 'tag' } : obj));
    const gone = snap('verify', withObjects(missing));
    expect(gone.status).not.toBe(0);
    expect(gone.stderr).toContain(`对象包缺 ${fake}，不能靠成果包补`);

    const dup = state.objects.map((obj, i) => (i === 1 ? (state.objects[0] as SnapObject) : obj));
    const doubled = snap('verify', withObjects(dup));
    expect(doubled.status).not.toBe(0);
    expect(doubled.stderr).toContain('恢复对象声明重复');
  });

  it.each([
    ['drop', /批量核对行数对不上/],
    ['cut', /批量核对输出截断/],
    ['garbage', /批量核对输出认不出/],
    ['fail', /git cat-file：退出码 3（boom）/],
    ['kill', /git cat-file：退出码 null/],
  ])('批量核对输出%s时明确失败，不当成通过', (mode, error) => {
    const result = snap('verify', frame, { FLEET_TEST_GIT_MODE: mode });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(error);
    expect(result.stdout.length).toBe(0);
    expect(result.calls.some((call) => call.includes('bundle verify'))).toBe(false);
  });

  it('基准：同一隔离仓 256 个对象逐个 cat-file -t 与一次 batch-check 结果逐项相同（只报告耗时）', () => {
    const sample = state.objects.slice(0, 256);
    const started = performance.now();
    const single = sample.map(
      (obj) => `${obj.sha} ${git(repo, ['cat-file', '-t', obj.sha]).toString('utf8').trim()}`,
    );
    const singleMs = performance.now() - started;
    const batchStarted = performance.now();
    const batch = git(
      repo,
      ['cat-file', '--buffer', '--batch-check=%(objectname) %(objecttype)'],
      `${sample.map((obj) => obj.sha).join('\n')}\n`,
    )
      .toString('utf8')
      .trim()
      .split('\n');
    const batchMs = performance.now() - batchStarted;
    expect(batch).toEqual(single);
    expect(single).toEqual(sample.map((obj) => `${obj.sha} ${obj.type}`));
    const version = git(repo, ['--version']).toString('utf8').trim();
    console.log(
      `[bench] ${process.platform}/${process.arch} ${version} node ${process.version}：` +
        `${sample.length} 个对象逐个 ${singleMs.toFixed(1)}ms，批量一次 ${batchMs.toFixed(1)}ms`,
    );
  });
});
