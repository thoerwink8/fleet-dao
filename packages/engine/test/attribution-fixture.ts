// 第 2 轮增量归属的真实 Git 夹具。镜像布局和引擎一样：<state>/mirrors/acme/demo.git。
// 历史：旧主线 → PR 旧验收头 → 作者继续返工；主线另起提交删掉旧模块并改公共文件；作者再合并或变基到新主线。
import { execFile } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_EDITOR: 'true',
};

const GIT_C = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@example.com',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.autocrlf=false',
];

export const WORKFLOW_ID = 'task:acme/demo#12';
export const FIXTURE_REPO = { owner: 'acme', name: 'demo' };
export const LAUNCHER_GO = 'cmd/mirasim-launcher/main.go';
export const LAUNCHER_YML = '.github/workflows/mirasim-launcher.yml';
export const PACKAGE_JSON_PATH = 'package.json';

const LAUNCHER_GO_TEXT = 'package main\nfunc main() {}\n';
const LAUNCHER_YML_TEXT = 'name: mirasim-launcher\n';
const PACKAGE_JSON_TEXT = '{"scripts":{"launcher":"go run ./cmd/mirasim-launcher"}}\n';
const PACKAGE_TAMPERED = '{"scripts":{"launcher":"tampered"}}\n';
const SHARED_M0 = 'mainline-line\nkeep\nauthor-line\n';
const SHARED_M1 = 'mainline-line-moved\nkeep\nauthor-line\n';
const SHARED_AUTHOR = 'mainline-line\nkeep\nauthor-line-rewritten\n';
const KEEP = 'stable\n';
const OCC_V1 = 'round1\n';
const OCC_V2 = 'round1\nround2\n';
const REGRESSION = 'new-bug\n';
const VERIFIED = 'already\n';
const LATER = 'later-mainline\n';
const SIDE = 'side-branch\n';

export interface AttributionFixture {
  stateDir: string;
  bare: string;
  /** 旧主线，也是工作流记下的基线。 */
  m0: string;
  /** PR 旧验收头。 */
  v1: string;
  /** 作者在旧验收头之后的返工。 */
  rework: string;
  /** 主线独立删掉旧模块并改了公共文件。 */
  m1: string;
  /** 当前头还没含的更新主线尖。 */
  m2: string;
  /** 作者返工之后合并 m1。 */
  merged: string;
  /** 同一棵树变基到 m1 上，旧验收头不再是祖先。 */
  rebased: string;
  /** 合并之后把主线已删的文件按原字节加回，并改写另一个已删文件。 */
  tamper: string;
  /** 只合并主线，作者在旧验收头之后没有别的返工。 */
  syncOnly: string;
  /** 主线把已有文件和新建文件写成和作者最终提交相同的内容，并另加只属于主线的文件。 */
  mCoincide: string;
  /** 作者改过这些文件（中间内容不同），合并后最终 blob 与 mCoincide 相同。 */
  coincided: string;
  /** 只把 mCoincide 并进旧验收头，作者没有再改那些文件。 */
  coincideSync: string;
  /** 不在可信主线上的旁支。 */
  side: string;
  /** 第二父是旁支的合并。 */
  bad: string;
  /** 和这张 PR 没有共同历史的提交。 */
  orphan: string;
}

