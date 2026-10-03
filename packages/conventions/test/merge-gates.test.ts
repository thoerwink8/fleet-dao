import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type ChangedFile,
  checkSecondOpinion,
  DESCRIPTION_MAX,
  destructiveIn,
  parseRiskPaths,
  type RiskPath,
  riskyFiles,
  secondOpinionFrom,
  statusDescription,
} from '../src/merge-gates.ts';

const HEAD = 'a'.repeat(40);

const changed = (filename: string, status = 'modified', over: Partial<ChangedFile> = {}): ChangedFile => ({
  filename,
  status,
  ...over,
});

/** 对公网开口子和提权的生产配置：部署脚本 CI 绿就合之后，deploy/ 里只有这几份还要先审（design 第五节）。 */
const EXPOSURE_CONFIGS = [
  'deploy/france/fleet-dao.nft',
  'deploy/france/fleet-firewall.service',
  'deploy/france/sudoers-fleet-dao',
  'deploy/hk/nginx-http.conf',
  'deploy/hk/nginx-https.conf',
];

describe('高风险路径清单', () => {
  const list: RiskPath[] = [
    { path: 'packages/db/migrations/', kind: '改数据库', why: '真库', mode: 'migrations' },
    { path: 'deploy/', kind: '碰安全', why: '真机' },
    { path: 'packages/api/src/auth.ts', kind: '碰安全', why: '登录' },
  ];

  it('仓里那份认得出：每条有理由、指的路径都在；引擎代码和部署脚本不在里面，对公网开口子和提权的 5 份生产配置在', () => {
    const text = readFileSync(new URL('../high-risk-paths.json', import.meta.url), 'utf8');
    const parsed = parseRiskPaths(text);
    if (typeof parsed === 'string') throw new Error(parsed);
    const root = new URL('../../../', import.meta.url);
    for (const r of parsed) expect(existsSync(new URL(r.path, root)), r.path).toBe(true);
    const paths = parsed.map((r) => r.path);
    for (const must of [
      'packages/db/migrations/',
      'packages/hygiene/',
      'packages/api/src/auth.ts',
      ...EXPOSURE_CONFIGS,
    ]) {
      expect(paths).toContain(must);
    }
    expect(paths.filter((p) => p.startsWith('packages/engine/'))).toEqual([]);
    // 创始人 2026-09-26 下午拍：部署脚本 CI 绿就合（design 第五节）；整个 deploy/ 加回来就又全挡住了
    expect(paths).not.toContain('deploy/');
    expect(
      riskyFiles(
        [changed('deploy/france.sh'), changed('deploy/release.sh'), changed('deploy/hk.sh')],
        parsed,
      ),
    ).toEqual([]);
    for (const f of EXPOSURE_CONFIGS)
      expect(riskyFiles([changed(f)], parsed), f).toEqual([{ file: f, rule: f, kind: '碰安全' }]);
  });

  it('合并闸决定结论的判法都在清单里：从入口顺着相对导入走一遍，每个文件都得落进清单（漏一个，PR 改它就能放松门槛）；只给报错加格式的 pr-fields 不走进去', () => {
    const parsed = parseRiskPaths(readFileSync(new URL('../high-risk-paths.json', import.meta.url), 'utf8'));
    if (typeof parsed === 'string') throw new Error(parsed);
    const root = new URL('../../../', import.meta.url);
    const todo = ['packages/conventions/src/bin/merge-gate.ts'];
    const seen = new Set<string>();
    // 入口只借 pr-fields.ts 的 annotation 给 Actions 报错加格式：它改不了结论
    const reminderOnly = new Set(['packages/conventions/src/pr-fields.ts']);
    while (todo.length > 0) {
      const rel = todo.pop() as string;
      if (seen.has(rel) || reminderOnly.has(rel)) continue;
      seen.add(rel);
      const text = readFileSync(new URL(rel, root), 'utf8');
      for (const m of text.matchAll(/from '(\.{1,2}\/[^']+)'/g)) {
        todo.push(new URL(m[1] as string, new URL(rel, root)).href.slice(root.href.length));
      }
    }
    expect(seen.size).toBeGreaterThanOrEqual(4); // 一个都没走到，下面那条就成了拿空的去比
    const missing = [...seen].filter((rel) => riskyFiles([changed(rel)], parsed).length === 0);
    expect(missing).toEqual([]);
  });

  it('目录按前缀、文件按全名比；改名的旧名字也算', () => {
    expect(
      riskyFiles(
        [
          changed('deploy/france.sh'),
          changed('packages/db/src/x.ts'),
          changed('packages/api/src/auth.ts'),
          changed('docs/deploy/x.md'),
          changed('scripts/old.sh', 'renamed', { previous: 'deploy/old.sh' }),
        ],
        list,
      ),
    ).toEqual([
      { file: 'deploy/france.sh', rule: 'deploy/', kind: '碰安全' },
      { file: 'packages/api/src/auth.ts', rule: 'packages/api/src/auth.ts', kind: '碰安全' },
      { file: 'deploy/old.sh', rule: 'deploy/', kind: '碰安全' },
    ]);
  });

  it('迁移：新迁移只建表、加列、建索引不算；改删已有的迁移、新迁移里删改已有东西、看不到内容都算；meta/ 不单算', () => {
    const add = (sql: string) =>
      changed('packages/db/migrations/0009_x.sql', 'added', {
        patch: `@@ -0,0 +1,3 @@\n${sql
          .split('\n')
          .map((l) => `+${l}`)
          .join('\n')}`,
      });
    const create = [
      'CREATE TABLE "x" ("id" text PRIMARY KEY);',
      '-- 顺手说一句：以后可能 DROP TABLE 旧表',
      'ALTER TABLE "tasks" ADD COLUMN "note" text;',
      'ALTER TABLE "x" ADD CONSTRAINT "x_fk" FOREIGN KEY ("id") REFERENCES "tasks"("id");',
      'CREATE INDEX "x_idx" ON "x" ("id");',
      'CREATE FUNCTION f() RETURNS trigger AS $$ BEGIN DELETE FROM x; RETURN NEW; END; $$ LANGUAGE plpgsql;',
      'CREATE TRIGGER t AFTER INSERT ON "x" FOR EACH ROW EXECUTE FUNCTION f();',
      'ALTER TABLE "x"',
      '  ADD COLUMN "a" text,',
      `  ADD CONSTRAINT "c" CHECK ("a" in ('p', 'q'));`,
    ].join('\n');
    expect(riskyFiles([add(create), changed('packages/db/migrations/meta/_journal.json')], list)).toEqual([]);
    // IF NOT EXISTS、带 schema 名、CONCURRENTLY 这类只加不改的写法照样放行
    const ifNotExists = [
      'CREATE TABLE IF NOT EXISTS "public"."y" ("id" int);',
      'CREATE INDEX IF NOT EXISTS "y_idx" ON "y" ("id");',
      'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "y_u" ON "y" ("id");',
      'ALTER TABLE "public"."y" ADD COLUMN IF NOT EXISTS "a" text;',
      'CREATE SEQUENCE IF NOT EXISTS s;',
      'CREATE EXTENSION IF NOT EXISTS pgcrypto;',
    ].join('\n');
    expect(riskyFiles([add(ifNotExists)], list)).toEqual([]);
    // DO 块里什么都能跑：不放行
    expect(riskyFiles([add('DO $$ BEGIN DELETE FROM x; END $$;')], list)[0]?.note).toMatch(/^有「DO/);

    const hit = (f: ChangedFile) => riskyFiles([f], list)[0]?.note;
    expect(hit(add('ALTER TABLE "tasks" DROP COLUMN "note";'))).toBe('有「ALTER TABLE "TASKS" DROP」');
    expect(hit(add('drop table "old";'))).toBe('有「DROP TABLE "OLD"」');
    expect(hit(add('DELETE FROM "tasks" WHERE true;'))).toBe('有「DELETE FROM "TASKS" WHERE」');
    expect(hit(add('UPDATE "tasks" SET "x" = 1;'))).toBe('有「UPDATE "TASKS" SET "X"」');
    expect(hit(add('ALTER TABLE "tasks" ALTER COLUMN "x" SET NOT NULL;'))).toMatch(
      /^有「ALTER TABLE "TASKS" ALTER」/,
    );
    expect(hit(add('ALTER TABLE "a" RENAME TO "b";'))).toMatch(/^有「ALTER TABLE "A" RENAME」/);
    // 跨行、省掉关键字、和加列混在一个 ALTER 里、跟在注释和建表后面的，都认得出
    expect(hit(add('UPDATE\n  "tasks"\nSET "x" = 1;'))).toBe('有「UPDATE "TASKS" SET "X"」');
    expect(hit(add('ALTER TABLE "t" ALTER "x" TYPE int;'))).toMatch(/^有「ALTER TABLE "T" ALTER/);
    expect(hit(add('ALTER TABLE "t" DROP "x";'))).toMatch(/^有「ALTER TABLE "T" DROP/);
    expect(hit(add('ALTER TABLE "t" ADD COLUMN "a" text, DROP COLUMN "b";'))).toMatch(/^有「ALTER TABLE/);
    expect(hit(add('CREATE TABLE "y" ("id" int); -- 建表\nTRUNCATE "tasks";'))).toBe(
      '有「TRUNCATE "TASKS"」',
    );
    expect(hit(add('CREATE TABLE "y" ("id" int);\nDROP TRIGGER t ON "x";'))).toMatch(
      /^有「DROP TRIGGER T ON/,
    );
    // 替换、删掉已有的函数、视图、触发器也算改
    expect(hit(add('CREATE OR REPLACE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql;'))).toMatch(
      /^有「CREATE OR REPLACE FUNCTION/,
    );
    expect(hit(add('CREATE OR REPLACE VIEW v AS SELECT 1;'))).toMatch(/^有「CREATE OR REPLACE VIEW/);
    expect(hit(add('DROP TRIGGER IF EXISTS t ON "x";'))).toMatch(/^有「DROP TRIGGER IF EXISTS/);
    expect(hit(changed('packages/db/migrations/0009_x.sql', 'added'))).toBe('看不到改动内容');
    expect(hit(changed('packages/db/migrations/0003_catalog.sql'))).toBe('改了已有的迁移');
    expect(hit(changed('packages/db/migrations/0003_catalog.sql', 'removed'))).toBe('删了已有的迁移');
    expect(destructiveIn('+++ b/x.sql\n-DROP TABLE "was_there";\n+CREATE TABLE "y" ();')).toBeUndefined();
  });

  it('故意坏掉的清单：不是 JSON、没有 paths、空的、缺字段、种类不对、缺理由、mode 不对、路径往外跳，都说为什么（调用方判没查成）', () => {
    const one = (item: unknown) => parseRiskPaths(JSON.stringify({ paths: [item] }));
    expect(parseRiskPaths('{坏')).toMatch(/^不是合法的 JSON/);
    expect(parseRiskPaths('{}')).toBe('没有 paths 列表');
    expect(parseRiskPaths('{"paths":[]}')).toBe('paths 是空的（一条都没有等于什么都不拦）');
    expect(one({ path: 'deploy/' })).toBe('paths 第 1 条 认不出（要有 path、kind、why 三个字符串）');
    expect(one({ path: 'deploy/', kind: '引擎核心', why: 'x' })).toBe(
      'paths 第 1 条（deploy/）的 kind「引擎核心」不是「改数据库」「碰安全」之一',
    );
    expect(one({ path: 'deploy/', kind: '碰安全', why: ' ' })).toBe('paths 第 1 条（deploy/）没写为什么');
    expect(one({ path: 'x.sql', kind: '改数据库', why: 'x', mode: 'migrations' })).toMatch(/mode 认不出/);
    expect(one({ path: 'db/', kind: '改数据库', why: 'x', mode: 'sql' })).toMatch(/mode 认不出/);
    for (const bad of ['/etc/', '../x', '']) {
      expect(one({ path: bad, kind: '碰安全', why: 'x' })).toMatch(/不是仓内相对路径/);
    }
  });
});

