// 会话目录的落点和属主：路径按仓、分支、需求号拼（放不进目录名的明确拒），属主按 stat 认会话用户，
// 不在回 null、归了别人明确报错（不碰）。
import { mkdtempSync, rmSync, statSync } from 'node:fs';
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
});

describe('会话用户的 uid', () => {
  it('从 passwd 读两个会话用户', () => {
    const passwd = [
      'root:x:0:0:root:/root:/bin/bash',
      'fleet-agent-dedicated:x:1101:1101::/nonexistent:/bin/bash',
      'fleet-agent-carpool:x:1102:1102::/nonexistent:/bin/bash',
    ].join('\n');
    expect([...sessionUserUids(passwd).entries()]).toEqual([
      [1101, 'fleet-agent-dedicated'],
      [1102, 'fleet-agent-carpool'],
    ]);
  });

  it('缺一个会话用户：明确报错（france.sh 没跑过），不当成只有一个', () => {
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
});
