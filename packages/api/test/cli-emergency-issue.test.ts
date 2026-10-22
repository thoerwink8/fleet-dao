// fleet-api emergency-issue（#2728）：法国自动发布在同一个提交发版连败时开急修单。参数不对不连库；正文四节不齐不开；
// 开单贴「缺陷」、key 加 emergency: 前缀、开在受管仓里的 fleet-dao；自动发布拼的急修单正文过得了开单的四节检查。
import type { Repo } from '@fleet-dao/shared';
import { describe, expect, it } from 'vitest';
import { type CliDeps, main } from '../src/cli.ts';
import type { EmergencyIssuePort } from '../src/emergency-issue.ts';
import type { Store } from '../src/ports.ts';

// 仓里 deploy/ 下的文件：路径放变量里动态取（写成字面量 tsc 会把它们拉进本包的工程里查）
const AUTO_RELEASE_LIB = '../../../deploy/france/auto-release/lib.mjs';

const SELF: Repo = {
  id: 'r1',
  owner: 'thoerwink8',
  name: 'fleet-dao',
  defaultBranch: 'main',
  testCommand: '',
};

function setup(opts: { repos?: Repo[]; openFails?: string } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const opened: Parameters<EmergencyIssuePort['openIssue']>[0][] = [];
  let storeOpened = 0;
  const store = { listRepos: async () => opts.repos ?? [SELF] } as unknown as Store;
  const deps = (body: string): CliDeps => ({
    env: { DATABASE_URL: 'postgres:///fleet' },
    out: (t) => out.push(t),
    err: (t) => err.push(t),
    now: () => new Date('2026-10-16T09:00:00Z'),
    readStdin: async () => body,
    openStore: async () => {
      storeOpened += 1;
      return { store, close: async () => {} };
    },
    openEmergencyIssues: async () => ({
      port: {
        async openIssue(input) {
          if (opts.openFails) throw new Error(opts.openFails);
          opened.push(input);
          return { number: 2799, url: 'https://github.com/thoerwink8/fleet-dao/issues/2799', created: true };
        },
      },
      close: async () => {},
    }),
  });
  return { out, err, opened, deps, storeOpened: () => storeOpened };
}

const BODY = [
  '## 场景',
  '',
  '法国自动发版在第 0 步连败 3 趟。',
  '',
  '## 影响',
  '',
  '自动发版停了，创始人要手动发布，被打扰次数上升。',
  '',
  '## 原话',
  '',
  '无（AI 发现）。',
  '',
  '## 已知的模块',
  '',
  '- `deploy/france/release-request/lib.mjs`',
  '',
  '## 怎么算做完',
  '',
  '- 测试里造出同样的失败，改前红、改后绿。',
].join('\n');

describe('fleet-api emergency-issue', () => {
  it('开成了：贴「缺陷」、key 加 emergency:、开在 fleet-dao；--json 打一行结果', async () => {
    const s = setup();
    const code = await main(
      ['emergency-issue', '--key', 'release-untouched:abc', '--title', '急修：x', '--json'],
      s.deps(BODY),
    );
    expect(code).toBe(0);
    expect(s.opened).toEqual([
      {
        repo: { owner: 'thoerwink8', name: 'fleet-dao' },
        key: 'emergency:release-untouched:abc',
        title: '急修：x',
        body: BODY,
        labels: ['缺陷', '域:engine', '性质:bug'],
      },
    ]);
    expect(JSON.parse(s.out.at(-1) ?? '')).toEqual({
      number: 2799,
      url: 'https://github.com/thoerwink8/fleet-dao/issues/2799',
      created: true,
    });
  });

  it('【故意造出的失败】参数不对：退出 2、不连库', async () => {
    for (const argv of [
      [],
      ['--key', 'k'],
      ['--title', 't'],
      ['--key', 'a b', '--title', 't'],
      ['--key', 'k', '--title', 't', '--x'],
    ]) {
      const s = setup();
      expect(await main(['emergency-issue', ...argv], s.deps(BODY))).toBe(2);
      expect(s.storeOpened()).toBe(0);
    }
  });

  it('【故意造出的失败】正文四节不齐、仓认不出、GitHub 没成：退出 1、说清原因，不当成开了', async () => {
    const noDone = setup();
    expect(
      await main(
        ['emergency-issue', '--key', 'k', '--title', 't'],
        noDone.deps(BODY.split('## 怎么算做完')[0] ?? ''),
      ),
    ).toBe(1);
    expect(noDone.opened).toEqual([]);
    expect(noDone.err.join('\n')).toMatch(/急修单正文不合格/);
    const noRepo = setup({ repos: [] });
    expect(await main(['emergency-issue', '--key', 'k', '--title', 't'], noRepo.deps(BODY))).toBe(1);
    expect(noRepo.err.join('\n')).toMatch(/受管的仓里没有 fleet-dao/);
    const down = setup({ openFails: 'GitHub 503' });
    expect(await main(['emergency-issue', '--key', 'k', '--title', 't'], down.deps(BODY))).toBe(1);
    expect(down.err.join('\n')).toMatch(/急修单没开成：GitHub 503/);
  });

  it('【故意造出的失败】急修单正文没写「影响」：退出 1、不开单', async () => {
    const s = setup();
    const body = BODY.replace(/## 影响[\s\S]*?(?=## 原话)/, '');
    expect(await main(['emergency-issue', '--key', 'k', '--title', 't'], s.deps(body))).toBe(1);
    expect(s.opened).toEqual([]);
    expect(s.err.join('\n')).toMatch(/没有「## 影响」一节/);
  });

  it('自动发布拼的急修单正文（deploy/france/auto-release/lib.mjs 的 emergencyIssue）过得了开单的四节检查', async () => {
    const lib = (await import(/* @vite-ignore */ AUTO_RELEASE_LIB)) as {
      emergencyIssue(train: unknown, n: number): { key: string; title: string; body: string };
    };
    const issue = lib.emergencyIssue(
      {
        status: 'failed',
        phase: 0,
        target: { kind: 'sha', value: 'b'.repeat(40) },
        why: "fleet-api alert show 没跑成：Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'zod'",
        untouchedFails: 3,
      },
      3,
    );
    const s = setup();
    expect(
      await main(['emergency-issue', '--key', issue.key, '--title', issue.title], s.deps(issue.body)),
    ).toBe(0);
    expect(s.err).toEqual([]);
    expect(s.opened[0]?.key).toBe(`emergency:release-untouched:${'b'.repeat(40)}`);
  });
});
