// 查（--check）和写（--apply）：通用段写进各家的全局文件，skill 拷进各家的 skill 目录。
// 写完照查一遍，读回不对的照样报出来：写了不等于写对了。
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  type Stats,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Backups } from './backup.ts';
import { blockAt, countLines, findMarkers, firstDiffLine, replaceBlock, sharedBlock } from './block.ts';
import { type Manifest, type ManifestRead, manifestPath, writeManifest } from './manifest.ts';
import { isBad, type Line, line } from './report.ts';
import {
  type AgentId,
  agentNames,
  type Platform,
  placeOn,
  RULES_TARGETS,
  type RulesTarget,
  SKILL_TARGETS,
  type SkillTarget,
  STATE_DIR,
  slashed,
} from './targets.ts';
import { linkTarget, readTree, removeEntry, sameTree, type Tree, treeDiff, writeTree } from './tree.ts';

export interface Sources {
  /** 通用段：含两行标记，\n 换行 */
  block: string;
  /** agents/skills/ 下的各个 skill（目录名 → 文件）；null＝仓里没有这个目录 */
  skills: Map<string, Tree> | null;
}

export interface Ctx {
  home: string;
  platform: Platform;
  installed: ReadonlySet<AgentId>;
}

const code = (err: unknown): string => (err as NodeJS.ErrnoException).code ?? String(err);

/** 读仓里的原件：AGENTS.md 的通用段、agents/skills/。读不到就说清为什么，不拿空的顶上 */
export function readSources(repo: string): { ok: true; value: Sources } | { ok: false; why: string } {
  let agentsMd: string;
  try {
    agentsMd = readFileSync(join(repo, 'AGENTS.md'), 'utf8');
  } catch (err) {
    return { ok: false, why: `读不了仓里的 AGENTS.md（${code(err)}）` };
  }
  const shared = sharedBlock(agentsMd);
  if (!shared.ok) return { ok: false, why: `仓里的 AGENTS.md：${shared.why}` };
  const dir = join(repo, 'agents', 'skills');
  let entries: string[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { ok: true, value: { block: shared.block, skills: null } };
    return { ok: false, why: `读不了仓里的 agents/skills/（${code(err)}）` };
  }
  const skills = new Map<string, Tree>();
  try {
    for (const name of entries) skills.set(name, readTree(join(dir, name)).files);
  } catch (err) {
    return { ok: false, why: `读不了仓里的 agents/skills/ 下的文件（${code(err)}）` };
  }
  return { ok: true, value: { block: shared.block, skills } };
}

function relOf(ctx: Ctx, place: { win32: string; linux: string }): { rel: string; abs: string; key: string } {
  const rel = placeOn(place, ctx.platform);
  return { rel, abs: join(ctx.home, rel), key: `~/${slashed(rel)}` };
}

/** 家里的文件该归谁：这个家目录的主人（Windows 不判） */
function expectedOwner(ctx: Ctx): number | undefined {
  if (ctx.platform !== 'linux') return undefined;
  try {
    return statSync(ctx.home).uid;
  } catch {
    return undefined;
  }
}

function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function readersOf(ctx: Ctx, t: RulesTarget | SkillTarget): { installed: AgentId[]; who: string } {
  const installed = t.readers.filter((r) => ctx.installed.has(r));
  return { installed, who: `（给 ${agentNames(installed, t.borrowed)}）` };
}

// ── 通用段 ──

