// 工作流文件的规矩，写成检查：
// 1. 判断只经本地活动 decide 调（结果进历史）；工作流文件对 decisions 只许 import type——直接调就把判断搬回了工作流，
//    改判断条件会让在途任务重放对不上（windsurf-dao#1813 的教训反过来）。
// 2. 工作流里不许碰活动、worker、客户端、Node 自带模块：它们不确定，或者根本进不了工作流沙箱。
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('../src/workflows/', import.meta.url));
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts'));

interface ImportLine {
  file: string;
  source: string;
  /** 整条 import 只带类型（运行时什么都不引进来）。 */
  typeOnly: boolean;
  text: string;
}

function importsIn(code: string, file: string): ImportLine[] {
  const out: ImportLine[] = [];
  for (const match of code.matchAll(/^import\s+([\s\S]*?)\s+from\s+'([^']+)';/gm)) {
    const clause = match[1] ?? '';
    const source = match[2] ?? '';
    const braces = clause.match(/\{([\s\S]*)\}/)?.[1];
    const names = (braces ?? '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean);
    const outsideBraces = clause.replace(/\{[\s\S]*\}/, '').trim();
    const typeOnly =
      clause.startsWith('type ') ||
      (names.length > 0 && !outsideBraces && names.every((n) => n.startsWith('type ')));
    out.push({ file, source, typeOnly, text: match[0] });
  }
  return out;
}

const all = files.flatMap((file) => importsIn(readFileSync(`${DIR}${file}`, 'utf8'), file));

describe('工作流文件的规矩', () => {
  it('扫到了工作流文件和它们的 import（不是空扫一遍就算过）', () => {
    expect(files.sort()).toEqual(['index.ts', 'kit.ts', 'merge-queue.ts', 'requirement.ts', 'subtask.ts']);
    expect(all.length).toBeGreaterThan(10);
  });

  it('判断模块只许 import type', () => {
    const offending = all
      .filter((i) => i.source.includes('/decisions/') && !i.typeOnly)
      .map((i) => `${i.file}：${i.text}`);
    expect(offending).toEqual([]);
  });

  it('不碰活动、worker、客户端、假实现和 Node 自带模块', () => {
    const banned =
      /^(node:|@temporalio\/(activity|worker|client|testing)$|\.\.\/(activities|worker|fakes|main)\.ts$)/;
    const offending = all
      .filter((i) => banned.test(i.source) && !i.typeOnly)
      .map((i) => `${i.file}：${i.text}`);
    expect(offending).toEqual([]);
  });

  it('这道检查真能红：混着值的 import 认成运行时引入，纯类型的才放过', () => {
    const [mixed, typeOnly, allTypes] = importsIn(
      [
        "import { pickRunnable, type SchedItem } from '../decisions/plan.ts';",
        "import type { Decide } from '../decisions/index.ts';",
        "import {\n  type A,\n  type B,\n} from '../decisions/verify.ts';",
      ].join('\n'),
      'fake.ts',
    );
    expect([mixed?.typeOnly, typeOnly?.typeOnly, allTypes?.typeOnly]).toEqual([false, true, true]);
  });
});
