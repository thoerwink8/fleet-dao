// deploy 那套（deploy/test/run.sh）在 CI 里切成几台并行跑（#654 F2）：这里钉住台数两边一样、矩阵铺得对，
// 台数只在 run.sh 里写一次（SHARDS 的项数），ci-plan.ts 的 DEPLOY_SHARDS 跟着它。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEPLOY_SHARDS,
  type DeployMode,
  deployMatrix,
  planCi,
  planOutputs,
  readGraph,
} from '../src/ci-plan.ts';
import { fsRepo } from '../src/repo.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const graph = () => {
  const g = readGraph(fsRepo(ROOT));
  if (typeof g === 'string') throw new Error(g);
  return g;
};

const RUN_SH = readFileSync(join(ROOT, 'deploy/test/run.sh'), 'utf8');

/** run.sh 里 SHARDS=( … ) 那一段的项数：每台一行，内容以 ' 开头。 */
function shardsInRunSh(text: string): number {
  const m = /^SHARDS=\(\n([\s\S]*?)^\)$/m.exec(text);
  if (!m) throw new Error('run.sh 里没找到 SHARDS=( … ) 那一段');
  const rows = (m[1] ?? '').split('\n').filter((l) => l.trim().startsWith("'"));
  if (rows.length === 0) throw new Error('SHARDS 里一行也没有');
  return rows.length;
}

describe('deploy 那套切几台并行跑（run.sh --shard，#654 F2）', () => {
  it('台数两边一样：ci-plan.ts 的 DEPLOY_SHARDS 和 run.sh 里 SHARDS 的项数', () => {
    expect(shardsInRunSh(RUN_SH)).toBe(DEPLOY_SHARDS);
  });

  it('all：切成 DEPLOY_SHARDS 台、每台 --shard i/n；ops：一台 --ops；none：空', () => {
    const all = deployMatrix('all');
    expect(all).toHaveLength(DEPLOY_SHARDS);
    expect(all.map((l) => l.label)).toEqual(
      Array.from({ length: DEPLOY_SHARDS }, (_, i) => `${i + 1}/${DEPLOY_SHARDS}`),
    );
    expect(all.map((l) => l.args)).toEqual(
      Array.from({ length: DEPLOY_SHARDS }, (_, i) => ['--shard', `${i + 1}/${DEPLOY_SHARDS}`]),
    );
    // 全套那几台要 sudo（建、删真系统账号）；ops 那台不用
    expect(all.every((l) => l.sudo === true)).toBe(true);
    expect(deployMatrix('ops')).toEqual([{ label: 'ops', args: ['--ops'], sudo: false }]);
    expect(deployMatrix('none')).toEqual([]);
  });

  it('planOutputs 把矩阵交给下游：all 几台、ops 一台、none 空数组', () => {
    const base = planCi({ event: 'push', changed: [], graph: graph() });
    const out = (deploy: DeployMode) => planOutputs({ ...base, deploy });
    /** deploy_matrix 一定在（planOutputs 固定带上）：不在就是改动漏了，直接炸出来，不当成空 */
    const matrix = (deploy: DeployMode) => {
      const json = out(deploy).deploy_matrix;
      if (json === undefined) throw new Error('planOutputs 没给 deploy_matrix');
      return JSON.parse(json) as unknown[];
    };
    expect(matrix('all')).toHaveLength(DEPLOY_SHARDS);
    expect(matrix('ops')).toEqual([{ label: 'ops', args: ['--ops'], sudo: false }]);
    expect(matrix('none')).toEqual([]);
  });

  it('【故意造出的失败】少一台、或两台报同一个台号：和「1..n 各一台」对不上', () => {
    const all = deployMatrix('all');
    const marks = (legs: readonly { args: string[] }[]) => legs.map((l) => l.args[l.args.length - 1] ?? '');
    const full = Array.from({ length: DEPLOY_SHARDS }, (_, i) => `${i + 1}/${DEPLOY_SHARDS}`);
    expect(marks(all)).toEqual(full);
    expect(marks(all.slice(1))).not.toEqual(full);
    const wrong = all.map((l, i) => (i === 1 ? { ...l, args: ['--shard', `1/${DEPLOY_SHARDS}`] } : l));
    expect(marks(wrong)).not.toEqual(full);
  });

  it('ci.yml：deploy 按矩阵铺、名字用 matrix.label、全套那几台带 sudo 和 FLEET_TEST_SYSTEM_USERS，开关给空数组时整个 job 不跑', () => {
    const yml = readFileSync(join(ROOT, '.github/workflows/ci.yml'), 'utf8');
    const start = yml.search(/^ {2}deploy:$/m);
    expect(start).toBeGreaterThan(-1);
    const next = yml.slice(start + 1).search(/^ {2}[\w-]+:$/m);
    const body = next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
    expect(body).toContain("if: needs.changes.outputs.deploy_matrix != '[]'");
    expect(body).toContain('name: deploy (${{ matrix.label }})');
    expect(body).toContain('include: ${{ fromJSON(needs.changes.outputs.deploy_matrix) }}');
    // 跑测试那步不再带条件（原来写的是 deploy == 'all'，ops 那台被跳过、空跑报绿，#662 第二意见）；sudo 由矩阵决定
    expect(body).toContain('NEEDS_SUDO: ${{ matrix.sudo }}');
    expect(body).toMatch(/sudo FLEET_TEST_SYSTEM_USERS=1 bash deploy\/test\/run\.sh "\$\{args\[@\]\}"/);
    expect(body).toMatch(/^\s+bash deploy\/test\/run\.sh "\$\{args\[@\]\}"$/m);
    expect(body).not.toMatch(/deploy\/test\/run\.sh\s*$/m); // 不带参数跑全套的老写法没了
    // 跑测试那一步整个块里不许再有 if:（原来写着 deploy == 'all'，ops 那台就被跳过）
    const stepAt = body.indexOf('name: deploy 检查');
    expect(stepAt).toBeGreaterThan(-1);
    expect(body.slice(stepAt)).not.toMatch(/^\s+if:/m);
  });

  it('run.sh：--shard 的台数写错、和 --ops 一起用、认不出的参数，都退出 2（不跑任何一项）', () => {
    // shards.test.sh 在 CI 里真跑这几种（要 bash 和临时目录）：这里只核对它挂着这几条
    const t = readFileSync(join(ROOT, 'deploy/test/shards.test.sh'), 'utf8');
    for (const args of ['--shard 1/2', '--shard 4/3', '--shard 1/3 --ops', '--frobnicate']) {
      expect(t).toContain(args);
    }
    // 每条都核退出码 2、且一项都没跑（判法在 shards.test.sh 的 check() 里）
    expect(t).toContain('check "「$args」退出码" "$RC" 2');
  });
});
