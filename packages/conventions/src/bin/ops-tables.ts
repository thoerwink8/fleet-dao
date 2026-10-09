// ops 端口表命令行（#140 第一片，见 ../ops-tables.ts）：
// node packages/conventions/src/bin/ops-tables.ts --check [文档路径]   退出码 0 一致、1 不一致、2 没查成
// node packages/conventions/src/bin/ops-tables.ts --write [文档路径]   把区块标记之间的内容换成生成的；标记缺失退出 2、不写文件
// 文档路径默认 docs/ops.md。本片不接 pnpm check、不接 CI：接线上文档是 #140 后面片的事。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BLOCK_NAME_PORTS,
  checkPortsBlock,
  extractBlock,
  portsTableInner,
  replaceBlock,
} from '../ops-tables.ts';
import { fsRepo } from '../repo.ts';

const USAGE = '用法：ops-tables.ts (--check|--write) [文档路径]（默认 docs/ops.md）';
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
const doc = docPath ?? 'docs/ops.md';

if (mode === 'check') {
  const problems = checkPortsBlock(repo, doc);
  if (problems.length === 0) {
    console.log(`端口表：${doc} 的区块和 deploy/ 一致。`);
    process.exit(0);
  }
  for (const p of problems) console.error(p.text);
  process.exit(problems[0]?.notQueried ? 2 : 1);
}

// --write：只替换标记之间的内容，标记之外一个字不动；标记缺失退出 2、不写文件。
let text: string;
try {
  text = readFileSync(`${root}${doc}`, 'utf8');
} catch {
  console.error(`没查成：读不到 ${doc}。`);
  process.exit(2);
}
let inner: string;
try {
  inner = portsTableInner(repo);
  // 先证明区块在、能取出来：标记缺失或坏了这里会抛，退出 2、不写文件。
  extractBlock(text, BLOCK_NAME_PORTS);
} catch (e) {
  console.error(`没查成：${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
}
const replaced = replaceBlock(text, BLOCK_NAME_PORTS, inner);
if (replaced === text) {
  console.log(`${doc} 的端口区块本来就是最新的，没动。`);
  process.exit(0);
}
writeFileSync(`${root}${doc}`, replaced, 'utf8');
console.log(`写好了：${doc} 的端口区块换成了 deploy/ 生成的。`);
