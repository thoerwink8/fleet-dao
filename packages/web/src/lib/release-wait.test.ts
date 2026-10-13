import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { RELEASE_WAIT_MAX_MINUTES } from './release-wait';

const releaseSh = readFileSync(new URL('../../../../deploy/release.sh', import.meta.url), 'utf8');
const seconds = (name: string): number => {
  const m = new RegExp(String.raw`^${name}=(\d+)\b`, 'm').exec(releaseSh);
  if (!m?.[1]) throw new Error(`deploy/release.sh 里没读到 ${name}`);
  return Number(m[1]);
};

describe('发版确认框写的「最多等几分钟」', () => {
  test('等于 release.sh 的宽限 + 收尾 + 余量', () => {
    const total = seconds('DRAIN_GRACE') + seconds('DRAIN_STOP_REPORT') + seconds('DRAIN_SLACK');
    expect(RELEASE_WAIT_MAX_MINUTES * 60).toBe(total);
  });
});
