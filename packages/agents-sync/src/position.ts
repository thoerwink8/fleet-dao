// 同步位置：这台机器同步到了 fleet-dao 的哪个提交、落后主线几个。记在 ~/.fleet-dao/synced.json：
// - repo：同步用的检出（linked worktree 记它的主工作树）。每次从 git 检出 --apply 都记：开会话钩子按它找检出，
//   就算这次有没做成的项，下次开会话也能接着同步、接着报。
// - synced：上次整次同步没有 ✗、没有没查成时的提交。只在变了的时候写（第二遍零改动）。
// 落后几个按本机上次取到的 origin/main 算，查的时候不出网（开会话钩子先取远端再同步）。
// git 的事都在换身份之前问好：换过去之后未必读得到仓，git 也会因为仓的属主不是自己而拒读。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { isBad, type Line, line } from './report.ts';
import { type Platform, placeOn, STATE_DIR, slashed } from './targets.ts';

export interface SyncRecord {
  /** 同步用的检出（主工作树） */
  repo: string;
  synced?: {
    commit: string;
    /** 同步时 agents/ 有没有没提交的改动 */
    dirty: boolean;
    /** 第一次同步到这个提交的时间 */
    at: string;
  };
}

export type RecordRead = { ok: true; value: SyncRecord | null } | { ok: false; why: string };

type Count = { ok: true; n: number } | { ok: false; why: string };

/** 一个提交和本机的 origin/main 比 */
interface Versus {
  behind: Count;
  /** 在不在主线上（没有 origin/main、没比成是 null） */
  onMain: boolean | null;
}

export type Source =
  | {
      kind: 'git';
      /** 主工作树 */
      main: string;
      head: string;
      dirty: boolean;
      /** 本机的 origin/main；没有就是 null */
      origin: string | null;
      headVsMain: Versus;
      /** 记下的提交和主线比（没记过是 null） */
      recordedVsMain: Versus | null;
    }
  | { kind: 'none'; why: string }
  | { kind: 'error'; why: string };

export interface Position {
  platform: Platform;
  file: string;
  key: string;
  record: RecordRead;
  source: Source;
}

export interface GitResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error | undefined;
}

export type Git = (repo: string, args: string[]) => GitResult;

export const runGit: Git = (repo, args) => {
  const r = spawnSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
};

export function recordFile(home: string, platform: Platform): { file: string; key: string } {
  const rel = join(placeOn(STATE_DIR, platform), 'synced.json');
  return { file: join(home, rel), key: `~/${slashed(rel)}` };
}

export function readRecord(file: string): RecordRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, value: null };
    return { ok: false, why: `读不了（${(err as NodeJS.ErrnoException).code ?? String(err)}）` };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, why: '不是 JSON' };
  }
  const d = data as { repo?: unknown; synced?: unknown } | null;
  if (typeof d?.repo !== 'string' || d.repo === '') return { ok: false, why: '里没有 repo' };
  if (d.synced === undefined) return { ok: true, value: { repo: d.repo } };
  const s = d.synced as { commit?: unknown; dirty?: unknown; at?: unknown } | null;
  if (
    typeof s?.commit !== 'string' ||
    !/^[0-9a-f]{40}$/.test(s.commit) ||
    typeof s.dirty !== 'boolean' ||
    typeof s.at !== 'string'
  ) {
    return { ok: false, why: '里 synced 的形状不对' };
  }
  return { ok: true, value: { repo: d.repo, synced: { commit: s.commit, dirty: s.dirty, at: s.at } } };
}

