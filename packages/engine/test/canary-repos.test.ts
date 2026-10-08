// 再接别的环境的引擎时，巡检仓各写各的（#1136）：期望里声明的仓互不重复，拉单只认自己那一个。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '@fleet-dao/db';
import type { Client } from '@temporalio/client';
import { describe, expect, it } from 'vitest';
import { foreignCanarySlugs } from '../src/jobs/canary-scope.ts';
import { canaryJob } from '../src/real/canary.ts';
import {
  canarySlugFromDesired,
  DECLARED_CANARY_DEPLOY_DIR,
  readDeclaredCanaryRepos,
} from '../src/real/canary-repos.ts';

describe('foreignCanarySlugs', () => {
  it('自己的仓不算别人的；大小写不同仍是同一个仓', () => {
    expect(
      foreignCanarySlugs('thoerwink8/fleet-dao-canary', [
        'thoerwink8/fleet-dao-canary',
        'Thoerwink8/Fleet-Dao-Canary-Other',
      ]),
    ).toEqual(['thoerwink8/fleet-dao-canary-other']);
  });

  it('自己没配、认不出：不猜哪一个是别人的（回空，免得把该拉的仓跳过）', () => {
    expect(foreignCanarySlugs(undefined, ['thoerwink8/fleet-dao-canary'])).toEqual([]);
    expect(foreignCanarySlugs('不是仓', ['thoerwink8/fleet-dao-canary'])).toEqual([]);
  });

  it('空着、重复的声明只留一个', () => {
    expect(foreignCanarySlugs('acme/mine', ['', 'acme/theirs', 'Acme/Theirs', 'not a slug'])).toEqual([
      'acme/theirs',
    ]);
  });
});

describe('期望里的巡检仓', () => {
  it('仓里现在只有法国这一份，值是 thoerwink8/fleet-dao-canary', () => {
    const got = readDeclaredCanaryRepos(DECLARED_CANARY_DEPLOY_DIR);
    expect(got).toEqual({ slugs: ['thoerwink8/fleet-dao-canary'] });
    expect(foreignCanarySlugs('thoerwink8/fleet-dao-canary', 'slugs' in got ? got.slugs : [])).toEqual([]);
  });

  it('第二台写在自己的期望里：读得出来；私有值、认不出、不是 JSON 都明说，不当成没有', () => {
    const root = mkdtempSync(join(tmpdir(), 'canary-repos-'));
    const write = (env: string, spec: unknown) => {
      const dir = join(root, env);
      mkdirSync(dir);
      writeFileSync(
        join(dir, 'desired-config.json'),
        JSON.stringify({ files: { 'engine.env': { FLEET_CANARY_REPO: spec } } }),
      );
    };
    write('other', { value: 'acme/canary-other' });
    write('idle', { value: '' });
    expect(readDeclaredCanaryRepos(root)).toEqual({ slugs: ['acme/canary-other'] });

    const hidden = mkdtempSync(join(tmpdir(), 'canary-repos-'));
    mkdirSync(join(hidden, 'other'));
    writeFileSync(
      join(hidden, 'other', 'desired-config.json'),
      JSON.stringify({ files: { 'engine.env': { FLEET_CANARY_REPO: { private: 'ab'.repeat(32) } } } }),
    );
    const priv = readDeclaredCanaryRepos(hidden);
    expect('error' in priv && priv.error).toContain('私有值');

    const bad = canarySlugFromDesired(
      { files: { 'engine.env': { FLEET_CANARY_REPO: { value: 'no-slash' } } } },
      'deploy/other/desired-config.json',
    );
    expect('error' in bad && bad.error).toContain('认不出');

    const broken = mkdtempSync(join(tmpdir(), 'canary-repos-'));
    mkdirSync(join(broken, 'other'));
    writeFileSync(join(broken, 'other', 'desired-config.json'), '{');
    const json = readDeclaredCanaryRepos(broken);
    expect('error' in json && json.error).toContain('不是 JSON');
  });

  it('目录读不到：明说，不回空名单', () => {
    const got = readDeclaredCanaryRepos(join(tmpdir(), 'no-such-canary-deploy'));
    expect('error' in got && got.error).toContain('读不到');
  });
});

describe('两台引擎开单、关单、关 PR 只打到自己的巡检仓', () => {
  it('GitHub 上看到的仓就是这台 FLEET_CANARY_REPO，不会打到另一台', async () => {
    const calls: string[] = [];
    const gh = {
      claims: {
        openPulls: async (repo: { owner: string; name: string }) => {
          calls.push(`pulls:${repo.owner}/${repo.name}`);
          return [];
        },
        readPull: async () => {
          throw new Error('不该读 PR');
        },
        commentPull: async () => ({ created: true, commentId: 1, url: 'u' }),
        closePull: async () => {},
      },
      readOpenMilestones: async (input: { repo: { owner: string; name: string } }) => {
        calls.push(`milestones:${input.repo.owner}/${input.repo.name}`);
        return [];
      },
      openIssue: async (input: { repo: { owner: string; name: string } }) => {
        calls.push(`open:${input.repo.owner}/${input.repo.name}`);
        return { number: 1, url: 'u', created: true };
      },
      readIssueState: async (input: { repo: { owner: string; name: string } }) => {
        calls.push(`state:${input.repo.owner}/${input.repo.name}`);
        return { state: 'open' as const, stateReason: null };
      },
      closeIssue: async (input: { repo: { owner: string; name: string }; issueNumber: number }) => {
        calls.push(`close:${input.repo.owner}/${input.repo.name}#${input.issueNumber}`);
        return { alreadyClosed: false, commentId: 1, commentUrl: 'u', commentCreated: true };
      },
    };
    const client = { workflow: {} } as Client;
    const engine = (repo: string) => canaryJob({ db: {} as Db, gh, repo, log: () => {} })(client);
    const a = engine('acme/canary-a');
    const b = engine('acme/canary-b');
    await a.github.openMilestones();
    await a.github.openIssue({ title: 't', body: 'b', dedupe: 'k', milestone: 1 });
    await a.github.closeIssue(4, '收掉');
    await a.github.closePulls(4, '收掉');
    await b.github.openIssue({ title: 't', body: 'b', dedupe: 'k', milestone: 1 });
    await b.github.closeIssue(8, '收掉');
    expect(calls.filter((c) => c.includes('canary-a')).sort()).toEqual(
      [
        'close:acme/canary-a#4',
        'milestones:acme/canary-a',
        'open:acme/canary-a',
        'pulls:acme/canary-a',
      ].sort(),
    );
    expect(calls.filter((c) => c.includes('canary-b')).sort()).toEqual(
      ['close:acme/canary-b#8', 'open:acme/canary-b'].sort(),
    );
  });
});