describe('工作流按内容判（ci.yml：只有碰到信任的改动才要第二意见）', () => {
  const list = [
    { path: '.github/workflows/', kind: '碰安全', why: '令牌权限' },
    { path: '.github/workflows/ci.yml', kind: '碰安全', why: '内容判', mode: 'workflow' },
  ] as RiskPath[];
  const patchOf = (...lines: string[]) => ['@@ -1,3 +1,3 @@', ' 上下文', ...lines].join('\n');
  const verdict = (patch: string | undefined, file = '.github/workflows/ci.yml', status = 'modified') =>
    riskyFiles([changed(file, status, patch === undefined ? {} : { patch })], list);

  it('改分台、并行、超时、缓存、步骤顺序、注释：不用审（这是提速改动的常态）', () => {
    expect(verdict(patchOf('-    timeout-minutes: 10', '+    timeout-minutes: 15'))).toEqual([]);
    expect(verdict(patchOf('-        max-parallel: 3', '+        max-parallel: 6'))).toEqual([]);
    expect(
      verdict(
        patchOf(
          '-      - name: 旧名字',
          '+      - name: 新名字',
          '-          key: a-v1',
          '+          key: a-v2',
        ),
      ),
    ).toEqual([]);
    // 只加不删：新加一步、新加一个并行任务，放松不了已有的检查
    expect(
      verdict(patchOf('+      - run: pnpm exec vitest run packages/web/', '+      - run: node a.ts &')),
    ).toEqual([]);
    expect(
      verdict(patchOf('+      - run: pnpm exec vitest run packages/db/', '+      # 只加注释和一步命令')),
    ).toEqual([]);
    expect(verdict(patchOf('-      # 旧注释里提到 permissions 和 secrets.', '+      # 新注释'))).toEqual([]);
    expect(verdict(patchOf('+++ b/x', '--- a/x'))).toEqual([]);
  });

  it('行尾注释不算内容（只改超时、行尾写「# permissions 不变」不该被拦）；但 # 在引号字符串里就不是注释', () => {
    expect(verdict(patchOf('+    timeout-minutes: 15 # permissions 不变'))).toEqual([]);
    expect(verdict(patchOf('+    timeout-minutes: 15   # 没碰 secrets. 也没碰 uses:'))).toEqual([]);
    // 【故意造出的失败】# 在引号里：后面的 secrets. 不能被当成注释藏起来
    expect(verdict(patchOf('+        run: echo " # " && echo ${{ secrets.X }}'))).toHaveLength(1);
    expect(verdict(patchOf("+        run: echo ' # ' && echo ${{ secrets.X }}"))).toHaveLength(1);
    // 注释前面本来就碰信任：照拦
    expect(verdict(patchOf('+  contents: write # 只给读'))).toHaveLength(1);
  });

  it('【故意造出的失败】碰到信任的每一类都要审：权限、令牌、触发、action、卫生检查和合并闸、放过失败、条件、汇总依赖、整个 job', () => {
    const touches: [string, string][] = [
      ['+  contents: write', '权限'],
      ['+permissions: write-all', '权限'],
      ['+  security-events: write', '权限'],
      ['+      - edited', '列表项'],
      ['+      - main', '列表项'],
      ["+      - '**'", '列表项'],
      ['+      - docs/**', '列表项'],
      ['+  attestations: write', '权限'],
      ['+  schedule:', '触发条件'],
      ['+    - cron: "0 * * * *"', '触发条件'],
      ['+  workflow_dispatch:', '触发条件'],
      ['+  workflow_call:', '触发条件'],
      ['+  issue_comment:', '触发条件'],
      ['+        env: ${{ secrets.X }}', '令牌或密钥'],
      ['+          GH_TOKEN: ${{ github.token }}', '令牌或密钥'],
      ['-          persist-credentials: false', '令牌或密钥'],
      ['+  pull_request_target:', '触发条件'],
      ['-    types: [opened, synchronize]', '触发条件'],
      ['+      - uses: some/action@v1', '用到的 action'],
      ['+      "uses": some/action@v1', '用到的 action'],
      ["+  'permissions': write-all", '权限'],
      ['+  "contents": write', '权限'],
      ['+      - "uses": x/y@v1', '用到的 action'],
      ['-      - uses: actions/checkout@v4', '用到的 action'],
      ['-      TRUSTED: ${{ github.workspace }}/trusted', '卫生检查或合并闸'],
      ['+      - name: 卫生检查', '卫生检查或合并闸'],
      ['+        continue-on-error: true', '放过失败'],
      ['+        run: pnpm test || true', '放过失败'],
      ['+        if: always()', '检查跑不跑的条件'],
      ["+        if: github.event_name == 'push'", '检查跑不跑的条件'],
      ["-        if: needs.changes.outputs.tests == 'true'", '检查跑不跑的条件'],
      ['+        if: false', '检查跑不跑的条件'],
      ['+    runs-on: self-hosted', '跑在哪台机器上'],
      ['+    runs-on: ubuntu-latest-16-cores', '跑在哪台机器上'],
      ['-        run: pnpm exec vitest run packages/db/', '删了或改了已有的行'],
      ['-        run: pnpm exec biome check .', '删了或改了已有的行'],
      ['-          bash deploy/test/run.sh "${args[@]}"', '删了或改了已有的行'],
      ['-      - run: pnpm --filter ./packages/web run build:demo', '删了或改了已有的行'],
      ['-        run: echo 跑一步别的', '删了或改了已有的行'],
      ['-        shard: [1, 2, 3]', '删了或改了已有的行'],
      ['-          path: pr', '删了或改了已有的行'],
      ['-          cache: pnpm', '删了或改了已有的行'],
      ['+        if: >-', '检查跑不跑的条件'],
      ["+          github.event_name == 'push' && matrix.x", '检查跑不跑的条件'],
      ['+          failure() || cancelled()', '检查跑不跑的条件'],
      ['+    needs: [changes, lint]', '汇总、依赖'],
      ['-        run: node packages/conventions/src/bin/ci-verdict.ts', '汇总、依赖'],
      ['+        CI_NEEDS: ${{ toJSON(needs) }}', '汇总、依赖'],
      ['-  web:', '整个 job 的增删'],
      ['+  newjob:', '整个 job 的增删'],
    ];
    for (const [line, what] of touches) {
      const hits = verdict(patchOf(line));
      expect(hits, line).toHaveLength(1);
      expect(hits[0]?.note, line).toContain(what);
      expect(hits[0]?.kind).toBe('碰安全');
    }
  });

  it('【故意造出的失败】看不到改动内容、新加、删掉、改名：都算（整个文件都是新的信任面）', () => {
    expect(verdict(undefined)[0]?.note).toBe('看不到改动内容');
    expect(verdict(patchOf('+x'), '.github/workflows/ci.yml', 'added')[0]?.note).toContain('新加');
    expect(verdict(patchOf('-x'), '.github/workflows/ci.yml', 'removed')[0]?.note).toContain('被删');
    const renamed = riskyFiles(
      [changed('x/ci.yml', 'renamed', { previous: '.github/workflows/ci.yml', patch: patchOf('+x') })],
      list,
    );
    expect(renamed.map((h) => h.file)).toEqual(['.github/workflows/ci.yml']);
  });

  it('同目录的别的工作流（合并闸自己、定时任务）不受影响：照旧改了就要审；同一文件多条规则认最具体的', () => {
    const other = verdict(
      patchOf('-    timeout-minutes: 10', '+    timeout-minutes: 15'),
      '.github/workflows/merge-gate.yml',
    );
    expect(other).toHaveLength(1);
    expect(other[0]?.rule).toBe('.github/workflows/');
    // 清单里两条顺序反过来，结果一样
    const reversed = [...list].reverse();
    expect(
      riskyFiles(
        [changed('.github/workflows/ci.yml', 'modified', { patch: patchOf('+    timeout-minutes: 3') })],
        reversed,
      ),
    ).toEqual([]);
  });

  it('清单写法：workflow 只能写在单个 .yml 文件上，目录、别的后缀、migrations 写在文件上都读不出', () => {
    const one = (item: unknown) => parseRiskPaths(JSON.stringify({ paths: [item] }));
    expect(
      one({ path: '.github/workflows/ci.yml', kind: '碰安全', why: 'x', mode: 'workflow' }),
    ).toHaveLength(1);
    for (const bad of [
      { path: '.github/workflows/', kind: '碰安全', why: 'x', mode: 'workflow' },
      { path: 'deploy/x.sh', kind: '碰安全', why: 'x', mode: 'workflow' },
      { path: '.github/workflows/ci.yml', kind: '碰安全', why: 'x', mode: 'migrations' },
    ]) {
      expect(one(bad), JSON.stringify(bad)).toMatch(/mode 认不出/);
    }
  });

  it('真清单里 ci.yml 那条在、而且比整个目录那条更具体：只改注释不拦，改权限拦', () => {
    const real = parseRiskPaths(readFileSync(new URL('../high-risk-paths.json', import.meta.url), 'utf8'));
    if (typeof real === 'string') throw new Error(real);
    const f = (patch: string) =>
      riskyFiles([changed('.github/workflows/ci.yml', 'modified', { patch })], real);
    expect(f(patchOf('+      # 只是注释'))).toEqual([]);
    expect(f(patchOf('+  contents: write'))).toHaveLength(1);
    // 合并闸自己的工作流还是整个文件都算
    expect(
      riskyFiles([changed('.github/workflows/merge-gate.yml', 'modified', { patch: patchOf('+# x') })], real),
    ).toHaveLength(1);
  });
});

