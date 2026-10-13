// 法国页的刷新说明（#2017）：页头 ⓘ 写的间隔读的就是各块真正用的两个常量，不是另写一份数字。
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { FRANCE_FAST_POLL_MS, FRANCE_REFRESH_NOTE, FRANCE_SLOW_POLL_MS } from '../api/client';

const client = readFileSync(new URL('../api/client.tsx', import.meta.url), 'utf8');
const body = (fn: string) => {
  const i = client.indexOf(`export function ${fn}(`);
  if (i < 0) throw new Error(`没找到 ${fn}`);
  return client.slice(i, client.indexOf('\n}\n', i));
};

test('说明里的秒数等于常量', () => {
  expect(FRANCE_REFRESH_NOTE).toContain(`每 ${FRANCE_FAST_POLL_MS / 1000} 秒`);
  expect(FRANCE_REFRESH_NOTE).toContain(`每 ${FRANCE_SLOW_POLL_MS / 1000} 秒`);
});

test('法国页读的六块各自的重拉间隔，就是说明里归的那一档', () => {
  for (const fn of ['useNodes', 'useJobs', 'useFranceReleaseState'])
    expect(body(fn)).toContain('refetchInterval: FRANCE_FAST_POLL_MS');
  for (const fn of ['useEnv', 'useFranceReleaseCard', 'useCliTools'])
    expect(body(fn)).toContain('refetchInterval: FRANCE_SLOW_POLL_MS');
});