export function checkRules(ctx: Ctx, src: Sources): Line[] {
  const out: Line[] = [];
  const owner = expectedOwner(ctx);
  for (const t of RULES_TARGETS) {
    const { abs, key } = relOf(ctx, t.file);
    const { installed, who } = readersOf(ctx, t);
    if (installed.length === 0) {
      out.push(line('skip', key, `没装（${agentNames(t.readers)}），跳过`));
      continue;
    }
    let st: Stats | null;
    let text: string;
    try {
      st = lstatOrNull(abs);
      if (st === null) {
        out.push(line('missing', key, `缺失——没有这个文件${who}`));
        continue;
      }
      if (st.isSymbolicLink()) {
        out.push(line('drift', key, `漂移——这是个链接（→ ${linkTarget(abs)}），不是本脚本写的文件`));
        continue;
      }
      if (!st.isFile()) {
        out.push(line('drift', key, '漂移——这里不是文件'));
        continue;
      }
      text = readFileSync(abs, 'utf8');
    } catch (err) {
      out.push(line('unknown', key, `没查成——读不了（${code(err)}）`));
      continue;
    }
    const problems: Line[] = [];
    const m = findMarkers(text);
    if (m.kind === 'none') {
      problems.push(line('missing', key, `缺失——文件在（${countLines(text)} 行），里面没有受管块${who}`));
    } else if (m.kind === 'broken') {
      problems.push(line('drift', key, `漂移——标记不成对：${m.why}`));
    } else {
      const have = blockAt(text, m);
      if (have !== src.block) {
        problems.push(
          line('drift', key, `漂移——受管块和仓里不一样（第 ${firstDiffLine(src.block, have)} 行起）${who}`),
        );
      }
    }
    if (owner !== undefined && st.uid !== owner) {
      problems.push(line('drift', key, `漂移——属主是 uid ${st.uid}，应归这个家的主人（uid ${owner}）`));
    }
    for (const s of t.shadowedBy ?? []) {
      const shadow = relOf(ctx, s);
      if (existsSync(shadow.abs)) {
        problems.push(
          line('drift', key, `漂移——${shadow.key} 在，${agentNames(installed)} 只读它、不读这份`),
        );
      }
    }
    out.push(...(problems.length ? problems : [line('ok', key, `一致${who}`)]));
  }
  return out;
}

