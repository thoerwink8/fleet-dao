// --retire-old：撤掉旧仓留在这台机器上的两样东西，每项先备份再动、逐项报出来：
// 1. 各家 skill 目录里指向旧仓的链接（junction 或软链）——只删链接本身，旧仓里的文件一个不碰；
//    不指向旧仓的链接、真目录一律不碰（Mirasim 插件链进来的、claude.ai 同步来的、本脚本装的）。
// 2. ~/.claude/agents 里的两个旧子代理 dao-vps-readback.md、dao-chain-diagnoser.md（dao-scout、dao-fixer 留着）。
import { lstatSync, readdirSync, type Stats, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Backups } from './backup.ts';
import { type Line, line } from './report.ts';
import { type Platform, placeOn, RETIRE_FILES, RETIRE_SKILL_DIRS, slashed } from './targets.ts';
import { isInside, linkTarget, removeEntry } from './tree.ts';

export interface RetireCtx {
  home: string;
  platform: Platform;
  /** 旧仓在这台机器上的位置（绝对路径） */
  oldRepo: string;
}

const code = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? String(err);

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

export function retireOld(ctx: RetireCtx, backups: Backups): Line[] {
  const out: Line[] = [];
  let scanned = 0;
  for (const place of RETIRE_SKILL_DIRS) {
    const rel = placeOn(place, ctx.platform);
    const dir = join(ctx.home, rel);
    const key = `~/${slashed(rel)}`;
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      out.push(line('unknown', key, `没查成——读不了（${code(err)}）`));
      continue;
    }
    scanned++;
    for (const name of names) {
      const p = join(dir, name);
      const k = `${key}/${name}`;
      try {
        if (!lstatSync(p).isSymbolicLink()) continue;
        const target = linkTarget(p);
        if (!isInside(target, ctx.oldRepo, ctx.platform)) continue;
        const record = backups.recordLink({ path: `${slashed(rel)}/${name}`, target });
        removeEntry(p);
        out.push(line('changed', k, `撤掉了（链接 → ${target}；记在 ${record}）`));
      } catch (err) {
        out.push(line('failed', k, `没做成——${code(err)}`));
      }
    }
  }
  for (const place of RETIRE_FILES) {
    const rel = placeOn(place, ctx.platform);
    const abs = join(ctx.home, rel);
    const key = `~/${slashed(rel)}`;
    try {
      const st = lstatOrNull(abs);
      if (st === null) continue;
      if (st.isSymbolicLink()) {
        const target = linkTarget(abs);
        const record = backups.recordLink({ path: slashed(rel), target });
        unlinkSync(abs);
        out.push(line('changed', key, `撤掉了（链接 → ${target}；记在 ${record}）`));
      } else {
        const saved = backups.saveFile(abs, slashed(rel));
        unlinkSync(abs);
        out.push(line('changed', key, `撤掉了（原文件备份在 ${saved}）`));
      }
    } catch (err) {
      out.push(line('failed', key, `没做成——${code(err)}`));
    }
  }
  if (!out.some((l) => l.kind === 'changed' || l.kind === 'failed' || l.kind === 'unknown')) {
    out.push(
      line(
        'ok',
        '旧仓',
        `没有要撤的（查了 ${scanned} 个在的 skill 目录和 ~/.claude/agents 里那两个旧子代理）`,
      ),
    );
  }
  return out;
}
