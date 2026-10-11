// 生成主题 CSS：读 src/theme/palettes.ts 的种子，按 WCAG 阈值算校准值，写 src/theme/palettes.generated.css。
// 跑法：pnpm --dir packages/web gen:palettes。改了种子表必须重跑，palettes.test.ts 核对两边一致。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderPalettesCss } from '../src/theme/derive.ts';
import { PALETTE_SEEDS } from '../src/theme/palettes.ts';

const target = fileURLToPath(new URL('../src/theme/palettes.generated.css', import.meta.url));
writeFileSync(target, renderPalettesCss(PALETTE_SEEDS));
console.log(`已写 ${target}（${PALETTE_SEEDS.length} 套）`);
