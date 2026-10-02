// segments/{scope,manual,verify}.ts：每一段的入口就是 brief → one-shot → verdict。
// happy path 三段各自跑通；造红时 verdict 必 failed。

import { describe, expect, it } from 'vitest';
import { runManual } from '../../src/segments/manual.ts';
import { runScope } from '../../src/segments/scope.ts';
import { runVerify } from '../../src/segments/verify.ts';
import { fakeDeps } from './helpers.ts';

describe('runScope', () => {
  it('happy path：起一次，拿到整理稿，判 ok', async () => {
    const { deps, calls, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '单子整理稿', stderr: '', killed: false },
    });
    try {
      const { result, verdict } = await runScope(
        {
          brief: {
            kind: 'scope',
            title: 'T',
            request: 'R',
            acceptance: ['A'],
            touches: [],
          },
          modelId: 'm',
          cwd: '/tmp/x',
        },
        deps,
      );
      expect(result.outcome).toBe('done');
      expect(verdict.kind).toBe('ok');
      expect(calls[0]?.stdin).toContain('## 需求');
      expect(recorded[0]?.segment).toBe('scope');
    } finally {
      await cleanup();
    }
  });

  it('造红：exit 0 但 stdout 空 → verdict failed', async () => {
    const { deps, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '  ', stderr: '', killed: false },
    });
    try {
      const { verdict } = await runScope(
        {
          brief: { kind: 'scope', title: 'T', request: 'R', acceptance: ['A'], touches: [] },
          modelId: 'm',
          cwd: '/tmp/x',
        },
        deps,
      );
      expect(verdict.kind).toBe('failed');
    } finally {
      await cleanup();
    }
  });
});

describe('runManual', () => {
  it('happy path 的 one-shot 成功，但 evidence 没齐 → verdict 是 failed（不装证据齐）', async () => {
    const { deps, recorded, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '做完了', stderr: '', killed: false },
    });
    try {
      const { result, verdict } = await runManual(
        {
          brief: {
            kind: 'manual',
            title: 'T',
            request: 'R',
            acceptance: ['A'],
            touches: [],
            branch: 'feat/test',
            baseSha: 'a'.repeat(40),
          },
          modelId: 'm',
          cwd: '/tmp/x',
        },
        deps,
      );
      expect(result.outcome).toBe('done');
      expect(verdict.kind).toBe('failed'); // evidence 缺 PR / changedFiles
      expect(verdict.kind === 'failed' && verdict.reason).toMatch(/PR|changedFiles/);
      expect(recorded[0]?.segment).toBe('manual');
    } finally {
      await cleanup();
    }
  });

  it('造红：进程 exit 1 → verdict failed', async () => {
    const { deps, cleanup } = await fakeDeps({
      scripted: { exitCode: 1, stdout: '', stderr: 'build error', killed: false },
    });
    try {
      const { verdict } = await runManual(
        {
          brief: {
            kind: 'manual',
            title: 'T',
            request: 'R',
            acceptance: ['A'],
            touches: [],
            branch: 'feat/x',
            baseSha: 'a'.repeat(40),
          },
          modelId: 'm',
          cwd: '/tmp/x',
        },
        deps,
      );
      expect(verdict.kind).toBe('failed');
    } finally {
      await cleanup();
    }
  });
});

describe('runVerify', () => {
  it('happy path：拉起、拿结论行（最后一行）→ ok', async () => {
    const { deps, calls, recorded, cleanup } = await fakeDeps({
      scripted: {
        exitCode: 0,
        stdout: '对过单子、查过 diff。\nverdict: pass（没发现能挡的）',
        stderr: '',
        killed: false,
      },
    });
    try {
      const { result, verdict } = await runVerify(
        {
          brief: {
            kind: 'verify',
            title: 'T',
            request: 'R',
            acceptance: ['A'],
            touches: [],
            prNumber: 42,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            changedFiles: ['x.ts'],
            diffText: '@@ diff',
          },
          modelId: 'm',
          cwd: '/tmp/x',
        },
        deps,
      );
      expect(result.outcome).toBe('done');
      expect(verdict.kind).toBe('ok');
      // 喂的 prompt 必带 diff 和「三种能挡」
      expect(calls[0]?.stdin).toContain('```diff');
      expect(calls[0]?.stdin).toContain('@@ diff');
      expect(calls[0]?.stdin).toContain('PR：#42');
      expect(recorded[0]?.segment).toBe('verify');
    } finally {
      await cleanup();
    }
  });

  it('verify 结论行没写 pass / fail → failed（不拿「我看了」当结论）', async () => {
    const { deps, cleanup } = await fakeDeps({
      scripted: { exitCode: 0, stdout: '一切正常', stderr: '', killed: false },
    });
    try {
      const { verdict } = await runVerify(
        {
          brief: {
            kind: 'verify',
            title: 'T',
            request: 'R',
            acceptance: ['A'],
            touches: [],
            prNumber: 42,
            baseSha: 'a'.repeat(40),
            headSha: 'b'.repeat(40),
            changedFiles: ['x.ts'],
            diffText: '@@',
          },
          modelId: 'm',
          cwd: '/tmp/x',
        },
        deps,
      );
      expect(verdict.kind).toBe('failed');
    } finally {
      await cleanup();
    }
  });
});