/** 在临时镜像里跑 git。非 0 抛出 stderr。 */
export async function gitText(cwd: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync('git', [...GIT_C, ...args], {
      cwd,
      env: gitEnv,
      encoding: 'utf8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return result.stdout.trim();
  } catch (error) {
    const err = error as { stderr?: string; message?: string };
    throw new Error(`git ${args.join(' ')}: ${(err.stderr ?? err.message ?? '').trim()}`);
  }
}

export async function setFetchedMainline(bare: string, sha: string): Promise<void> {
  await gitText(bare, ['update-ref', 'refs/fleet/main', sha]);
}

export async function deleteFetchedMainline(bare: string): Promise<void> {
  await gitText(bare, ['update-ref', '-d', 'refs/fleet/main']);
}

/**
 * 造好整段历史并写入裸镜像。refs/fleet/main 先指在 m1（当前头已经含有的那截）。
 * 调用方自己设置 FLEET_GITHUB_STATE_DIR 为 stateDir。
 */
export async function buildAttributionFixture(stateDir: string): Promise<AttributionFixture> {
  const bare = join(stateDir, 'mirrors', 'acme', 'demo.git');
  const work = join(stateDir, 'work');
  mkdirSync(join(stateDir, 'mirrors', 'acme'), { recursive: true });
  await gitText(stateDir, ['init', '--bare', '-b', 'main', bare]);
  await gitText(stateDir, ['init', '-b', 'main', work]);
  const write = (rel: string, text: string) => {
    const dest = join(work, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, text);
  };
  const commit = async (message: string) => {
    await gitText(work, ['add', '-A']);
    await gitText(work, ['commit', '-m', message]);
    return gitText(work, ['rev-parse', 'HEAD']);
  };

  write(LAUNCHER_GO, LAUNCHER_GO_TEXT);
  write(LAUNCHER_YML, LAUNCHER_YML_TEXT);
  write(PACKAGE_JSON_PATH, PACKAGE_JSON_TEXT);
  write('shared.txt', SHARED_M0);
  write('keep.txt', KEEP);
  const m0 = await commit('old mainline');

  await gitText(work, ['checkout', '-b', 'pr']);
  write('occupancy.txt', OCC_V1);
  write('verified.txt', VERIFIED);
  const v1 = await commit('verified head');

  write('occupancy.txt', OCC_V2);
  write('shared.txt', SHARED_AUTHOR);
  write('regression.txt', REGRESSION);
  const rework = await commit('author rework');

  await gitText(work, ['checkout', 'main']);
  await gitText(work, ['rm', '-f', '--', LAUNCHER_GO, LAUNCHER_YML, PACKAGE_JSON_PATH]);
  write('shared.txt', SHARED_M1);
  const m1 = await commit('mainline deletes launcher');

  await gitText(work, ['checkout', 'pr']);
  await gitText(work, ['merge', '--no-ff', '-m', 'sync mainline', 'main']);
  const merged = await gitText(work, ['rev-parse', 'HEAD']);
  const shared = await gitText(work, ['show', `${merged}:shared.txt`]);
  if (!shared.includes('mainline-line-moved') || !shared.includes('author-line-rewritten')) {
    throw new Error(`公共文件没有按两边的改动合上:\n${shared}`);
  }
  let launcherRemains = true;
  try {
    await gitText(work, ['cat-file', '-e', `${merged}:${LAUNCHER_GO}`]);
  } catch {
    launcherRemains = false;
  }
  if (launcherRemains) throw new Error('合并后主线已删的启动器还在当前头上');

  await gitText(work, ['checkout', '-B', 'rebased', m1]);
  await gitText(work, ['checkout', merged, '--', '.']);
  await gitText(work, ['add', '-A']);
  const rebased = await commit('rebase onto new mainline');

  await gitText(work, ['checkout', '-B', 'tamper', merged]);
  write(LAUNCHER_GO, LAUNCHER_GO_TEXT);
  write(PACKAGE_JSON_PATH, PACKAGE_TAMPERED);
  const tamper = await commit('restore deleted module');

  await gitText(work, ['checkout', '-B', 'sync-only', v1]);
  await gitText(work, ['merge', '--no-ff', '-m', 'sync only', m1]);
  const syncOnly = await gitText(work, ['rev-parse', 'HEAD']);

  await gitText(work, ['checkout', '-B', 'side', m0]);
  write('side.txt', SIDE);
  const side = await commit('side branch');

  await gitText(work, ['checkout', '-B', 'bad', rework]);
  await gitText(work, ['merge', '--no-ff', '-m', 'merge side', 'side']);
  const bad = await gitText(work, ['rev-parse', 'HEAD']);

  await gitText(work, ['checkout', 'main']);
  write('later.txt', LATER);
  const m2 = await commit('later mainline');

  // 作者和主线把同一文件写成相同的最终字节。中间提交留着作者自己的字，最终树上看不见。
  await gitText(work, ['checkout', '-B', 'coincide-pr', v1]);
  write('keep.txt', 'author-only-line\n');
  write('coincide.txt', 'author-wrote-coincide\n');
  await commit('author touches files mainline will match');
  write('keep.txt', 'same-final\n');
  write('coincide.txt', 'same-final\n');
  await commit('author lands on the same bytes');

  await gitText(work, ['checkout', '-B', 'm-coincide', m1]);
  write('keep.txt', 'same-final\n');
  write('coincide.txt', 'same-final\n');
  write('mainline-only.txt', 'only-mainline\n');
  const mCoincide = await commit('mainline writes the same final bytes');

  await gitText(work, ['checkout', 'coincide-pr']);
  await gitText(work, ['merge', '--no-ff', '-m', 'sync coincided mainline', 'm-coincide']);
  const coincided = await gitText(work, ['rev-parse', 'HEAD']);
  const keepHead = await gitText(work, ['rev-parse', `${coincided}:keep.txt`]);
  const keepMain = await gitText(work, ['rev-parse', `${mCoincide}:keep.txt`]);
  if (keepHead !== keepMain) throw new Error('keep.txt 最终 blob 和主线不一致，夹具没造出最终内容相同的情况');
  const coincideHead = await gitText(work, ['rev-parse', `${coincided}:coincide.txt`]);
  const coincideMain = await gitText(work, ['rev-parse', `${mCoincide}:coincide.txt`]);
  if (coincideHead !== coincideMain) {
    throw new Error('coincide.txt 最终 blob 和主线不一致，夹具没造出最终内容相同的情况');
  }

  await gitText(work, ['checkout', '-B', 'coincide-sync', v1]);
  await gitText(work, ['merge', '--no-ff', '-m', 'sync same bytes only', 'm-coincide']);
  const coincideSync = await gitText(work, ['rev-parse', 'HEAD']);

  await gitText(work, ['checkout', '--orphan', 'orphan']);
  for (const name of readdirSync(work)) {
    if (name === '.git') continue;
    rmSync(join(work, name), { recursive: true, force: true });
  }
  write('only-orphan.txt', 'unrelated\n');
  const orphan = await commit('unrelated root');

  await gitText(work, ['remote', 'add', 'origin', bare]);
  await gitText(work, ['push', 'origin', '--all']);
  await setFetchedMainline(bare, m1);

  const mergedTree = await gitText(bare, ['rev-parse', `${merged}^{tree}`]);
  const rebasedTree = await gitText(bare, ['rev-parse', `${rebased}^{tree}`]);
  if (mergedTree !== rebasedTree) throw new Error('变基结果和合并结果不是同一棵树');

  return {
    stateDir,
    bare,
    m0,
    v1,
    rework,
    m1,
    m2,
    merged,
    rebased,
    tamper,
    syncOnly,
    mCoincide,
    coincided,
    coincideSync,
    side,
    bad,
    orphan,
  };
}
