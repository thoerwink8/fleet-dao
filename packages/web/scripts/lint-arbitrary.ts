// 扫 packages/web/src 里的 Tailwind 任意尺寸值（#182「没法再写回任意尺寸」）。
// 命中的当出错打出来，退出码 1；全干净退出 0。
// 任意尺寸值 = 类名里带方括号、括号里写的是像素/rem/百分比这类字面量的，例如：
//   text-[13px]  h-[52px]  max-w-[380px]  grid-cols-[240px_1fr]
// 允许：
//   - 引用 CSS 变量的（shadow-[0_1px_0_var(--border)] 这类，尺寸本身是 token）
//   - 写进白名单的（白名单里每行写「正则 + 理由」）
// 例子（命令行）：
//   node scripts/lint-arbitrary.ts           扫一遍，出错退出 1
//   node scripts/lint-arbitrary.ts --list    只列出命中的文件和行，不出错
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(pkgDir, 'src');

// 任意尺寸值：类名一段里 `xxx-[...]` 且括号里出现数字（像素、rem、级联的 grid 列宽等）。
// 类名允许多段前缀（max-w-、grid-cols-、aria-invalid:ring- 这类），只看最后那段 `xxx-[...]` 之后有没有数字。
// 引 var(--...) 的不算（值本身已经是 token）。
// 捕获 1 = 括号里的值，捕获 2 = 完整类名（含可能的 variant 前缀）。
const ARBITRARY = /(?:^|[\s"'])((?:[a-zA-Z][a-zA-Z0-9_-]*:)*[a-zA-Z][a-zA-Z0-9_-]*-\[([^\]]*\d[^\]]*)\])/g;

function hitAllowed(fragment: string): boolean {
  // 比如 shadow-[0_1px_0_var(--border)]：数字只是坐标，尺寸源头是 token。
  return fragment.includes('var(--');
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) yield* walk(path);
    else if (/\.(tsx?|css)$/.test(entry) && !entry.includes('.test.')) yield path;
  }
}

export type Hit = { file: string; line: number; match: string };

export function scanFile(path: string, rel: string): Hit[] {
  const hits: Hit[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    for (const m of line.matchAll(new RegExp(ARBITRARY.source, 'g'))) {
      const cls = m[1];
      const inner = m[2];
      if (!cls || !inner) continue;
      if (hitAllowed(inner)) continue;
      hits.push({ file: rel, line: i + 1, match: cls });
    }
  }
  return hits;
}

export function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of walk(srcDir)) hits.push(...scanFile(path, relative(pkgDir, path)));
  return hits;
}

function main() {
  const listOnly = process.argv.includes('--list');
  const hits = scan();
  for (const h of hits) console.log(`${h.file}:${h.line}  ${h.match}`);
  if (!listOnly && hits.length > 0) {
    console.error(
      `\n发现 ${hits.length} 处 Tailwind 任意尺寸值。请在 app.css 的 @theme 里加 token，再加白名单写理由。`,
    );
    process.exit(1);
  }
  console.log(`扫了 ${srcDir}：${hits.length} 处任意尺寸值。`);
  if (listOnly) return;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
