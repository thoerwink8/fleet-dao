// 用户级子代理定义（#1393）：仓里 agents/subagents/ 下、targets.ts 的 SUBAGENT_TARGET 列了名字的几份，整份拷到 ~/.claude/agents/。
// 只认列了的文件名，不扫目录：~/.claude/agents/ 里机器上手写的（Explore.md、Plan.md 这类）一律不碰、不删。
// 同名文件内容和仓里不一样：先整份备份到 ~/.fleet-dao/backups/<时间>/，再换成仓里的，报出来（这几份归仓里管，手改的会被换回）。
// 清单 ~/.fleet-dao/agents-sync.json 的 subagents 记着装过哪几份：从 SUBAGENT_TARGET 里去掉的，清单里记着才撤（先备份），没记着的不碰。
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Backups } from './backup.ts';
import { firstDiffLine } from './block.ts';
import { type Manifest, type ManifestRead, manifestPath, writeManifest } from './manifest.ts';
import { type Line, line } from './report.ts';
import {
  type Ctx,
  code,
  expectedOwner,
  lstatOrNull,
  manifestKey,
  relOf,
  type Sources,
  SUBAGENTS_DIR,
  writeAtomic,
} from './sync.ts';
import { agentNames, SUBAGENT_TARGET, slashed } from './targets.ts';
import { linkTarget } from './tree.ts';

interface Scope {
  rel: string;
  abs: string;
  key: string;
  who: string;
}

/** 这一段该不该做：没装 Claude Code 就跳过（不管原件读不读得到） */
function scope(ctx: Ctx): Scope | Line {
  const t = SUBAGENT_TARGET;
  const { rel, abs, key } = relOf(ctx, t.dir);
  const installed = t.readers.filter((r) => ctx.installed.has(r));
  if (installed.length === 0) return line('skip', key, `没装（${agentNames(t.readers)}），跳过`);
  return { rel, abs, key, who: `（给 ${agentNames(installed)}）` };
}

export function checkSubagents(ctx: Ctx, src: Sources, manifest: ManifestRead): Line[] {
  const s = scope(ctx);
  if ('kind' in s) return [s];
  if (!src.subagents.ok) return [line('unknown', SUBAGENTS_DIR, `没查成——${src.subagents.why}`)];
  if (!manifest.ok) {
    return [
      line(
        'unknown',
        manifestKey(ctx),
        `没查成——清单${manifest.why}：哪些子代理定义是本脚本装的没法判断，子代理这部分没查`,
      ),
    ];
  }
  const out: Line[] = [];
  const owner = expectedOwner(ctx);
  const want = src.subagents.files;
  for (const [file, text] of want) {
    const dest = join(s.abs, file);
    const k = `${s.key}/${file}`;
    try {
      const st = lstatOrNull(dest);
      if (st === null) {
        out.push(line('missing', k, `缺失——没装上${s.who}`));
      } else if (st.isSymbolicLink()) {
        out.push(line('drift', k, `漂移——这是个链接（→ ${linkTarget(dest)}），不是本脚本写的文件`));
      } else if (!st.isFile()) {
        out.push(line('drift', k, '漂移——这里不是文件'));
      } else {
        const have = readFileSync(dest, 'utf8');
        if (have !== text) {
          out.push(
            line(
              'drift',
              k,
              `漂移——和仓里不一样（第 ${firstDiffLine(text, have)} 行起）；--apply 会先备份再换成仓里的`,
            ),
          );
        } else if (owner !== undefined && st.uid !== owner) {
          out.push(line('drift', k, `漂移——属主是 uid ${st.uid}，应归这个家的主人（uid ${owner}）`));
        } else {
          out.push(line('ok', k, `一致${s.who}`));
        }
      }
    } catch (err) {
      out.push(line('unknown', k, `没查成——读不了（${code(err)}）`));
    }
  }
  for (const file of manifest.value.subagents[slashed(s.rel)] ?? []) {
    if (want.has(file)) continue;
    const k = `${s.key}/${file}`;
    try {
      if (lstatOrNull(join(s.abs, file)) !== null)
        out.push(line('drift', k, '漂移——已经不在同步的名单里，这里还在（--apply 会备份后撤掉）'));
    } catch (err) {
      out.push(line('unknown', k, `没查成——读不了（${code(err)}）`));
    }
  }
  return out;
}