export function renderRecord(r: SyncRecord): string {
  const doc = {
    说明: 'fleet-dao 的同步脚本（packages/agents-sync）记的：repo 是同步用的 fleet-dao 检出（开会话钩子按它找检出），synced 是上次整次同步成功时的提交（--check 按它算落后主线几个）。别手改。',
    repo: r.repo,
    ...(r.synced ? { synced: r.synced } : {}),
  };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function firstLine(r: GitResult): string {
  if (r.error) return (r.error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? '超时' : r.error.message;
  return (r.stderr || r.stdout).trim().split('\n')[0] || `退出码 ${r.status}`;
}

function real(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return resolve(p);
  }
}

export function samePath(a: string, b: string, platform: Platform): boolean {
  const n = (p: string) => (platform === 'win32' ? real(p).toLowerCase() : real(p));
  return n(a) === n(b);
}

const ORIGIN_MAIN = 'refs/remotes/origin/main';

function versusMain(git: Git, repo: string, commit: string, origin: string | null): Versus {
  if (origin === null) return { behind: { ok: false, why: '仓里没有 origin/main' }, onMain: null };
  const r = git(repo, ['rev-list', '--count', `${commit}..${ORIGIN_MAIN}`]);
  const n = Number(r.stdout.trim());
  if (r.status !== 0 || r.stdout.trim() === '' || !Number.isInteger(n)) {
    return {
      behind: { ok: false, why: `提交 ${commit.slice(0, 7)} 和 origin/main 比不了（${firstLine(r)}）` },
      onMain: null,
    };
  }
  const anc = git(repo, ['merge-base', '--is-ancestor', commit, ORIGIN_MAIN]);
  return { behind: { ok: true, n }, onMain: anc.status === 0 ? true : anc.status === 1 ? false : null };
}

/** 在换身份之前调：读记录，问 git 检出在哪、HEAD 是哪个、落后几个 */
export function readPosition(repo: string, home: string, platform: Platform, git: Git = runGit): Position {
  const { file, key } = recordFile(home, platform);
  const record = readRecord(file);
  return { platform, file, key, record, source: readSource(repo, platform, git, record) };
}

function readSource(repo: string, platform: Platform, git: Git, record: RecordRead): Source {
  // 检出的根上一定有 .git（目录，或者 worktree 的 .git 文件）；没有就不是检出，不用去问 git（这台可能根本没装 git）
  if (!existsSync(join(repo, '.git'))) return { kind: 'none', why: `${repo} 不是 git 检出（没有 .git）` };
  const top = git(repo, ['rev-parse', '--show-toplevel']);
  if (top.error) {
    const missing = (top.error as NodeJS.ErrnoException).code === 'ENOENT';
    return { kind: 'error', why: missing ? '这台找不到 git 命令' : `git 起不来（${top.error.message}）` };
  }
  if (top.status !== 0) {
    if (/not a git repository/i.test(top.stderr)) return { kind: 'none', why: `${repo} 不是 git 检出` };
    return { kind: 'error', why: `git 读不了 ${repo}（${firstLine(top)}）` };
  }
  const topDir = top.stdout.trim();
  if (!samePath(topDir, repo, platform))
    return { kind: 'none', why: `${repo} 在 git 仓 ${topDir} 里面，不是它的根` };
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const commonDir = common.status === 0 ? common.stdout.trim() : '';
  const main = commonDir && basename(commonDir) === '.git' ? resolve(dirname(commonDir)) : resolve(repo);
  const head = git(repo, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (head.status !== 0) return { kind: 'error', why: `${repo} 的 HEAD 读不了（${firstLine(head)}）` };
  const headSha = head.stdout.trim();
  // 同步的原件都在 agents/ 下（通用段在 agents/shared-rules.md，仓根 AGENTS.md 只剩本仓段、不同步）
  const status = git(repo, ['status', '--porcelain', '--', 'agents']);
  if (status.status !== 0)
    return { kind: 'error', why: `${repo} 的 git status 跑不了（${firstLine(status)}）` };
  const originRead = git(repo, ['rev-parse', '-q', '--verify', `${ORIGIN_MAIN}^{commit}`]);
  const origin = originRead.status === 0 ? originRead.stdout.trim() : null;
  const synced = record.ok ? record.value?.synced : undefined;
  return {
    kind: 'git',
    main,
    head: headSha,
    dirty: status.stdout.trim() !== '',
    origin,
    headVsMain: versusMain(git, repo, headSha, origin),
    recordedVsMain: synced ? versusMain(git, repo, synced.commit, origin) : null,
  };
}

const short = (sha: string) => sha.slice(0, 7);
const minute = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** 一个提交和主线比的结论：一致、落后（或不在主线上）、没比成 */
function verdict(
  v: Versus,
  origin: string | null,
): { kind: 'ok'; text: string } | { kind: 'drift'; text: string } | { kind: 'unknown'; text: string } {
  if (!v.behind.ok) return { kind: 'unknown', text: `落后几个没查成（${v.behind.why}）` };
  const ref = origin ? `origin/main 是 ${short(origin)}，按本机上次取到的算` : '';
  if (v.onMain === false)
    return {
      kind: 'drift',
      text: `不在主线上（带着没合进主线的改动），主线上还有 ${v.behind.n} 个提交它没有（${ref}）`,
    };
  if (v.behind.n > 0) return { kind: 'drift', text: `落后主线 ${v.behind.n} 个提交（${ref}）` };
  return { kind: 'ok', text: `就是主线最新（${ref}）` };
}

export function checkPosition(pos: Position): Line[] {
  const { key, record, source } = pos;
  if (!record.ok) return [line('unknown', key, `没查成——记录${record.why}`)];
  if (source.kind === 'none') return [line('skip', key, `${source.why}，同步到哪个提交记不了、也查不了`)];
  if (source.kind === 'error') return [line('unknown', key, `没查成——${source.why}`)];
  const synced = record.value?.synced;
  if (!synced || !source.recordedVsMain)
    return [
      line(
        'missing',
        key,
        '缺失——还没记过这台同步到哪个提交（在 fleet-dao 检出里跑一遍 agents-sync --apply）',
      ),
    ];
  const notes = [
    ...(synced.dirty ? ['同步时 agents/ 有没提交的改动'] : []),
    ...(record.value && !samePath(record.value.repo, source.main, pos.platform)
      ? [`记的检出是 ${record.value.repo}`]
      : []),
  ];
  const tail = notes.length ? `；${notes.join('；')}` : '';
  const who = `这台同步到 ${short(synced.commit)}（${minute(synced.at)}）`;
  const v = verdict(source.recordedVsMain, source.origin);
  if (v.kind === 'ok') return [line('ok', key, `${who}，${v.text}${tail}`)];
  if (v.kind === 'unknown') return [line('unknown', key, `没查成——${who}，${v.text}${tail}`)];
  return [line('drift', key, `${who}，${v.text}${tail}`)];
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** --apply 最后一步：记下检出在哪；这次整次没有 ✗、没有没查成，才记同步到的提交 */
export function applyPosition(pos: Position, done: readonly Line[], now: Date): Line[] {
  const { file, key, record, source } = pos;
  if (source.kind === 'none') return [line('skip', key, `${source.why}，不记同步位置`)];
  if (source.kind === 'error') return [line('unknown', key, `没查成——${source.why}，同步位置没记`)];
  const clean = !done.some((l) => isBad(l) || l.kind === 'unknown');
  const keep = record.ok ? record.value?.synced : undefined;
  const same = keep && keep.commit === source.head && keep.dirty === source.dirty;
  const synced = clean
    ? { commit: source.head, dirty: source.dirty, at: same ? keep.at : now.toISOString() }
    : keep;
  const text = renderRecord({ repo: source.main, ...(synced ? { synced } : {}) });
  let wrote = false;
  if (readText(file) !== text) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, text);
      renameSync(tmp, file);
      wrote = true;
    } catch (err) {
      return [
        line('failed', key, `没做成——记录写不进去（${(err as NodeJS.ErrnoException).code ?? String(err)}）`),
      ];
    }
  }
  const fixed = record.ok ? '' : `（原来那份记录${record.why}，重写了）`;
  if (!clean) {
    return [
      line(
        wrote ? 'changed' : 'skip',
        key,
        `这次有没做成、没查成的，同步到的提交不记${keep ? `（上次记的是 ${short(keep.commit)}）` : ''}；检出记的是 ${source.main}${fixed}`,
      ),
    ];
  }
  const who = `这台同步到 ${short(source.head)}${source.dirty ? '（agents/ 里有没提交的改动）' : ''}`;
  const noted = wrote ? `记下了${fixed}` : '记过了';
  const v = verdict(source.headVsMain, source.origin);
  if (v.kind === 'ok') return [line(wrote ? 'changed' : 'ok', key, `${who}，${v.text}；${noted}`)];
  const out = [line(wrote ? 'changed' : 'ok', key, `${who}；${noted}`)];
  if (v.kind === 'unknown') out.push(line('unknown', `${key}#主线`, `检出 ${source.main}：${v.text}`));
  else
    out.push(
      line(
        'drift',
        `${key}#主线`,
        `检出 ${source.main} 的 HEAD ${v.text}：先把检出更新到主线（或开个会话，让开会话钩子快进）再同步`,
      ),
    );
  return out;
}
