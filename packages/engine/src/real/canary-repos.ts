// 各环境期望里写的巡检仓（#1136）。引擎拉单时拿来跟自己的 FLEET_CANARY_REPO 比：对得上的是自己的，其余是别人的，不收。
// 期望文件在发布目录的 deploy/<环境>/desired-config.json。读不到、认不出回 error，调用方不许拿空名单顶（那会把别人的单拉进来）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeCanarySlug } from '../jobs/canary-scope.ts';

/** 这份代码所在的仓的 deploy/（发布目录里和开发检出里都是这一层）。 */
export const DECLARED_CANARY_DEPLOY_DIR = fileURLToPath(new URL('../../../../deploy', import.meta.url));

export type DeclaredCanaryRepos = { slugs: string[] } | { error: string };

/** 一份期望里的 FLEET_CANARY_REPO。没写、空着 = 这台不开巡检（slug null）。写成私有值、认不出是 error。 */
export function canarySlugFromDesired(
  raw: unknown,
  file: string,
): { slug: string | null } | { error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { error: `${file} 认不出：整份要是一个对象` };
  }
  const files = (raw as { files?: unknown }).files;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return { error: `${file} 认不出：没有 files` };
  }
  const engine = (files as { 'engine.env'?: unknown })['engine.env'];
  if (engine === undefined) return { slug: null };
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    return { error: `${file} 的 engine.env 认不出` };
  }
  const engineRec = engine as { FLEET_CANARY_REPO?: unknown };
  if (!Object.hasOwn(engineRec, 'FLEET_CANARY_REPO')) return { slug: null };
  const spec = engineRec.FLEET_CANARY_REPO;
  if (typeof spec === 'string') return slugOf(spec, file);
  if (typeof spec !== 'object' || spec === null || Array.isArray(spec)) {
    return { error: `${file} 的 FLEET_CANARY_REPO 认不出` };
  }
  const specRec = spec as { value?: unknown; private?: unknown };
  const hasValue = Object.hasOwn(specRec, 'value');
  const hasPrivate = Object.hasOwn(specRec, 'private');
  if (hasValue && hasPrivate) {
    return { error: `${file} 的 FLEET_CANARY_REPO 又写了 value 又写了 private` };
  }
  if (hasPrivate) {
    return { error: `${file} 的 FLEET_CANARY_REPO 写成了私有值：比不出是哪个巡检仓（#1136）` };
  }
  if (!hasValue || typeof specRec.value !== 'string') {
    return { error: `${file} 的 FLEET_CANARY_REPO 没有公开的值` };
  }
  return slugOf(specRec.value, file);
}

function slugOf(value: string, file: string): { slug: string | null } | { error: string } {
  const trimmed = value.trim();
  if (trimmed === '') return { slug: null };
  const slug = normalizeCanarySlug(trimmed);
  if (!slug) return { error: `${file} 的 FLEET_CANARY_REPO「${trimmed}」认不出：要写成 owner/name` };
  // 名单留期望里的原写法（大小写照写）；比对时再收成小写。
  return { slug: trimmed };
}

/** deploy/ 下每份 desired-config.json 里开了巡检的仓。目录读不到、某一份认不出：整份回 error，不回读到一半的名单。 */
export function readDeclaredCanaryRepos(deployDir: string): DeclaredCanaryRepos {
  let names: string[];
  try {
    names = readdirSync(deployDir);
  } catch (err) {
    return {
      error: `读不到各环境的期望目录 ${deployDir}：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const slugs: string[] = [];
  for (const name of names.sort()) {
    const rel = `deploy/${name}/desired-config.json`;
    const path = join(deployDir, name, 'desired-config.json');
    if (!existsSync(path)) continue;
    let text: string;
    try {
      text = readFileSync(path, 'utf8');
    } catch (err) {
      return { error: `读不到 ${rel}：${err instanceof Error ? err.message : String(err)}` };
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return { error: `${rel} 不是 JSON（${err instanceof Error ? err.message : String(err)}）` };
    }
    const got = canarySlugFromDesired(json, rel);
    if ('error' in got) return got;
    if (got.slug) slugs.push(got.slug);
  }
  return { slugs };
}
