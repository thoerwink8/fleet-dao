import {
  createReconciler,
  type GhRequest,
  GitHubClient,
  memoryLedger,
  silentLogger,
} from '@fleet-dao/github';
import { describe, expect, it, vi } from 'vitest';
import { type GitHubReconcileJobDeps, runGitHubReconcileJob } from '../src/jobs/github-reconcile.ts';
import { retainGitHubReconcileWindow } from '../src/jobs/github-reconcile-window.ts';

const START = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function scenario(lastSuccess: Date | null = null) {
  let now = new Date(START);
  let success = lastSuccess;
  const ledger = memoryLedger();
  const posts: string[] = [];
  const windows: string[] = [];
  let pages: number[] = [];
  // 200 页成功记录，只有第 201 页有失败。预算使用真实默认值，不降低为更容易通过的夹具。
  const deliveries = Array.from({ length: 20_000 }, (_, n) => ({
    id: String(30_000 - n),
    guid: `success-${n}`,
    delivered_at: new Date(START - MINUTE - n * 100).toISOString(),
    status_code: 200,
  }));
  deliveries.push({
    id: '1',
    guid: 'must-recover',
    delivered_at: new Date(START - (lastSuccess ? 71 * 60 * MINUTE : 90 * MINUTE)).toISOString(),
    status_code: 502,
  });
  const client = {
    now: () => now,
    pages: GitHubClient.prototype.pages,
    async request(req: GhRequest) {
      if (req.method === 'POST') {
        posts.push(req.path ?? '');
        return { status: 202, data: {}, headers: new Headers() };
      }
      const page = Number(req.url ? new URL(req.url).searchParams.get('page') : (req.query?.page ?? 1));
      pages.push(page);
      const data = deliveries.slice((page - 1) * 100, page * 100);
      const headers = new Headers();
      if (page * 100 < deliveries.length)
        headers.set(
          'link',
          `<https://api.github.test/app/hook/deliveries?per_page=100&page=${page + 1}>; rel="next"`,
        );
      return { status: 200, data, headers };
    },
  } as unknown as GitHubClient;

  function assemble(): GitHubReconcileJobDeps {
    // 每一轮重新装配；只有持久账与成功运行记录跨轮保留，不靠闭包缓存窗口或 reconciler。
    const reconciler = createReconciler(
      { client, ledger, log: silentLogger } as unknown as Parameters<typeof createReconciler>[0],
      {
        intake: { ingest: async () => ({ verdict: 'duplicate' }) },
        pollDeliveryId: () => 'unused',
        storedDeliveries: async () => new Set<string>(),
      },
    );
    return {
      now: () => now,
      lastSuccessAt: async () => success,
      retainWindow: (input) => retainGitHubReconcileWindow(ledger.idempotency, input, () => now),
      log() {},
      runs: {
        start: async () => 1,
        finish: async (_id, result) => {
          if (result.outcome === 'ok') success = now;
        },
      },
      issueGroomDue: () => false,
      issueGroom: async () => ({ scanned: 0, found: 0, unchecked: [] }),
      async reconcile({ since }) {
        windows.push(since.toISOString());
        const report = await reconciler.redeliverFailed(since);
        return { outcome: report.outcome, scanned: 1, found: report.recovered, steps: [], why: report.why };
      },
    };
  }
  return {
    ledger,
    windows,
    posts,
    assemble,
    async run(minutes: number) {
      now = new Date(START + minutes * MINUTE);
      pages = [];
      const result = await runGitHubReconcileJob(assemble());
      return { result, pages: [...pages] };
    },
  };
}

