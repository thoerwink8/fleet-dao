// #1445：健康条、决定卡、定时任务、渠道状态、更新日志这五处的任意尺寸，
// 已由 #1446（#1555）收成同像素 token。整份 src 的 0 处扫描盖得住「没有写死值」，
// 盖不住「换上去的 token 类名还在」。这里按当时那 12 处钉住类名，并钉住 app.css 里
// 对应档位的注释还在（依据不能被删成没说明的数字）。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { scanFile } from '../../scripts/lint-arbitrary.ts';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 五个文件。路径相对 packages/web/src。 */
const FILES = [
  'components/home/health-strip.tsx',
  'components/home/decision-card.tsx',
  'routes/schedules.tsx',
  'routes/routing-status.tsx',
  'routes/changelog.tsx',
] as const;

/**
 * 12 处写死值换上的 token 类名，用换完后的那一段类名钉住（出现多次的只钉那一处的上下文）。
 * health-strip 2、decision-card 2、schedules 4、routing-status 3、changelog 1。
 */
const SPOTS: { file: (typeof FILES)[number]; snippet: string }[] = [
  { file: 'components/home/health-strip.tsx', snippet: 'max-w-health-detail' },
  { file: 'components/home/health-strip.tsx', snippet: 'max-w-health-detail truncate text-caption' },
  {
    file: 'components/home/decision-card.tsx',
    snippet: 'text-caption font-medium uppercase tracking-wide text-ink-human',
  },
  {
    file: 'components/home/decision-card.tsx',
    snippet: 'num shrink-0 whitespace-nowrap text-caption text-muted-foreground',
  },
  { file: 'routes/schedules.tsx', snippet: 'absolute inset-y-0 left-0 w-rail' },
  { file: 'routes/schedules.tsx', snippet: 'text-caption text-muted-foreground' },
  { file: 'routes/schedules.tsx', snippet: 'num text-caption text-faint' },
  { file: 'routes/schedules.tsx', snippet: 'text-caption text-ink-stall' },
  { file: 'routes/routing-status.tsx', snippet: 'xl:max-h-routing-pane' },
  { file: 'routes/routing-status.tsx', snippet: 'text-caption font-medium leading-5 text-ink-run' },
  { file: 'routes/routing-status.tsx', snippet: 'size-2 shrink-0 rounded-2' },
  { file: 'routes/changelog.tsx', snippet: 'grid grid-cols-changelog items-baseline' },
];

/** 这 12 处用到的档位。why 必须出现在定义行往上 8 行里的注释中。 */
const TIERS: { name: string; why: string }[] = [
  { name: '--text-caption:', why: 'caption（辅助信息、时间戳）' },
  { name: '--container-health-detail:', why: '320px' },
  { name: '--width-rail:', why: '3px' },
  { name: '--max-height-routing-pane:', why: '16rem' },
  { name: '--radius-2:', why: '2px' },
  { name: '--grid-template-columns-changelog:', why: '8.5rem' },
];

function source(rel: string): string {
  return readFileSync(join(srcDir, rel), 'utf8');
}

describe('#1445 五文件的尺寸 token', () => {
  test('五个文件 0 处任意尺寸值', () => {
    const hits = FILES.flatMap((rel) => scanFile(join(srcDir, rel), rel));
    expect(hits).toEqual([]);
  });

  test('12 处写死值对应的 token 类名还在', () => {
    expect(SPOTS).toHaveLength(12);
    for (const spot of SPOTS) {
      expect(source(spot.file), `${spot.file} 缺少 ${spot.snippet}`).toContain(spot.snippet);
    }
  });

  test('用到的档位在 app.css 里，且附近注释写了依据', () => {
    const css = source('app.css');
    const lines = css.split('\n');
    for (const tier of TIERS) {
      const i = lines.findIndex((line) => line.includes(tier.name));
      expect(i, tier.name).toBeGreaterThanOrEqual(0);
      const around = lines.slice(Math.max(0, i - 8), i + 1).join('\n');
      expect(around, tier.name).toContain('/*');
      expect(around, `${tier.name} 缺依据`).toContain(tier.why);
    }
  });
});
