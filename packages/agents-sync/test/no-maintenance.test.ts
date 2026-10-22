// 真 bin/bootstrap、真本地 Git 和临时家目录；在进程调用边界截住维护，绝不启动真实维护程序。
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runChild } from './child.ts';
import { cleanup, fakeBin, get, git, gitDir, gitify, makeRepo, pushAhead, put, tempDir } from './helpers.ts';

afterEach(cleanup);

function machine() {
  const repo = makeRepo({ sample: { 'SKILL.md': '# sample\n' } });
  const pkg = join(repo, 'packages', 'agents-sync');
  mkdirSync(pkg, { recursive: true });
  for (const part of ['src', 'bin', 'quiet', 'package.json'])
    cpSync(fileURLToPath(new URL(`../${part}`, import.meta.url)), join(pkg, part), { recursive: true });
  for (const script of ['sync-source.mjs', 'git-run.mjs'])
    cpSync(
      fileURLToPath(new URL(`../../../agents/hooks/${script}`, import.meta.url)),
      join(repo, 'agents', 'hooks', script),
    );
  put(repo, 'package.json', '{"type":"module"}\n');
  put(repo, 'agents/local-sessions/install.mjs', 'throw Error("维护不能真执行");\n');
  const home = tempDir('home');
  put(home, '.mirasim/setting.json', '{broken');
  const trace = join(home, 'maintenance.jsonl');
  const preload = put(
    home,
    'observe-maintenance.mjs',
    `import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const note = (kind) => appendFileSync(${JSON.stringify(trace)}, JSON.stringify(kind)+'\\n');
const kindOf = (args) => {
  const script = String(args?.[0] ?? '').replaceAll('\\\\','/');
  if (script.endsWith('/mirasim-reclaude/bin/migrate')) return 'migrate';
  if (script.endsWith('/local-sessions/install.mjs')) return 'refresh';
  if (script.endsWith('/mirasim-reclaude/bin/health')) return 'health';
  throw Error('测试拒绝未隔离的维护调用');
};
cp.execFileSync = (_command,args) => { note(kindOf(args)); return ''; };
cp.spawn = (_command,args) => {
  note(kindOf(args));
  return {on(){return this;},unref(){}};
};
syncBuiltinESMExports();
`,
  );
  const bin = tempDir('bin');
  fakeBin(bin, 'claude');
  fakeBin(bin, 'codex');
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    PATH: [bin, gitDir()].join(delimiter),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
  };
  for (const key of ['SystemRoot', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'])
    if (process.env[key] !== undefined) env[key] = process.env[key];
  const run = (entry: string, args: string[]) =>
    runChild(process.execPath, [join(pkg, 'bin', entry), ...args], { env, cwd: home });
  const direct = (...args: string[]) => run('agents-sync', [...args, '--home', home, '--repo', repo]);
  const bootstrap = (...args: string[]) => run('agents-sync-now', [...args, '--seed', repo]);
  const calls = (): string[] =>
    existsSync(trace)
      ? readFileSync(trace, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
      : [];
  return { repo, home, direct, bootstrap, calls };
}

describe('无附带维护模式', { timeout: 120_000 }, () => {
  it('真入口仍同步所有目标并读回，三项维护零调用；默认入口仍调用原维护', () => {
    const m = machine();
    const applied = m.direct('--apply', '--no-maintenance');
    expect(applied.status, applied.stderr).toBe(0);
    expect(m.calls()).toEqual([]);
    expect(get(m.home, '.claude/CLAUDE.md')).toContain('## 怎么跟我说话');
    expect(get(m.home, '.agents/skills/sample/SKILL.md')).toBe('# sample\n');
    expect(get(m.home, '.claude/agents/Explore.md')).toContain('name: Explore');
    expect(get(m.home, '.claude/settings.json')).toContain('"defaultMode": "auto"');
    expect(get(m.home, '.codex/hooks.json')).toContain('stop-codex');
    expect(get(m.home, '.codex/config.toml')).toContain('trusted_hash');
    expect(m.direct('--check', '--no-maintenance').status).toBe(0);
    expect(m.calls()).toEqual([]);
    expect(applied.stdout).toContain('仍同步全部目标');
    const defaultApply = m.direct('--apply');
    expect(defaultApply.status, defaultApply.stderr).toBe(0);
    expect(m.calls()).toEqual(process.platform === 'linux' ? ['refresh'] : ['migrate', 'refresh', 'health']);
  });

  it('check/help、无维护模式的坏参数、读源失败和写锁冲突均不执行维护', () => {
    const m = machine();
    expect(m.direct('--check').status).toBe(1);
    expect(m.direct('--apply', '--help').status).toBe(0);
    expect(m.direct('--apply', '--no-maintenance', '--unknown').status).toBe(64);
    expect(m.direct('--retire-old', '--old-repo', m.repo, '--no-maintenance').status).toBe(64);
    put(m.home, '.fleet-dao/agents-sync.lock', `${process.pid} ${new Date().toISOString()}\n`);
    const locked = m.direct('--apply', '--no-maintenance');
    expect(locked.status).toBe(2);
    expect(locked.stdout).toContain('另一个 agents-sync 在写');
    expect(existsSync(join(m.home, '.claude/CLAUDE.md'))).toBe(false);
    expect(m.calls()).toEqual([]);
    const badSource = machine();
    put(badSource.repo, 'agents/shared-rules.md', '没有标记');
    const unreadable = badSource.direct('--apply', '--no-maintenance');
    expect(unreadable.status).toBe(2);
    expect(unreadable.stderr).toContain('标记');
    expect(existsSync(join(badSource.home, '.claude/CLAUDE.md'))).toBe(false);
    expect(badSource.calls()).toEqual([]);
  });

  it('真bootstrap联网取本地main并跨真实子进程透传；check不fetch，取远端失败不apply', () => {
    const m = machine();
    const origin = gitify(m.repo);
    const nextRules = get(m.repo, 'agents/shared-rules.md').replace('说人话', '新主线规矩');
    const tip = pushAhead(origin, 'agents/shared-rules.md', nextRules);
    const applied = m.bootstrap('--no-maintenance');
    expect(applied.status, `${applied.stdout}\n${applied.stderr}`).toBe(0);
    const mirror = join(m.home, '.fleet-dao', 'origin-main');
    expect(git(mirror, 'rev-parse', 'HEAD')).toBe(tip);
    expect(get(m.home, '.claude/CLAUDE.md')).toContain('新主线规矩');
    expect(JSON.parse(get(m.home, '.fleet-dao/synced.json')).synced.commit).toBe(tip);
    expect(m.calls()).toEqual([]);
    git(mirror, 'remote', 'set-url', 'origin', join(tempDir('gone'), 'missing.git'));
    expect(m.bootstrap('--check', '--no-maintenance').status).toBe(0);
    expect(git(mirror, 'rev-parse', 'HEAD')).toBe(tip);
    put(m.home, '.claude/CLAUDE.md', '不能拿缓存改掉此标记\n');
    const failed = m.bootstrap('--no-maintenance');
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('取远端失败');
    expect(failed.stdout).not.toContain('一键同步完成');
    expect(get(m.home, '.claude/CLAUDE.md')).toBe('不能拿缓存改掉此标记\n');
    expect(m.calls()).toEqual([]);
  });

  it('无维护bootstrap也保留源锁；未支持新参数的旧子入口明确失败，不丢参数凑绿', () => {
    const m = machine();
    gitify(m.repo);
    put(m.home, '.fleet-dao/origin-main.lock', `${process.pid} ${new Date().toISOString()}\n`);
    const locked = m.bootstrap('--no-maintenance');
    expect(locked.status).toBe(1);
    expect(locked.stderr).toContain('另一个同步正在做');
    expect(existsSync(join(m.home, '.claude/CLAUDE.md'))).toBe(false);
    expect(m.calls()).toEqual([]);
    const old = machine();
    const oldOrigin = gitify(old.repo);
    pushAhead(
      oldOrigin,
      'packages/agents-sync/bin/agents-sync',
      'if(process.argv.includes("--no-maintenance")){console.error("旧入口不支持参数");process.exitCode=64;}else{process.exitCode=0;}\n',
    );
    const refused = old.bootstrap('--no-maintenance');
    expect(refused.status).not.toBe(0);
    expect(refused.stderr).toContain('旧入口不支持参数');
    expect(refused.stdout).not.toContain('一键同步完成');
    expect(old.calls()).toEqual([]);
  });
});
