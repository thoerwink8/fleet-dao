// 判分的小工具：跑夹具里的测试、比文件有没有被改、读回答里的 `文件:行`。
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { REPO_ROOT, UngradableError } from './types.ts';

/** 目录下所有文件（相对路径、正斜杠、排好序）。跳过 node_modules 和 .git。 */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(dir, p).split('\\').join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

export function readText(dir: string, rel: string): string {
  try {
    return readFileSync(join(dir, rel), 'utf8');
  } catch (e) {
    throw new UngradableError(`读不到 ${rel}：${e instanceof Error ? e.message : String(e)}`);
  }
}

export interface TestRun {
  ok: boolean;
  output: string;
}

/** 在目录里跑 `node --test <test/ 下所有 *.test.ts>`。node 起不来或没有测试文件：判不了。 */
export function runNodeTests(dir: string, env: Record<string, string> = {}): TestRun {
  const testDir = join(dir, 'test');
  const files = existsSync(testDir)
    ? listFiles(testDir)
        .filter((f) => f.endsWith('.test.ts'))
        .map((f) => `test/${f}`)
    : [];
  if (files.length === 0) throw new UngradableError(`${dir} 里没有 test/*.test.ts，没法跑测试`);
  const r = spawnSync(process.execPath, ['--test', ...files], {
    cwd: dir,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120_000,
    windowsHide: true,
  });
  if (r.error) throw new UngradableError(`node --test 起不来：${r.error.message}`);
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}`.trim() };
}

/** 夹具原件（orig）和现在的目录（work）逐文件比，列出改了、新增、删了的。 */
export function compareDirs(
  orig: string,
  work: string,
): { changed: string[]; added: string[]; removed: string[] } {
  const a = new Set(listFiles(orig));
  const b = new Set(listFiles(work));
  const changed: string[] = [];
  for (const f of a) {
    if (b.has(f) && readFileSync(join(orig, f), 'utf8') !== readFileSync(join(work, f), 'utf8'))
      changed.push(f);
  }
  return {
    changed,
    added: [...b].filter((f) => !a.has(f)),
    removed: [...a].filter((f) => !b.has(f)),
  };
}

/** 两份文本改了多少行（按行多重集合的对称差，粗算「diff 有多大」）。 */
export function changedLineCount(before: string, after: string): number {
  const count = new Map<string, number>();
  for (const l of before.split('\n')) count.set(l, (count.get(l) ?? 0) + 1);
  for (const l of after.split('\n')) count.set(l, (count.get(l) ?? 0) - 1);
  let n = 0;
  for (const v of count.values()) n += Math.abs(v);
  return n;
}

/** 回答里的 `文件:行`（行后面可以跟 -行 或 :列，只取起始行）。 */
export function refsOf(answer: string): { file: string; line: number; text: string }[] {
  const out: { file: string; line: number; text: string }[] = [];
  for (const text of answer.split('\n')) {
    for (const m of text.matchAll(/([\w@./\\-]+\.[A-Za-z0-9]+):(\d+)/g)) {
      out.push({ file: (m[1] as string).split('\\').join('/'), line: Number(m[2]), text });
    }
  }
  return out;
}

/** 种在 diff 文件里的一处：用正则找到锚点行，认「锚点行往前 before 行、往后 after 行」里的行号。 */
export interface Planted {
  kind: string;
  anchor: RegExp;
  before?: number;
  after?: number;
}

/** 在文本里找锚点行（1 起的行号）；找不到是判分自己出了问题：判不了。 */
export function locate(text: string, p: Planted): { kind: string; from: number; to: number } {
  const idx = text.split('\n').findIndex((l) => p.anchor.test(l));
  if (idx < 0) throw new UngradableError(`题面里找不到种下的「${p.kind}」（锚点 ${String(p.anchor)}）`);
  return { kind: p.kind, from: idx + 1 - (p.before ?? 1), to: idx + 1 + (p.after ?? 1) };
}

/**
 * 判「按 `文件:行` 报问题」的题：回答里引用 `file:N` 的行号，落进某个窗口就算报出了那一处，
 * 不落进任何窗口（种下的和干扰项）的算误报。
 */
export function gradeCitations(
  answer: string,
  file: string,
  diffText: string,
  planted: readonly Planted[],
  decoys: readonly Planted[],
): {
  found: string[];
  missed: string[];
  decoyHits: string[];
  falsePositives: number[];
} {
  const real = planted.map((p) => locate(diffText, p));
  const bait = decoys.map((p) => locate(diffText, p));
  const cited = refsOf(answer)
    .filter((r) => r.file === file || r.file.endsWith(`/${file}`))
    .map((r) => r.line);
  const inWin = (n: number, w: { from: number; to: number }) => n >= w.from && n <= w.to;
  const found = real.filter((w) => cited.some((n) => inWin(n, w))).map((w) => w.kind);
  const decoyHits = bait.filter((w) => cited.some((n) => inWin(n, w))).map((w) => w.kind);
  const falsePositives = [...new Set(cited)].filter((n) => ![...real, ...bait].some((w) => inWin(n, w)));
  return {
    found,
    missed: real.map((w) => w.kind).filter((k) => !found.includes(k)),
    decoyHits,
    falsePositives,
  };
}

/** 把一份隐藏文件（hidden/ 下）拷进目录里的某个相对位置。 */
export function copyHidden(caseDir: string, rel: string, destDir: string, destRel: string = rel): void {
  cpSync(join(caseDir, 'hidden', rel), join(destDir, destRel), { recursive: true });
}

/** 判分里调 check-brief.mjs：退出码 0 = PASS、1 = FAIL、别的 = 判不了。 */
export function runCheckBrief(file: string, quote?: string): { pass: boolean; output: string } {
  const script = join(REPO_ROOT, 'agents', 'skills', 'commander', 'scripts', 'check-brief.mjs');
  const args = [script, file, ...(quote ? ['--quote', quote] : []), '--root', REPO_ROOT];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (r.error) throw new UngradableError(`check-brief.mjs 起不来：${r.error.message}`);
  if (r.status !== 0 && r.status !== 1) {
    throw new UngradableError(
      `check-brief.mjs 退出码 ${String(r.status)}：${(r.stdout + r.stderr).trim().slice(0, 200)}`,
    );
  }
  return { pass: r.status === 0, output: r.stdout.trim() };
}

export function fileExists(dir: string, rel: string): boolean {
  try {
    return statSync(join(dir, rel)).isFile();
  } catch {
    return false;
  }
}