describe('持久对账窗口与真实调度、分页的多轮合同', () => {
  it.each([null, new Date(START - 10 * DAY)])(
    '首次/三天截断（lastSuccess=%s）在重启后接到第 201 页，完成后才换批次',
    async (lastSuccess) => {
      const s = scenario(lastSuccess);
      const first = await s.run(0);
      expect(first.result).toMatchObject({ outcome: 'partial', found: 0 });
      expect(first.pages).toHaveLength(200);
      expect(first.pages.at(-1)).toBe(200);
      // 首次场景等到目标滑出移动的 2 小时窗口；cap 场景保持目标仍在 GitHub 的 3 天保留期内。
      const nextMinute = lastSuccess ? 15 : 150;
      const second = await s.run(nextMinute);
      expect(s.windows[1]).toBe(s.windows[0]);
      expect(second.pages).toEqual([1, 201]);
      expect(second.result).toMatchObject({ outcome: 'ok', found: 1 });
      expect(s.posts).toEqual(['/app/hook/deliveries/1/attempts']);
      const third = await s.run(nextMinute + 15);
      expect(s.windows[2]).toBe(new Date(START + nextMinute * MINUTE).toISOString());
      expect(third.result.outcome).toBe('ok');
      expect(s.posts).toHaveLength(1);
    },
  );

  it('窗口落账失败/in-flight 时不扫描；失败回执也记在本轮', async () => {
    for (const mode of ['read-error', 'write-error', 'in-flight']) {
      const s = scenario();
      const d = s.assemble();
      const reconcile = vi.spyOn(d, 'reconcile');
      const results: unknown[] = [];
      d.runs.finish = async (_id, result) => {
        results.push(result);
      };
      if (mode === 'read-error') {
        s.ledger.idempotency.claim = async () => {
          throw new Error('窗口读库失败');
        };
      } else if (mode === 'write-error') {
        s.ledger.idempotency.complete = async () => {
          throw new Error('窗口写库失败');
        };
      } else {
        await s.ledger.idempotency.claim(
          { key: 'gh:github-reconcile-window:v1:initial', action: 'github.reconcile_window' },
          new Date(START),
        );
      }
      await expect(runGitHubReconcileJob(d)).rejects.toThrow();
      expect(reconcile).not.toHaveBeenCalled();
      expect(results).toEqual([expect.objectContaining({ outcome: 'failed' })]);
      expect(s.posts).toEqual([]);
    }
  });

  it('窗口已落账、扫描中断：新装配仍复用原窗口；未完成状态不换批次', async () => {
    const s = scenario();
    const d = s.assemble();
    d.reconcile = async () => {
      throw new Error('进程中断');
    };
    await expect(runGitHubReconcileJob(d)).rejects.toThrow('进程中断');
    await s.run(150);
    expect(s.windows[0]).toBe(new Date(START - 120 * MINUTE).toISOString());
    const finished = await s.run(165);
    expect(finished.result).toMatchObject({ outcome: 'ok', found: 1 });
  });

  it('成功身份读失败/非法时刻不误用 initial，也不扫描', async () => {
    for (const value of ['error' as const, new Date(0), new Date(Number.NaN), new Date(START + DAY)]) {
      const d = scenario().assemble();
      d.lastSuccessAt = async () => {
        if (value === 'error') throw new Error('成功记录读失败');
        return value;
      };
      const reconcile = vi.spyOn(d, 'reconcile');
      await expect(runGitHubReconcileJob(d)).rejects.toThrow();
      expect(reconcile).not.toHaveBeenCalled();
    }
  });

  it('坏版本/成功身份/时刻回执明确失败，不重新选择窗口', async () => {
    for (const receipt of [
      { since: new Date(START).toISOString(), capped: false },
      { version: 1, identity: 'other', since: new Date(START).toISOString(), capped: false },
      { version: 1, identity: 'initial', since: 'broken', capped: false },
      { version: 1, identity: 'initial', since: new Date(START + DAY).toISOString(), capped: false },
    ]) {
      const s = scenario();
      const key = 'gh:github-reconcile-window:v1:initial';
      await s.ledger.idempotency.claim({ key, action: 'github.reconcile_window' }, new Date(START));
      await s.ledger.idempotency.complete(key, receipt, new Date(START));
      const d = s.assemble();
      const reconcile = vi.spyOn(d, 'reconcile');
      await expect(runGitHubReconcileJob(d)).rejects.toThrow('窗口回执');
      expect(reconcile).not.toHaveBeenCalled();
    }
  });
});
