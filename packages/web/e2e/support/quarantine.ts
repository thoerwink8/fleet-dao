// 隔离集（决定 0093）：常偶发的用例放进 e2e/quarantine.json，照跑、照报，不挡这一轮。
// CI 的 e2e job 跑隔离集以外的（E2E_QUARANTINE=skip，红了这一轮就红）；隔离集（E2E_QUARANTINE=only）由 e2e-quarantine.yml 每天定时单跑，不挡。
// 本机不设 E2E_QUARANTINE，全跑。哪条该进隔离集、开单、限期：packages/conventions/src/e2e-flaky.ts（那边也校验这个文件的格式）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const QUARANTINE_FILE = join(import.meta.dirname, '..', 'quarantine.json');

export interface Quarantined {
  /** spec 文件名（相对 e2e/specs）。 */
  file: string;
  /** 用例标题（不含 describe）。 */
  title: string;
}

export function readQuarantine(text = readFileSync(QUARANTINE_FILE, 'utf8')): Quarantined[] {
  const data = JSON.parse(text) as { tests?: unknown };
  if (!data || !Array.isArray(data.tests)) throw new Error(`${QUARANTINE_FILE} 要是 { "tests": [...] }`);
  return data.tests.map((t, i) => {
    const e = t as Partial<Quarantined>;
    if (typeof e.file !== 'string' || typeof e.title !== 'string' || e.title === '')
      throw new Error(`${QUARANTINE_FILE} 第 ${i + 1} 条要有 file、title`);
    return { file: e.file, title: e.title };
  });
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Playwright 的 grep / grepInvert 拿「项目名 文件路径 describe… 标题」拼成的一整串去匹配，所以按「文件名 … 以标题结尾」写。
 * 隔离集空时回 undefined。
 */
export function quarantineGrep(entries: readonly Quarantined[]): RegExp | undefined {
  if (entries.length === 0) return undefined;
  return new RegExp(entries.map((e) => `${escapeRe(e.file)} .*${escapeRe(e.title)}$`).join('|'));
}

/** E2E_QUARANTINE：skip 跳过隔离集、only 只跑隔离集、不设全跑。给 playwright.config 的 grep / grepInvert。 */
export function quarantineFilter(mode: string | undefined): { grep?: RegExp; grepInvert?: RegExp } {
  const m = mode?.trim() ?? '';
  if (m === '') return {};
  const re = quarantineGrep(readQuarantine());
  if (m === 'skip') return re ? { grepInvert: re } : {};
  // 隔离集空时 only 一条都不该跑：给一个谁都匹配不上的式子（调用方加 --pass-with-no-tests）
  if (m === 'only') return { grep: re ?? /$^/ };
  throw new Error(`E2E_QUARANTINE 只能是 skip 或 only，现在是「${m}」`);
}