export function applySubagents(ctx: Ctx, src: Sources, manifest: ManifestRead, backups: Backups): Line[] {
  const s = scope(ctx);
  if ('kind' in s) return [s];
  if (!src.subagents.ok)
    return [line('failed', SUBAGENTS_DIR, `没做成——${src.subagents.why}，子代理一个没动`)];
  if (!manifest.ok) {
    return [
      line(
        'failed',
        manifestKey(ctx),
        `没做成——清单${manifest.why}：哪些子代理定义是本脚本装的没法判断，子代理一个没动`,
      ),
    ];
  }
  const file = manifestPath(ctx.home, ctx.platform);
  const mk = slashed(s.rel);
  const m: Manifest = { ...manifest.value, subagents: { ...manifest.value.subagents } };
  const want = src.subagents.files;
  const mine = new Set(m.subagents[mk] ?? []);
  // 先记进清单再动手：装到一半断了，下一遍还认得出这是自己装的
  for (const name of want.keys()) mine.add(name);
  m.subagents[mk] = [...mine];
  try {
    writeManifest(file, m);
  } catch (err) {
    return [
      line('failed', manifestKey(ctx), `没做成——清单写不进去（${code(err)}），${s.key} 的子代理定义没动`),
    ];
  }
  const out: Line[] = [];
  for (const [name, text] of want) {
    const dest = join(s.abs, name);
    const k = `${s.key}/${name}`;
    try {
      const st = lstatOrNull(dest);
      if (st === null) {
        mkdirSync(s.abs, { recursive: true });
        writeAtomic(dest, text, undefined);
        out.push(line('changed', k, `装上了${s.who}`));
      } else if (st.isSymbolicLink()) {
        out.push(
          line(
            'failed',
            k,
            `没动——这是个链接（→ ${linkTarget(dest)}），不是本脚本写的文件；要接管先把链接删掉`,
          ),
        );
      } else if (!st.isFile()) {
        out.push(line('failed', k, '没动——这里不是文件'));
      } else {
        const have = readFileSync(dest, 'utf8');
        if (have === text) {
          out.push(line('ok', k, `一致${s.who}`));
        } else {
          const saved = backups.saveFile(dest, `${mk}/${name}`);
          writeAtomic(dest, text, ctx.platform === 'linux' ? st.mode & 0o777 : undefined);
          out.push(
            line(
              'changed',
              k,
              `和仓里不一样（第 ${firstDiffLine(text, have)} 行起），原文件已备份到 ${saved}；换成了仓里的版本${s.who}`,
            ),
          );
        }
      }
    } catch (err) {
      out.push(line('failed', k, `没做成——${code(err)}`));
    }
  }
  for (const name of [...mine]) {
    if (want.has(name)) continue;
    const dest = join(s.abs, name);
    const k = `${s.key}/${name}`;
    try {
      const st = lstatOrNull(dest);
      if (st === null) {
        mine.delete(name);
      } else if (!st.isFile() || st.isSymbolicLink()) {
        out.push(line('failed', k, '没动——已经不在同步的名单里，可这里不是本脚本写的文件，要人看'));
      } else {
        const saved = backups.saveFile(dest, `${mk}/${name}`);
        unlinkSync(dest);
        mine.delete(name);
        out.push(line('changed', k, `撤掉了（已经不在同步的名单里），原文件已备份到 ${saved}`));
      }
    } catch (err) {
      out.push(line('failed', k, `没做成——${code(err)}`));
    }
  }
  m.subagents[mk] = [...mine];
  try {
    writeManifest(file, m);
  } catch (err) {
    out.push(line('failed', manifestKey(ctx), `没做成——清单写不进去（${code(err)}）`));
  }
  return out;
}
