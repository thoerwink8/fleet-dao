// 任务工作树里的 .claude/settings.local.json（real/segment-settings.ts，#1641 第 4c 片）：
// 非 Claude 模型挡全部子代理、Claude 模型只挡带 isolation 的；树里已有的文件合并、不覆盖人写的键。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SessionUser, SUBAGENTS_DIR } from '@fleet-dao/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import {
  checkSubagentsInstalled,
  denyRules,
  isClaudeModel,
  LOCAL_SETTINGS_PATH,
  mergeLocalSettings,
  writeSegmentLocalSettings,
} from '../../src/real/segment-settings.ts';
import type { UserTree } from '../../src/real/user-git.ts';

const GUARD = {
  names: ['fleet-builder', 'fleet-scout', 'fleet-ui-builder'],
  isolated: ['fleet-builder', 'fleet-ui-builder'],
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fleet-segment-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tree = (): UserTree => ({
  exec: localExec(),
  user: 'fleet-agent-carpool' as SessionUser,
  dir,
  scopePrefix: 'test-settings',
  git: 'git',
  sh: 'sh',
});
const file = () => join(dir, LOCAL_SETTINGS_PATH);
const written = () => JSON.parse(readFileSync(file(), 'utf8')) as Record<string, unknown>;

describe('denyRules', () => {
  it('Claude 模型：只挡带 isolation 的；非 Claude 的模型（deepseek-flash）：挡全部 fleet-*', () => {
    expect(denyRules(GUARD, 'claude-sonnet-5-5')).toEqual([
      'Agent(fleet-builder)',
      'Agent(fleet-ui-builder)',
    ]);
    expect(denyRules(GUARD, 'claude-opus-5-5[1m]')).toEqual([
      'Agent(fleet-builder)',
      'Agent(fleet-ui-builder)',
    ]);
    expect(denyRules(GUARD, 'deepseek-flash')).toEqual([
      'Agent(fleet-builder)',
      'Agent(fleet-scout)',
      'Agent(fleet-ui-builder)',
    ]);
    expect(isClaudeModel('deepseek-flash')).toBe(false);
    expect(isClaudeModel('claude-haiku-5-5')).toBe(true);
  });
});

describe('mergeLocalSettings', () => {
  it('没有已有内容：env 带并发上限 2，deny 是传进来的', () => {
    expect(mergeLocalSettings(undefined, ['Agent(fleet-a)'])).toEqual({
      env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2' },
      permissions: { deny: ['Agent(fleet-a)'] },
    });
  });

  it('已有内容：认不出的键原样留着，人写的同名 env 不被盖掉，deny 取并集不重复', () => {
    const merged = mergeLocalSettings(
      {
        model: 'x',
        env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5', FOO: '1' },
        permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)', 'Agent(fleet-a)'] },
      },
      ['Agent(fleet-a)', 'Agent(fleet-b)'],
    );
    expect(merged).toEqual({
      model: 'x',
      env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '5', FOO: '1' },
      permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)', 'Agent(fleet-a)', 'Agent(fleet-b)'] },
    });
  });

  it('【故意造出的失败】已有内容形状不对（顶层是数组、deny 不是数组）：抛错，不覆盖', () => {
    expect(() => mergeLocalSettings([], [])).toThrow('顶层不是对象');
    expect(() => mergeLocalSettings({ permissions: { deny: 'x' } }, [])).toThrow('permissions.deny 不是数组');
    expect(() => mergeLocalSettings({ env: 3 }, [])).toThrow('env 不是对象');
  });
});

describe('writeSegmentLocalSettings（真 shell、临时目录）', () => {
  it('树里没有这个文件：建 .claude/ 并写出 env 和 deny；非 Claude 模型挡全部', async () => {
    await writeSegmentLocalSettings(tree(), GUARD, 'deepseek-flash');
    expect(written()).toEqual({
      env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2' },
      permissions: { deny: ['Agent(fleet-builder)', 'Agent(fleet-scout)', 'Agent(fleet-ui-builder)'] },
    });
  });

  it('Claude 模型：只挡带 isolation 的', async () => {
    await writeSegmentLocalSettings(tree(), GUARD, 'claude-sonnet-5-5');
    expect(written().permissions).toEqual({ deny: ['Agent(fleet-builder)', 'Agent(fleet-ui-builder)'] });
  });

  it('树里已有这个文件：合并，人写的键还在；再写一遍结果不变（幂等）', async () => {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(
      file(),
      JSON.stringify({ permissions: { allow: ['Bash(ls)'], deny: ['Read(.env)'] }, theme: 'dark' }),
    );
    await writeSegmentLocalSettings(tree(), GUARD, 'claude-opus-5-5');
    const once = written();
    expect(once).toEqual({
      theme: 'dark',
      env: { CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '2' },
      permissions: {
        allow: ['Bash(ls)'],
        deny: ['Read(.env)', 'Agent(fleet-builder)', 'Agent(fleet-ui-builder)'],
      },
    });
    await writeSegmentLocalSettings(tree(), GUARD, 'claude-opus-5-5');
    expect(written()).toEqual(once);
  });

  it('【故意造出的失败】已有文件不是合法 JSON：抛 PortError，原文件不动', async () => {
    mkdirSync(join(dir, '.claude'));
    writeFileSync(file(), '{ 不是 json');
    await expect(writeSegmentLocalSettings(tree(), GUARD, 'claude-opus-5-5')).rejects.toBeInstanceOf(
      PortError,
    );
    expect(readFileSync(file(), 'utf8')).toBe('{ 不是 json');
  });

  it('【故意造出的失败】树的目录不在：抛 PortError，不留文件', async () => {
    const t = { ...tree(), dir: join(dir, '不在') };
    await expect(writeSegmentLocalSettings(t, GUARD, 'claude-opus-5-5')).rejects.toBeInstanceOf(Error);
    expect(existsSync(join(dir, '不在'))).toBe(false);
  });
});