describe('第二意见状态', () => {
  const status = (state: string, description = '') => ({ context: 'second-opinion', state, description });

  it('从当前头的状态里挑出 second-opinion；没有就是 null', () => {
    expect(secondOpinionFrom([{ context: 'ci', state: 'success' }, status('success', '通过')])).toEqual({
      state: 'success',
      description: '通过',
    });
    expect(secondOpinionFrom([{ context: 'ci', state: 'success' }])).toBeNull();
  });

  it('故意认不出的：没有 context、state 不认得，说为什么', () => {
    expect(secondOpinionFrom([{ state: 'success' }])).toBe('提交状态里有一条认不出（没有 context）');
    expect(secondOpinionFrom([status('ok')])).toBe('second-opinion 的 state「ok」认不出');
  });

  it('没改到先审后合的地方不要第二意见；改到了：通过不报，没有、还在跑、没过各报一句，带上是哪几个文件', () => {
    const hits = riskyFiles(
      [
        { filename: 'packages/db/migrations/0009_x.sql', status: 'added', patch: '+DROP TABLE "old";' },
        { filename: 'deploy/france.sh', status: 'modified' },
      ],
      [
        { path: 'packages/db/migrations/', kind: '改数据库', why: '真库', mode: 'migrations' },
        { path: 'deploy/', kind: '碰安全', why: '真机' },
      ],
    );
    const where =
      '改到了先审后合的地方：packages/db/migrations/0009_x.sql（改数据库：有「DROP TABLE "OLD"」）、deploy/france.sh（碰安全）（清单和理由见 packages/conventions/high-risk-paths.json）';
    expect(checkSecondOpinion(HEAD, null, [])).toEqual([]);
    expect(checkSecondOpinion(HEAD, { state: 'success', description: '' }, hits)).toEqual([]);
    expect(checkSecondOpinion(HEAD, null, hits)).toEqual([
      `等第二意见：当前头 aaaaaaa 上还没有 second-opinion 状态，${where}。第二意见审完写上，合并闸自动重算；推了新提交的，旧头上的不算。`,
    ]);
    expect(checkSecondOpinion(HEAD, { state: 'pending', description: '' }, hits)).toEqual([
      `等第二意见：当前头 aaaaaaa 上的 second-opinion 还在跑（pending），${where}。`,
    ]);
    expect(checkSecondOpinion(HEAD, { state: 'failure', description: '有两条必须改' }, hits)).toEqual([
      `第二意见没过：当前头 aaaaaaa 上的 second-opinion 是 failure：有两条必须改，${where}。按意见改完推上去，对新头重跑第二意见。`,
    ]);
    expect(checkSecondOpinion(HEAD, { state: 'error', description: '' }, hits)[0]).toMatch(/^第二意见没过/);
  });
});

describe('状态说明', () => {
  it('放第一条，多的写另有几条；再长也不超过 GitHub 的 140 个字符', () => {
    expect(statusDescription(['是草稿。'])).toBe('是草稿。');
    expect(statusDescription(['是草稿。', '等第二意见。'])).toBe('是草稿。（另有 1 条，点详情看）');
    const long = statusDescription(['很'.repeat(300), '第二条']);
    expect([...long].length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(long).toMatch(/…（另有 1 条，点详情看）$/);
  });
});
