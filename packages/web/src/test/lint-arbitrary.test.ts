// 任意尺寸 lint（#182）：写死 text-[13px] 这种类名不再让进。
// 扫描脚本在 packages/web/scripts/lint-arbitrary.ts。
// 仓里还在删的页面（soon、demo-links、ui/*）
// 由后面的删除切片带走；本测试盯两块：
//   1) 扫描器本身：造几段假的代码看它是否认得出 / 认得对。
//   2) 留存页面：settings/notifications/audit/quota/shell 这些 0 处写死尺寸。
import { readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { scanFile } from '../../scripts/lint-arbitrary.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const srcDir = join(pkgDir, 'src');

// 留存范围的根：settings 等的 routes 文件 + 共用的 shell、page、quota、not-built 组件 + 我们新加的工具测试。
const KEPT_ROOTS = [
  'routes/settings.tsx',
  'routes/notifications.tsx',
  'routes/audit.tsx',
  'routes/quota.tsx',
  'routes/routing.tsx',
  'routes/efforts.tsx',
  'routes/home.tsx',
  'components/home/board',
  'components/home/running-board.tsx',
  'components/home/running-card.tsx',
  'routes/shell.tsx',
  'routes/task.tsx',
  'components/page.tsx',
  'components/segment-usage.tsx',
  'components/quota.tsx',
  'components/not-built.tsx',
  'components/shell',
];

function* keptFiles(): Generator<string> {
  for (const rel of KEPT_ROOTS) {
    const abs = join(srcDir, rel);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      const walk = function* (dir: string): Generator<string> {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          const s = statSync(p);
          if (s.isDirectory()) yield* walk(p);
          else if (/\.(tsx?|css)$/.test(entry)) yield p;
        }
      };
      yield* walk(abs);
    } else {
      yield abs;
    }
  }
}

describe('lint-arbitrary: 扫描器本身', () => {
  test('扫出写死的 text-[13px]', () => {
    const hits = scanFileVirtual(`<div className="text-[13px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['text-[13px]']);
  });

  test('扫出写死的 max-w-[380px]', () => {
    const hits = scanFileVirtual(`<div className="max-w-[380px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['max-w-[380px]']);
  });

  test('扫出 grid 列写死 240px', () => {
    const hits = scanFileVirtual(`<div className="grid-cols-[240px_1fr]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['grid-cols-[240px_1fr]']);
  });

  test('放行用 CSS 变量的任意值（尺寸源头是 token）', () => {
    const hits = scanFileVirtual(`<div className="shadow-[0_1px_0_var(--border)]">hi</div>`);
    expect(hits).toEqual([]);
  });

  test('对一行里的多个写死值都扫出来', () => {
    const hits = scanFileVirtual(`<div className="text-[11px] leading-4 max-w-[380px]">hi</div>`);
    expect(hits.map((h) => h.match)).toEqual(['text-[11px]', 'max-w-[380px]']);
  });

  test('标准 Tailwind 档位不动（text-sm、h-8 这些不是任意值）', () => {
    const hits = scanFileVirtual(`<div className="text-sm h-8 px-3">hi</div>`);
    expect(hits).toEqual([]);
  });
});

describe('lint-arbitrary: 留存页面 0 处写死尺寸', () => {
  for (const abs of keptFiles()) {
    const rel = relative(pkgDir, abs);
    test(rel, () => {
      expect(scanFile(abs, rel)).toEqual([]);
    });
  }
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// 造一个临时文件喂给 scanFile，不碰仓里的真文件。
function scanFileVirtual(source: string) {
  const dir = mkdtempSync(join(tmpdir(), 'lint-arb-'));
  const path = join(dir, 'sample.tsx');
  writeFileSync(path, source);
  try {
    return scanFile(path, 'sample.tsx');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