/** 先写临时文件再换上：写到一半断了也不会留半个文件 */
function writeAtomic(abs: string, content: string, mode: number | undefined): void {
  const tmp = join(dirname(abs), `.${basename(abs)}.fleet-dao-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, content, { mode: mode ?? 0o644 });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, abs);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // 临时文件没建出来
    }
    throw err;
  }
}

export function applyRules(ctx: Ctx, src: Sources, backups: Backups): Line[] {
  const out: Line[] = [];
  const blockLines = countLines(src.block);
  for (const t of RULES_TARGETS) {
    const { rel, abs, key } = relOf(ctx, t.file);
    const { installed, who } = readersOf(ctx, t);
    if (installed.length === 0) {
      out.push(line('skip', key, `没装（${agentNames(t.readers)}），跳过`));
      continue;
    }
    try {
      const st = lstatOrNull(abs);
      if (st === null) {
        mkdirSync(dirname(abs), { recursive: true });
        writeAtomic(abs, `${src.block}\n`, undefined);
        out.push(line('changed', key, `新建，写入通用段（${blockLines} 行）${who}`));
      } else if (st.isSymbolicLink()) {
        out.push(
          line(
            'failed',
            key,
            `没动——这是个链接（→ ${linkTarget(abs)}），不是本脚本写的文件；要接管先把链接删掉`,
          ),
        );
      } else if (!st.isFile()) {
        out.push(line('failed', key, '没动——这里不是文件'));
      } else {
        const text = readFileSync(abs, 'utf8');
        const mode = ctx.platform === 'linux' ? st.mode & 0o777 : undefined;
        const m = findMarkers(text);
        if (m.kind === 'none') {
          // 第一次接管：原文件整份备份，再整份换成受管块
          const saved = backups.saveFile(abs, slashed(rel));
          writeAtomic(abs, `${src.block}\n`, mode);
          out.push(
            line(
              'changed',
              key,
              `接管——原文件 ${countLines(text)} 行，已备份到 ${saved}；整份换成受管块（${blockLines} 行）${who}`,
            ),
          );
        } else if (m.kind === 'broken') {
          out.push(line('failed', key, `没动——标记不成对（${m.why}）；手工修好或整份删掉再跑`));
        } else if (blockAt(text, m) === src.block) {
          out.push(line('ok', key, `一致${who}`));
        } else {
          writeAtomic(abs, replaceBlock(text, m, src.block), mode);
          out.push(line('changed', key, `受管块换成了仓里的版本（标记外的内容没动）${who}`));
        }
      }
    } catch (err) {
      out.push(line('failed', key, `没做成——${code(err)}`));
      continue;
    }
    for (const s of t.shadowedBy ?? []) {
      const shadow = relOf(ctx, s);
      if (existsSync(shadow.abs)) {
        out.push(
          line(
            'failed',
            key,
            `${shadow.key} 在，${agentNames(installed)} 只读它、不读这份；它不是本脚本写的，没动，要人看`,
          ),
        );
      }
    }
  }
  return out;
}

// ── skill ──

function manifestKey(ctx: Ctx): string {
  return `~/${slashed(placeOn(STATE_DIR, ctx.platform))}/agents-sync.json`;
}

/** 有没有 skill 可管：仓里有，或者清单里记着装过（仓里删了要撤） */
function nothingToDo(src: Sources, m: Manifest): boolean {
  const repoEmpty = src.skills === null || src.skills.size === 0;
  return repoEmpty && Object.values(m.skills).every((names) => names.length === 0);
}

function noSkillsLine(src: Sources): Line {
  const why = src.skills === null ? '仓里没有 agents/skills/' : '仓里的 agents/skills/ 是空的';
  return line('skip', 'agents/skills', `${why}：没有 skill 可分发`);
}

export function checkSkills(ctx: Ctx, src: Sources, manifest: ManifestRead): Line[] {
  if (!manifest.ok) {
    return [
      line(
        'unknown',
        manifestKey(ctx),
        `没查成——清单${manifest.why}：哪些 skill 是本脚本装的没法判断，skill 这部分没查`,
      ),
    ];
  }
  if (nothingToDo(src, manifest.value)) return [noSkillsLine(src)];
  const out: Line[] = [];
  const owner = expectedOwner(ctx);
  const want = src.skills ?? new Map<string, Tree>();
  for (const t of SKILL_TARGETS) {
    const { rel, abs, key } = relOf(ctx, t.dir);
    const { installed, who } = readersOf(ctx, t);
    if (installed.length === 0) {
      out.push(line('skip', key, `没装（${agentNames(t.readers)}），跳过`));
      continue;
    }
    const mine = new Set(manifest.value.skills[slashed(rel)] ?? []);
    let same = 0;
    for (const [name, tree] of want) {
      const dest = join(abs, name);
      const k = `${key}/${name}`;
      try {
        const st = lstatOrNull(dest);
        if (st === null) {
          out.push(line('missing', k, `缺失——没装上${who}`));
        } else if (st.isSymbolicLink()) {
          const to = linkTarget(dest);
          out.push(
            line(
              'drift',
              k,
              mine.has(name)
                ? `漂移——被换成了链接（→ ${to}）`
                : `漂移——同名的是链接（→ ${to}），不是本脚本装的`,
            ),
          );
        } else if (!st.isDirectory()) {
          out.push(line('drift', k, '漂移——同名的不是目录'));
        } else {
          const have = readTree(dest);
          if (!sameTree(tree, have.files)) {
            const diff = treeDiff(tree, have.files);
            out.push(
              line(
                'drift',
                k,
                mine.has(name)
                  ? `漂移——和仓里不一样（${diff}）`
                  : `漂移——同名目录不是本脚本装的，内容也和仓里不一样（${diff}）`,
              ),
            );
          } else if (owner !== undefined && have.owners.some((u) => u !== owner)) {
            out.push(line('drift', k, `漂移——里面有不归这个家主人（uid ${owner}）的文件`));
          } else if (!mine.has(name)) {
            out.push(line('drift', k, '漂移——同名目录不是本脚本装的（内容和仓里一样，也不接管）'));
          } else {
            same++;
          }
        }
      } catch (err) {
        out.push(line('unknown', k, `没查成——读不了（${code(err)}）`));
      }
    }
    for (const name of mine) {
      if (want.has(name)) continue;
      try {
        if (lstatOrNull(join(abs, name)) !== null)
          out.push(line('drift', `${key}/${name}`, '漂移——仓里已经删了，这里还在'));
      } catch (err) {
        out.push(line('unknown', `${key}/${name}`, `没查成——读不了（${code(err)}）`));
      }
    }
    if (same > 0) out.push(line('ok', key, `${same} 个 skill 和仓里一样${who}`));
  }
  return out;
}

type Step =
  | { do: 'install'; name: string; tree: Tree }
  | { do: 'replace'; name: string; tree: Tree; was: string }
  | { do: 'remove'; name: string };

export function applySkills(ctx: Ctx, src: Sources, manifest: ManifestRead): Line[] {
  if (!manifest.ok) {
    return [
      line(
        'failed',
        manifestKey(ctx),
        `没做成——清单${manifest.why}：哪些 skill 是本脚本装的没法判断，skill 一个没动`,
      ),
    ];
  }
  if (nothingToDo(src, manifest.value)) return [noSkillsLine(src)];
  const file = manifestPath(ctx.home, ctx.platform);
  const m: Manifest = { skills: { ...manifest.value.skills } };
  const want = src.skills ?? new Map<string, Tree>();
  const out: Line[] = [];
  for (const t of SKILL_TARGETS) {
    const { rel, abs, key } = relOf(ctx, t.dir);
    const { installed, who } = readersOf(ctx, t);
    if (installed.length === 0) {
      out.push(line('skip', key, `没装（${agentNames(t.readers)}），跳过`));
      continue;
    }
    const mk = slashed(rel);
    const mine = new Set(m.skills[mk] ?? []);
    const steps: Step[] = [];
    let same = 0;
    for (const [name, tree] of want) {
      const dest = join(abs, name);
      const k = `${key}/${name}`;
      try {
        const st = lstatOrNull(dest);
        if (st === null) {
          steps.push({ do: 'install', name, tree });
        } else if (st.isSymbolicLink() || !st.isDirectory()) {
          const was = st.isSymbolicLink() ? `链接 → ${linkTarget(dest)}` : '不是目录';
          if (mine.has(name)) steps.push({ do: 'replace', name, tree, was });
          else out.push(line('failed', k, `没动——同名的（${was}）不是本脚本装的`));
        } else if (sameTree(tree, readTree(dest).files)) {
          // 不是本脚本装的，内容一样也不接管：接管了，仓里哪天删掉这个 skill，就会把本不归它管的目录一起撤掉
          if (mine.has(name)) same++;
          else out.push(line('failed', k, '没动——同名目录不是本脚本装的（内容和仓里一样，也不接管）'));
        } else if (mine.has(name)) {
          steps.push({ do: 'replace', name, tree, was: '内容和仓里不一样' });
        } else {
          out.push(line('failed', k, '没动——同名目录不是本脚本装的，内容也和仓里不一样'));
        }
      } catch (err) {
        out.push(line('failed', k, `没做成——读不了（${code(err)}）`));
      }
    }
    for (const name of mine) if (!want.has(name)) steps.push({ do: 'remove', name });

    // 先记进清单再动手：装到一半断了，下一遍还认得出这是自己装的、能修
    for (const s of steps) if (s.do !== 'remove') mine.add(s.name);
    m.skills[mk] = [...mine];
    try {
      writeManifest(file, m);
    } catch (err) {
      out.push(
        line('failed', manifestKey(ctx), `没做成——清单写不进去（${code(err)}），${key} 的 skill 没动`),
      );
      continue;
    }
    for (const s of steps) {
      const dest = join(abs, s.name);
      const k = `${key}/${s.name}`;
      try {
        if (s.do === 'install') {
          writeTree(dest, s.tree);
          out.push(line('changed', k, `装上了${who}`));
        } else if (s.do === 'replace') {
          removeEntry(dest);
          writeTree(dest, s.tree);
          out.push(line('changed', k, `换成了仓里的版本（原来${s.was}）`));
        } else {
          if (lstatOrNull(dest) !== null) {
            removeEntry(dest);
            out.push(line('changed', k, '撤掉了（仓里已经删了）'));
          }
          mine.delete(s.name);
        }
      } catch (err) {
        out.push(line('failed', k, `没做成——${code(err)}`));
      }
    }
    m.skills[mk] = [...mine];
    if (same > 0) out.push(line('ok', key, `${same} 个 skill 和仓里一样${who}`));
  }
  try {
    writeManifest(file, m);
  } catch (err) {
    out.push(line('failed', manifestKey(ctx), `没做成——清单写不进去（${code(err)}）`));
  }
  return out;
}

/** 写完照查一遍：写的时候没报错、读回却不对的，补一行报出来（同一项已经报过没做成的不重复） */
export function verify(done: readonly Line[], after: readonly Line[]): Line[] {
  const reported = new Set(done.filter(isBad).map((l) => l.key));
  return after
    .filter((l) => (isBad(l) || l.kind === 'unknown') && !reported.has(l.key))
    .map((l) => ({ ...l, text: `写完读回不对：${l.text}` }));
}
