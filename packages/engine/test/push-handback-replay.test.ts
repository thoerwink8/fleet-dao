import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { historyToJSON } from '@temporalio/common/lib/proto-utils.js';
import { type History, Worker } from '@temporalio/worker';
import { beforeAll, describe, expect, it } from 'vitest';
import { engineBundle } from './support.ts';

const directory = fileURLToPath(new URL('./replay/permission-handback-v2/', import.meta.url));
// 原 SDK History.toJSON 字节固定保留；只在内存按 SDK 转成正式 ProtoJSON 再 replay。
const fixtures = [
  {
    file: 'old-h0-permission-park.history',
    sha256: '1104698d75db6c935558093afe6dbe517a6202b7bd33143ec0b19bb8de7b1a87',
    events: 159,
    scenario: '旧版 H0 首次权限停点，在候选和 Update 之前',
  },
  {
    file: 'accepted-pending-round.history',
    sha256: '203878348dfb2b6bfb8e5af790b34a178316353154c358b987765f74701da0ae',
    events: 181,
    scenario: '原运行已接纳 H1，统计活动未收场、替换 worker 之前',
  },
] as const;

let bundle: Awaited<ReturnType<typeof engineBundle>>;
beforeAll(async () => {
  bundle = await engineBundle();
}, 120_000);

describe('原权限停点与接纳待收场历史不改字节重放', { timeout: 60_000 }, () => {
  for (const fixture of fixtures) {
    it(fixture.scenario, async () => {
      const bytes = readFileSync(`${directory}/${fixture.file}`);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(fixture.sha256);
      const original = JSON.parse(bytes.toString('utf8')) as History;
      expect(original.events).toHaveLength(fixture.events);
      await Worker.runReplayHistory({ workflowBundle: bundle }, JSON.parse(historyToJSON(original)));
    });
  }
});
