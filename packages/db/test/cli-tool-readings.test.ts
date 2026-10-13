// 读数表只存读到的版本和原因，不存「该不该升」。
import { getTableColumns } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { cliToolReadings } from '../src/schema/cli-tool-readings.ts';

describe('cli_tool_readings', () => {
  it('没有落后、状态这种现算的列', () => {
    const names = Object.keys(getTableColumns(cliToolReadings));
    expect(names).toEqual([
      'scope',
      'owner',
      'tool',
      'installedVersion',
      'installedError',
      'latestVersion',
      'latestError',
      'releaseVersions',
      'checkedAt',
    ]);
    expect(names.some((name) => /behind|status|stale/i.test(name))).toBe(false);
  });
});