describe('会话用户家里装着的子代理定义和仓里是不是同一份（#2820）', () => {
  const SRC = SUBAGENTS_DIR;
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'fleet-segment-home-'));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });
  const install = (names: string[]) => {
    mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
    for (const n of names)
      writeFileSync(join(home, '.claude', 'agents', n), readFileSync(join(SRC, n), 'utf8'));
  };
  const guard = async () => {
    const { readSubagentGuard } = await import('../../src/real/subagents-file.ts');
    return readSubagentGuard(SRC);
  };

  it('readSubagentGuard 带上仓里的定义（和 claude-code 主机 --agents 用的同一个 loadSubagents）', async () => {
    const g = await guard();
    expect(Object.keys(g.definitions ?? {}).sort()).toEqual([...g.names].sort());
  });

  it('Claude 模型、三份都装着且一样：没有问题（空数组）', async () => {
    install(['Explore.md', 'general-purpose.md', 'Plan.md']);
    await expect(checkSubagentsInstalled(tree(), await guard(), 'claude-opus-5-5', home)).resolves.toEqual(
      [],
    );
  });

  it('Claude 模型、缺一份：一条问题，说清家里没有哪份', async () => {
    install(['Explore.md', 'Plan.md']);
    const problems = await checkSubagentsInstalled(tree(), await guard(), 'claude-opus-5-5', home);
    expect(problems).toHaveLength(1);
    expect(problems?.[0]).toContain('general-purpose');
    expect(problems?.[0]).toContain('家里没有');
  });

  it('Claude 模型、有一份被改过（模型换了）：一条问题，说清哪份和仓里不一样', async () => {
    install(['Explore.md', 'general-purpose.md', 'Plan.md']);
    const p = join(home, '.claude', 'agents', 'Explore.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('claude-haiku-5-5', 'claude-opus-5-5'));
    const problems = await checkSubagentsInstalled(tree(), await guard(), 'claude-sonnet-5-5', home);
    expect(problems).toHaveLength(1);
    expect(problems?.[0]).toContain('Explore');
    expect(problems?.[0]).toContain('不一样');
  });

  it('Claude 模型、有一份解析不了：一条问题', async () => {
    install(['Explore.md', 'general-purpose.md', 'Plan.md']);
    writeFileSync(join(home, '.claude', 'agents', 'Plan.md'), '没有 frontmatter 的文件\n');
    const problems = await checkSubagentsInstalled(tree(), await guard(), 'claude-opus-5-5', home);
    expect(problems).toHaveLength(1);
    expect(problems?.[0]).toContain('Plan');
  });

  it('Claude 模型、有一份读不了（不是没有）、没叫停：一条问题，写明读不了', async () => {
    install(['general-purpose.md', 'Plan.md']);
    const local = localExec();
    const t: UserTree = {
      ...tree(),
      exec: (cmd) =>
        cmd.argv.some((a) => a.includes('Explore.md'))
          ? Promise.resolve({
              code: 2,
              stdout: Buffer.alloc(0),
              stderr: 'Permission denied',
              timedOut: false,
              aborted: false,
            })
          : local(cmd),
    };
    const problems = await checkSubagentsInstalled(t, await guard(), 'claude-opus-5-5', home);
    expect(problems).toHaveLength(1);
    expect(problems?.[0]).toContain('读不了');
    expect(problems?.[0]).toContain('.claude/agents/Explore.md');
  });

  it('Claude 模型、读的时候被叫停（signal 已经 aborted）：原样抛出，不吞成问题', async () => {
    const ac = new AbortController();
    ac.abort();
    const t: UserTree = {
      ...tree(),
      signal: ac.signal,
      exec: async () => ({
        code: null,
        stdout: Buffer.alloc(0),
        stderr: '',
        timedOut: false,
        aborted: true,
      }),
    };
    const err = await checkSubagentsInstalled(t, await guard(), 'claude-opus-5-5', home).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PortError);
  });

  it('非 Claude 模型：不查（全部子代理本来就挡掉了），返回 null，家里什么都没有也一样', async () => {
    await expect(checkSubagentsInstalled(tree(), await guard(), 'deepseek-flash', home)).resolves.toBeNull();
  });

  it('清单里没带定义（老调用方、测试）：不查，返回 null', async () => {
    await expect(checkSubagentsInstalled(tree(), GUARD, 'claude-opus-5-5', home)).resolves.toBeNull();
  });
});
