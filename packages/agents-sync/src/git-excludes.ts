// 全局 git 忽略：把 `_tmp/` 加进这台机器的 git 全局忽略（core.excludesFile），不管哪个仓、哪怕那个仓自己的
// .gitignore 漏写了 `_tmp/`，里面的东西都不会被 `git add` 卷进去——AGENTS.md 通用段「放 _tmp/」那条的最后一道网。
// 读写都指定 --file（ctx.home 下那份 .gitconfig），不用 --global：--global 靠进程环境变量 HOME 找家目录，
// 测试、`--home` 传了别的目录时会因此摸到真机器的 git 全局配置——这里全程按 ctx.home 走，连 spawn 的子进程也把
// HOME/USERPROFILE 显式改成 ctx.home，不信环境变量本来是什么。
// 不抢用户已经在用的文件：core.excludesFile 没设过，才新建一份 ~/.fleet-dao/gitignore_global 归本脚本管，
// 顺带把 core.excludesFile 指过去；已经指到别的文件，就在那份文件里接管标记圈起来的一小块，其余内容原样留着
// （和 AGENTS.md 通用段一个思路，但这里没有「原文件不存在这份，整份接管」——全局 gitignore 本来就该是加法，
// 只加自己这一块，不碰用户已经写的其他忽略规则）。
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Backups } from './backup.ts';
import { blockAt, countLines, findMarkers, firstDiffLine, replaceBlock } from './block.ts';
import { type Line, line } from './report.ts';
import { type Ctx, code, lstatOrNull, writeAtomic } from './sync.ts';
import { placeOn, STATE_DIR, slashed } from './targets.ts';

const BEGIN =
  '# fleet-dao:全局忽略 开始。同步脚本按这对标记整块替换；要改内容，改 fleet-dao 仓的 packages/agents-sync/src/git-excludes.ts';
const END = '# fleet-dao:全局忽略 结束';
/** 受管块本身（不含末尾换行，和 block.ts 的 blockAt 返回的形状对齐） */
export const WANT = `${BEGIN}\n_tmp/\n${END}`;

function gitconfigPath(home: string): string {
  return join(home, '.gitconfig');
}

function defaultExcludesPath(ctx: Ctx): string {
  return join(ctx.home, placeOn(STATE_DIR, ctx.platform), 'gitignore_global');
}

/** 子进程按 ctx.home 找家目录，不用进程自己的环境变量（测试、--home 都靠这个才不摸到真机器） */
function gitEnv(home: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: home, USERPROFILE: home };
}

export type ConfigRead =
  | { kind: 'set'; value: string }
  | { kind: 'unset' }
  | { kind: 'unknown'; why: string };

