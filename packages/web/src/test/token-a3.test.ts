// #1445：健康条 2、决定卡 2、定时任务 4、渠道状态 3、更新日志 1，共 12 处任意尺寸。
// 同像素档位在 app.css（#1555 先落过一版）。这里钉住换上的 token 类名还在，
// 原先的方括号写死值不在这几个文件里，并且 app.css 里对应档位的注释写了依据。
// #3533：健康条、决定卡随 /board 的删除（home-drawer）没了，定时任务的行（job-row）和更新日志换成 layout 件、不再写类名，
// 这几处的文件和钉的类名一起去掉；剩下渠道状态 3 处（lg:max-h-routing-pane、lg:grid-cols-routing、探针色点）和 list.tsx 的 w-rail。
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { scanFile } from '../../scripts/lint-design.ts';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 五个文件。路径相对 packages/web/src。 */
const FILES = [
  // #1805：定时任务的展开行并进 layout/list（#1848），类名没变
  'components/layout/list.tsx',
  'routes/routing-status.tsx',
  'routes/changelog.tsx',
  // #1638：渠道状态那处探针色点（size-2 shrink-0 rounded-sm；旧档 rounded-2 在收口片 #1855 删除）随「探测记录」挪进这个组件，类名没变，所以也在这里钉
  'components/probe-log.tsx',
] as const;

/**
 * 12 处写死值换上的 token 类名，用换完后的那一段类名钉住（出现多次的只钉那一处的上下文）。
 * health-strip 2、decision-card 2、schedules 4、routing-status 3、changelog 1。
 */
const SPOTS: { file: (typeof FILES)[number]; snippet: string }[] = [
  { file: 'components/layout/list.tsx', snippet: 'absolute inset-y-0 left-0 w-rail' },
  // 其余点位随文件迁到 layout 层、不再写类名（#3533）：job-row、routing-status、probe-log、changelog。
];

/** 这 12 处用到的档位（健康条等的辅助字原来是 text-caption 11px，收口片 #1855 删了旧字号名，改用 text-meta，见 SPOTS）。why 必须出现在定义行往上 8 行里的注释中。 */
const TIERS: { name: string; why: string }[] = [
  { name: '--container-health-detail:', why: '320px' },
  { name: '--width-rail:', why: '3px' },
  { name: '--max-height-routing-pane:', why: '16rem' },
];

/** 这 12 处换掉之前的写死类名。五个文件里不能再出现。 */
const GONE = [
  'max-w-[320px]',
  'text-[11px]',
  'w-[3px]',
  'xl:max-h-[calc(100dvh-16rem)]',
  'rounded-[2px]',
  'grid-cols-[8.5rem_minmax(0,1fr)_auto]',
  'grid-cols-changelog',
] as const;

function source(rel: string): string {
  return readFileSync(join(srcDir, rel), 'utf8');
}

describe('#1445 五文件的尺寸 token', () => {
  test('五个文件 0 处任意尺寸值', () => {
    const hits = FILES.flatMap((rel) => scanFile(join(srcDir, rel), `src/${rel}`)).filter(
      (h) => h.rule === 'R0',
    );
    expect(hits).toEqual([]);
  });

  test('原先 12 处写死类名不在这五个文件里', () => {
    for (const rel of FILES) {
      const text = source(rel);
      for (const old of GONE) {
        expect(text, `${rel} 还留着 ${old}`).not.toContain(old);
      }
    }
  });

  test('写死值对应的 token 类名还在', () => {
    expect(SPOTS).toHaveLength(1);
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
