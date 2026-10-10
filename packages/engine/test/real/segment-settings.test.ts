// 任务工作树里的 .claude/settings.local.json（real/segment-settings.ts，#1641 第 4c 片）：
// 非 Claude 模型挡全部子代理、Claude 模型只挡带 isolation 的；树里已有的文件合并、不覆盖人写的键。
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionUser } from '@fleet-dao/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PortError } from '../../src/ports.ts';
import { localExec } from '../../src/real/exec.ts';
import {
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