/** 这台的 core.excludesFile 现在指到哪；没设过是 unset，读不出（文件坏了……）是 unknown，不当 unset 处理 */
export function readExcludesFile(home: string): ConfigRead {
  const r = spawnSync(
    'git',
    // -C home：不依赖进程继承来的 cwd。--user 换完身份后 cwd 还是原来那个仓目录，新用户往往连 stat
    // 都没权限（法国、CI 的 --user 测试都踩过：「fatal: failed to stat '<仓目录>': Permission denied」）；
    // 换成这台用户自己的家目录，保证当前有效身份摸得到。和 position.ts 的 runGit 一个思路。
    ['-C', home, 'config', '--file', gitconfigPath(home), '--path', '--get', 'core.excludesFile'],
    { encoding: 'utf8', windowsHide: true, env: gitEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (r.error) {
    return {
      kind: 'unknown',
      why: `git 起不来（${(r.error as NodeJS.ErrnoException).code ?? r.error.message}）`,
    };
  }
  const out = (r.stdout ?? '').trim();
  if (r.status === 0) return { kind: 'set', value: out };
  // git config --get：文件不存在、或文件在但没这个键，都是退出码 1、没有输出——两种情况对我们来说都是「没设过」。
  // 别的退出码（比如 .gitconfig 语法坏了是 128）说明读不准，不能当「没设过」处理，会把用户的选择覆盖掉。
  if (r.status === 1 && out === '') return { kind: 'unset' };
  const firstErr = (r.stderr ?? '').trim().split('\n')[0];
  return {
    kind: 'unknown',
    why: `git config 读不出（退出码 ${r.status}${firstErr ? `：${firstErr}` : ''}）`,
  };
}

function setExcludesFile(home: string, path: string): { ok: true } | { ok: false; why: string } {
  const r = spawnSync(
    'git',
    ['-C', home, 'config', '--file', gitconfigPath(home), 'core.excludesFile', path],
    { encoding: 'utf8', windowsHide: true, env: gitEnv(home), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  if (r.error)
    return { ok: false, why: `git 起不来（${(r.error as NodeJS.ErrnoException).code ?? r.error.message}）` };
  if (r.status !== 0) {
    const firstErr = (r.stderr ?? '').trim().split('\n')[0];
    return { ok: false, why: `退出码 ${r.status}${firstErr ? `：${firstErr}` : ''}` };
  }
  return { ok: true };
}

/** 给人看、也当 Line 的 key：在 ctx.home 下面就写成 ~/...，不在（用户指到别处）就写绝对路径 */
function displayPath(ctx: Ctx, abs: string): string {
  const home = ctx.home.replace(/[\\/]+$/, '');
  const norm = (p: string) => (ctx.platform === 'win32' ? p.toLowerCase() : p);
  const nAbs = norm(abs);
  const nHome = norm(home);
  if (nAbs === nHome) return '~';
  if (nAbs.startsWith(`${nHome}/`) || nAbs.startsWith(`${nHome}\\`)) {
    return `~/${slashed(abs.slice(home.length + 1))}`;
  }
  return abs;
}

/** 备份用的相对路径：在 ctx.home 下面就是真的相对路径；不在（用户指到家目录外）就退到一个不会撞车的名字 */
function backupRel(abs: string, key: string): string {
  if (key.startsWith('~/')) return key.slice(2);
  if (key === '~') return '.gitconfig-excludes';
  return `外部全局忽略/${abs
    .replace(/^[/\\]+/, '')
    .replaceAll('\\', '/')
    .replaceAll(':', '')}`;
}

function readTextOrNull(abs: string): { ok: true; text: string | null } | { ok: false; why: string } {
  const st = lstatOrNull(abs);
  if (st === null) return { ok: true, text: null };
  if (!st.isFile()) return { ok: false, why: '这里不是文件' };
  try {
    return { ok: true, text: readFileSync(abs, 'utf8') };
  } catch (err) {
    return { ok: false, why: `读不了（${code(err)}）` };
  }
}

export function checkGitExcludes(ctx: Ctx): Line[] {
  const read = readExcludesFile(ctx.home);
  const CONFIG_KEY = '~/.gitconfig#core.excludesFile';
  if (read.kind === 'unknown') {
    return [line('unknown', CONFIG_KEY, `没查成——${read.why}`)];
  }
  const targetAbs = read.kind === 'set' ? read.value : defaultExcludesPath(ctx);
  const key = displayPath(ctx, targetAbs);
  if (read.kind === 'unset') {
    return [line('missing', CONFIG_KEY, '缺失——这台还没设过，没有全局忽略文件兜 _tmp/')];
  }
  const read2 = readTextOrNull(targetAbs);
  if (!read2.ok) return [line('unknown', key, `没查成——${read2.why}`)];
  if (read2.text === null) return [line('missing', key, 'core.excludesFile 指到这份，但文件不在')];
  const m = findMarkers(read2.text, BEGIN, END);
  if (m.kind === 'none') {
    return [line('missing', key, `缺失——文件在（${countLines(read2.text)} 行），里面没有 _tmp/ 那一块`)];
  }
  if (m.kind === 'broken') return [line('drift', key, `漂移——标记不成对：${m.why}`)];
  const have = blockAt(read2.text, m);
  if (have !== WANT) {
    return [line('drift', key, `漂移——受管块和该有的不一样（第 ${firstDiffLine(WANT, have)} 行起）`)];
  }
  return [line('ok', key, '_tmp/ 在全局忽略里')];
}

export function applyGitExcludes(ctx: Ctx, backups: Backups): Line[] {
  const read = readExcludesFile(ctx.home);
  const CONFIG_KEY = '~/.gitconfig#core.excludesFile';
  if (read.kind === 'unknown') {
    return [line('unknown', CONFIG_KEY, `没做成——${read.why}，全局忽略没动`)];
  }
  const targetAbs = read.kind === 'set' ? read.value : defaultExcludesPath(ctx);
  const key = displayPath(ctx, targetAbs);
  const out: Line[] = [];
  if (read.kind === 'unset') {
    const set = setExcludesFile(ctx.home, targetAbs);
    if (!set.ok) return [line('failed', CONFIG_KEY, `没做成——core.excludesFile 设不上（${set.why}）`)];
    out.push(line('changed', CONFIG_KEY, `设成了 ${key}（原来没设过）`));
  }
  const read2 = readTextOrNull(targetAbs);
  if (!read2.ok) {
    out.push(line('unknown', key, `没查成——${read2.why}`));
    return out;
  }
  const text = read2.text ?? '';
  const m = findMarkers(text, BEGIN, END);
  if (m.kind === 'broken') {
    out.push(line('failed', key, `没动——标记不成对（${m.why}）；手工修好或把受管那几行删掉再跑`));
    return out;
  }
  if (m.kind === 'one' && blockAt(text, m) === WANT) {
    out.push(line('ok', key, '_tmp/ 在全局忽略里'));
    return out;
  }
  try {
    mkdirSync(dirname(targetAbs), { recursive: true });
    if (m.kind === 'none' && read2.text !== null) {
      // 文件已经在、只是没有受管块：追加到末尾，原有的忽略规则一行不动
      const eol = text.includes('\r\n') ? '\r\n' : '\n';
      const sep = text.length > 0 && !text.endsWith('\n') && !text.endsWith('\r\n') ? eol : '';
      writeAtomic(targetAbs, `${text}${sep}${WANT.replaceAll('\n', eol)}${eol}`, undefined);
      out.push(line('changed', key, `追加了 _tmp/ 那一块（原有 ${countLines(text)} 行没动）`));
    } else if (m.kind === 'none') {
      writeAtomic(targetAbs, `${WANT}\n`, undefined);
      out.push(line('changed', key, '新建，写入 _tmp/ 那一块'));
    } else {
      const saved = backups.saveFile(targetAbs, backupRel(targetAbs, key));
      writeAtomic(targetAbs, replaceBlock(text, m, WANT), undefined);
      out.push(line('changed', key, `受管块换成了该有的样子（标记外的内容没动；原文件备份到 ${saved}）`));
    }
  } catch (err) {
    out.push(line('failed', key, `没做成——${code(err)}`));
  }
  return out;
}
