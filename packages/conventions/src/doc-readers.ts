// 只改文档时本机该跑哪些测试：找出「源码里写着这份文档的路径」的测试文件（test-changed.ts 用）。
// 为什么有这个文件：ci-plan.ts 的 PATH_RULES 把 docs/、specs/、README.md 判成「不测任何包」，本机 test:changed 于是只剩 CI 每个 PR
// 都跑的那份 ALWAYS_TESTS——其中 agents/test/ 是整个目录（30 个测试文件、一千多条测试，一百秒上下），可真正读 docs/ 下文件的只有
// 个位数。CI 里那份并行跑、不占墙钟，本机几个会话抢着跑就是时间。
// 改这里之前必须知道：
// - 判法是「测试源码里出现这份文档的路径（或它上面带斜杠的目录，如 docs/archive）」，也认 join(ROOT, 'docs', 'PROGRESS.md') 这种
//   一段一段写的；多选不要紧（只是多跑一条），漏选才要紧，所以宁可宽：测试里当夹具提到路径的也会被选上。
// - 认不出的写法（拼出来的路径、整目录遍历）这里选不到：doc-pointers.test.ts 读全部文档、每次都跑，兜住「整目录读」那一种；
//   新加的读法选不到时，加一条能被上面两种写法认出来的字面量，或在 test-changed.test.ts 的金丝雀里补一条。
// - 读不出测试清单、读不出某个测试文件，返回一句为什么，调用方退回 CI 每次都跑的整份（不拿空清单冒充「没有读它的测试」）。
import type { RepoView } from './repo.ts';
import { listTestFiles } from './test-split.ts';

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一份改动的文档，在测试源码里可能出现的几种写法：整条路径、上面带斜杠的目录、一段一段写的 join 形式。 */
export function docNeedles(doc: string): RegExp[] {
  const parts = doc.split('/').filter((p) => p !== '');
  const out: string[] = [];
  const quote = String.raw`['"\x60]`;
  // 仓根下的单个文件（README.md）：'README.md' 这个词到处当夹具、当别的目录里的 README 用（实测 25 个测试文件），按字面选等于全选。
  // 只认明确指向仓根的写法：'../README.md'、join(ROOT / REPO …, 'README.md')；别的写法读它的由 doc-pointers（读全部文档，每次都跑）兜。
  if (parts.length === 1) {
    const f = escapeRe(parts[0] as string);
    return [
      new RegExp(String.raw`\.\./${f}`),
      new RegExp(String.raw`\b(?:ROOT|REPO)\w*[^\n]{0,40}${quote}${f}${quote}`),
    ];
  }
  // 从整条路径到最浅的带斜杠目录（docs/archive/x.md → docs/archive/x.md、docs/archive）
  for (let n = parts.length; n >= 2; n--) {
    const head = parts.slice(0, n);
    out.push(escapeRe(head.join('/')));
    if (head.length > 1) out.push(head.map(escapeRe).join(`${quote}\\s*,\\s*${quote}`));
  }
  return out.map((p) => new RegExp(p));
}

/**
 * 读了这些文档的测试文件（仓内相对路径，排好序）。列不出测试文件、读不到某个测试文件时返回一句为什么。
 * 不含 doc-pointers.test.ts 这种每次都跑的：调用方自己带。
 */
export function docReaders(repo: RepoView, docs: readonly string[]): string[] | string {
  const files = listTestFiles(repo);
  if (typeof files === 'string') return `列不出测试文件：${files}`;
  const needles = docs.flatMap(docNeedles);
  const hit: string[] = [];
  for (const f of files) {
    const text = repo.read(f);
    if (text === undefined) return `读不到测试文件 ${f}（认不出它读不读这些文档）`;
    if (needles.some((re) => re.test(text))) hit.push(f);
  }
  return hit.sort();
}
