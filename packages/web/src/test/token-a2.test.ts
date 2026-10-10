// #1444 的 19 处：六个共用件里的写死尺寸换成 token 类名。
// #1446 已经落在主线上。这里把每一处「写死值 → token 类名」钉住，写回去就红。
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { scanFile } from '../../scripts/lint-arbitrary.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 一处写死尺寸和换上的 token 类名。from 是原来的任意值类名，to 是现在的 token 类名。 */
const SITES = [
  { file: 'src/components/usage.tsx', where: '不全标', from: 'text-[10px]', to: 'text-micro' },
  { file: 'src/components/usage.tsx', where: '合计只读到一部分', from: 'text-[11px]', to: 'text-caption' },
  { file: 'src/components/usage.tsx', where: '合计一次都没读到', from: 'text-[11px]', to: 'text-caption' },
  { file: 'src/components/usage.tsx', where: '合计附注', from: 'text-[11px]', to: 'text-caption' },
  {
    file: 'src/components/usage.tsx',
    where: '花费行',
    from: 'grid-cols-[3.5rem_minmax(0,1fr)]',
    to: 'grid-cols-usage',
  },
  { file: 'src/components/usage.tsx', where: '花费明细', from: 'text-[11px]', to: 'text-caption' },
  { file: 'src/components/usage.tsx', where: '分开看', from: 'text-[11px]', to: 'text-caption' },
  { file: 'src/components/usage.tsx', where: '额度提示', from: 'text-[11px]', to: 'text-caption' },
  { file: 'src/components/run-timeline.tsx', where: '时间刻度字号', from: 'text-[10px]', to: 'text-micro' },
  {
    file: 'src/components/run-timeline.tsx',
    where: '刻度左内边距',
    from: 'md:pl-[172px]',
    to: 'md:pl-timeline-label',
  },
  {
    file: 'src/components/run-timeline.tsx',
    where: '两列',
    from: 'md:grid-cols-[160px_1fr]',
    to: 'md:grid-cols-timeline',
  },
  { file: 'src/components/run-timeline.tsx', where: '阶段角标', from: 'text-[10px]', to: 'text-micro' },
  { file: 'src/components/run-timeline.tsx', where: '时长行', from: 'text-[11px]', to: 'text-caption' },
  {
    file: 'src/components/channel-status.tsx',
    where: '故障说明',
    from: 'grid-cols-[auto_1fr]',
    to: 'grid-cols-auto-fr',
  },
  { file: 'src/components/channel-status.tsx', where: '空探针格', from: 'rounded-[2px]', to: 'rounded-2' },
  { file: 'src/components/channel-status.tsx', where: '探针格', from: 'rounded-[2px]', to: 'rounded-2' },
  { file: 'src/components/status.tsx', where: '状态芯片', from: 'text-[11px]', to: 'text-caption' },
  {
    file: 'src/components/release-card.tsx',
    where: '每一行',
    from: 'grid-cols-[4.5rem_minmax(0,1fr)]',
    to: 'grid-cols-release',
  },
  {
    file: 'src/components/pool-holds.tsx',
    where: '暂停明细',
    from: 'grid-cols-[auto_1fr]',
    to: 'grid-cols-auto-fr',
  },
] as const;

const COUNTS: Record<string, number> = {
  'src/components/usage.tsx': 8,
  'src/components/run-timeline.tsx': 5,
  'src/components/channel-status.tsx': 3,
  'src/components/status.tsx': 1,
  'src/components/release-card.tsx': 1,
  'src/components/pool-holds.tsx': 1,
};

describe('token A2：19 处写死尺寸换成 token', () => {
  test('六个组件各对上原来说的处数，加起来 19', () => {
    expect(SITES).toHaveLength(19);
    for (const [file, n] of Object.entries(COUNTS)) {
      expect(SITES.filter((site) => site.file === file)).toHaveLength(n);
    }
  });

  test('组件里不再有这些任意尺寸，类名是 token', () => {
    const files = [...new Set(SITES.map((site) => site.file))];
    for (const file of files) {
      const abs = join(webRoot, file);
      const source = readFileSync(abs, 'utf8');
      expect(scanFile(abs, file), file).toEqual([]);
      for (const site of SITES.filter((item) => item.file === file)) {
        expect(source.includes(site.from), `${file} ${site.where} 还留着 ${site.from}`).toBe(false);
        expect(source.includes(site.to), `${file} ${site.where} 没用 ${site.to}`).toBe(true);
      }
    }
  });
});
