// ops 表格命令行（#140 第一片端口、第十一片五个区块一起认，见 ../ops-tables.ts）：
// node packages/conventions/src/bin/ops-tables.ts --check [文档路径]   五个区块依次核对，0 一致、1 不一致、2 没查成
// node packages/conventions/src/bin/ops-tables.ts --write [文档路径]   五个区块标记之间的内容换成生成的；标记缺失退出 2、一个字都不写
// 不给文档路径：区块可以在 docs/ops.md 里，也可以在 docs/ops/*.md 里（第十二片拆文件时区块跟着所在小节搬走），
//   每个区块只许恰好一个文件有它的标记——找不到、或两个文件都有，各报一条点出区块名的问题。
// 给了文档路径：只在这一个文件里找全部五个区块（第一片旧的单文件入口照旧）。
// 本片不接 pnpm check、不接 CI：接线上文档是 #140 后面片的事。
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkOpsBlocks, writeOpsBlocks } from '../ops-tables.ts';
import { fsRepo } from '../repo.ts';

const USAGE =
  '用法：ops-tables.ts (--check|--write) [文档路径]（默认 docs/ops.md 加 docs/ops/*.md 里找五个区块）';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const repo = fsRepo(root);

const args = process.argv.slice(2);
let mode: 'check' | 'write' | undefined;
let docPath: string | undefined;
for (const arg of args) {
  if (arg === '--check' || arg === '--write') {
    if (mode !== undefined) {
      console.error(`参数不对：--check 和 --write 只能给一个。${USAGE}`);
      process.exit(2);
    }
    mode = arg === '--check' ? 'check' : 'write';
  } else if (arg.startsWith('--')) {
    console.error(`参数不对：认不出「${arg}」。${USAGE}`);
    process.exit(2);
  } else if (docPath === undefined) {
    docPath = arg;
  } else {
    console.error(`参数不对：文档路径给了两次（${docPath}、${arg}）。${USAGE}`);
    process.exit(2);
  }
}
if (mode === undefined) {
  console.error(`参数不对：要给 --check 或 --write。${USAGE}`);
  process.exit(2);
}

if (mode === 'check') {
  const problems = checkOpsBlocks(repo, docPath);
  if (problems.length === 0) {
    console.log('五个区块都和 deploy/ 一致。');
    process.exit(0);
  }
  for (const p of problems) console.error(p.text);
  // 有一条没查成（读不到文档、生成不出来）就退出 2：不能把「没查成」当成不一致、更不能当成通过。
  process.exit(problems.some((p) => p.notQueried) ? 2 : 1);
}

// --write：五个区块都只替换标记之间的内容，标记之外一个字不动；有一个区块换不了，一个字都不写。
const { changes, problems } = writeOpsBlocks(repo, docPath);
if (problems.length > 0) {
  for (const p of problems) console.error(p.text);
  console.error('一个字都没写。');
  process.exit(2);
}
if (changes.length === 0) {
  console.log('五个区块本来就是最新的，没动。');
  process.exit(0);
}
for (const c of changes) {
  try {
    writeFileSync(`${root}${c.path}`, c.text, 'utf8');
  } catch (e) {
    console.error(`没查成：写不进 ${c.path}（${e instanceof Error ? e.message : String(e)}）。`);
    process.exit(2);
  }
  console.log(`写好了：${c.path} 的区块换成了 deploy/ 生成的。`);
}
