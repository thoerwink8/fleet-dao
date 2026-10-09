// 任务书草稿的准入检查（决定 0035）：补单交给 Sonnet 或 Haiku 写草稿后，开单前先跑这个。
// 按引擎准入的规矩判：四节齐、「已知的模块」每行都是反引号括起来的路径、不超过 50 个、不跨模块、不碰 agents/（标准路径）、
// 正文不提 .github/workflows/、验收条不写「grep」「CI 绿」「截图」这类 diff 里看不见的、原话原样保留。
// 用法：node check-brief.mjs <任务书文件> [--quote <原话片段>] [--root <仓根>]
// 仓根默认是当前目录（指挥官在主检出根目录跑）；只用来提示哪些路径仓里还没有，不影响判定。
// 最后一行 PASS 或 FAIL <条数>；退出码 0 过、1 不过、2 没法判（文件读不到、参数不对）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTIONS = ['场景', '原话', '已知的模块', '怎么算做完'];
export const MAX_PATHS = 50;
/** 验收条里不许出现的：引擎和冷验收在 diff 里看不见这些（#1150 因「跑 grep 看结果」被打回）。 */
export const BAD_DONE = ['grep', 'CI 绿', '截图'];

/**
 * @typedef {{ problems: string[]; paths: string[]; missing: string[] }} BriefCheck
 */

/** @param {string} text */
function splitSections(text) {
  /** @type {Record<string, string[]>} */
  const sections = {};
  /** @type {string | null} */
  let cur = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^## (.+?)\s*$/.exec(line);
    if (m?.[1]) {
      cur = m[1];
      sections[cur] = [];
      continue;
    }
    if (cur) sections[cur]?.push(line);
  }
  return sections;
}

/** 路径算哪个模块：packages/<包> 算一个，别的取第一段。 @param {string} p */
function moduleOf(p) {
  const pk = /^packages\/[^/]+/.exec(p);
  return pk ? pk[0] : (p.split('/')[0] ?? p);
}

/**
 * 检查一份任务书。纯函数：文件在不在由 exists 判（只用来列提示，不影响过不过）。
 * @param {string} text
 * @param {{ quote?: string; exists?: (path: string) => boolean }} [opts]
 * @returns {BriefCheck}
 */
export function checkBrief(text, opts = {}) {
  const problems = [];
  const sections = splitSections(text);
  for (const h of SECTIONS) if (!sections[h]) problems.push(`缺「## ${h}」`);
  const mods = (sections['已知的模块'] ?? []).filter((l) => l.trim());
  /** @type {string[]} */
  const paths = [];
  for (const l of mods) {
    const ps = [...l.matchAll(/`([^`]+)`/g)].map((x) => x[1] ?? '');
    if (ps.length === 0) problems.push(`已知的模块里有认不出路径的行：${l.slice(0, 40)}`);
    paths.push(...ps);
  }
  if (sections['已知的模块'] && paths.length === 0) problems.push('已知的模块里没有路径');
  if (paths.length > MAX_PATHS) problems.push(`路径 ${paths.length} 个，超过 ${MAX_PATHS}`);
  const modules = new Set(paths.map(moduleOf));
  if (modules.size > 1) problems.push(`跨模块：${[...modules].join(', ')}`);
  if (/\.github\/workflows\//.test(text)) problems.push('正文提到 .github/workflows/');
  const done = (sections['怎么算做完'] ?? []).join('\n');
  for (const bad of BAD_DONE) if (done.includes(bad)) problems.push(`验收条里有「${bad}」`);
  if (paths.some((p) => p.startsWith('agents/'))) problems.push('碰了 agents/（标准路径）');
  const quote = opts.quote ?? '';
  if (quote && !(sections['原话'] ?? []).join('\n').includes(quote)) problems.push('原话没原样保留');
  const exists = opts.exists;
  const missing = exists ? paths.filter((p) => !exists(p.replace(/\/$/, ''))) : [];
  return { problems, paths, missing };
}

/** @param {BriefCheck} r */
export function render(r) {
  const lines = [];
  if (r.missing.length) lines.push(`提示：这些路径仓里不存在（新文件可以）：${r.missing.join(', ')}`);
  lines.push(
    r.problems.length
      ? `FAIL ${r.problems.length}\n- ${r.problems.join('\n- ')}`
      : `PASS（路径 ${r.paths.length} 个）`,
  );
  return lines;
}

const USAGE = '用法：node check-brief.mjs <任务书文件> [--quote <原话片段>] [--root <仓根，默认当前目录>]';

/** @param {string[]} argv */
function main(argv) {
  /** @type {string | undefined} */
  let file;
  let quote = '';
  let root = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quote' || a === '--root') {
      const v = argv[i + 1];
      if (v === undefined) {
        console.error(`${a} 后面要跟值\n${USAGE}`);
        return 2;
      }
      if (a === '--quote') quote = v;
      else root = resolve(v);
      i++;
    } else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else if (file === undefined) file = a;
    else {
      console.error(`多了参数：${a}\n${USAGE}`);
      return 2;
    }
  }
  if (file === undefined) {
    console.error(USAGE);
    return 2;
  }
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`读不到任务书 ${file}：${e instanceof Error ? e.message : String(e)}`);
    console.log('FAIL 1\n- 任务书读不到，没法判');
    return 2;
  }
  const r = checkBrief(text, { quote, exists: (p) => existsSync(resolve(root, p)) });
  console.log(render(r).join('\n'));
  return r.problems.length ? 1 : 0;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
