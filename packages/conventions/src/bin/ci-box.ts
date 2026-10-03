// CI test job 里一台测试的两步（.github/workflows/ci.yml，判法在 ../ci-box.ts）：
//   node packages/conventions/src/bin/ci-box.ts files  --box '<toJSON(matrix)>' --out <文件清单写到哪>
//   node packages/conventions/src/bin/ci-box.ts verify --box '<toJSON(matrix)>' --mode '<缓存模式，空=没走缓存>' \
//        [--report <vitest 的 JSON 报告>] [--state <缓存交接文件>]
// files：核对矩阵里这一台（名字、文件清单、两个开关），文件清单一行一个写出来给后面的步骤按数组展开，日志里打出几个文件、估几秒。
// verify：vitest 跑完核对「实际跑的 == 该跑的」（命中缓存的：盖住的 + 跑的 == 分到的），对不上逐条点名。
// 退出码 0 = 对得上；1 = 对不上；2 = 参数不对、矩阵那一份认不出、报告读不出——都不当通过。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseBox, VERIFY_MODES, type VerifyMode, verifyRun } from '../ci-box.ts';
import { passedFiles } from '../ci-cache.ts';

const root = fileURLToPath(new URL('../../../../', import.meta.url));

function bad(why: string): never {
  console.error(`::error::这一台测试没核对成：${why}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
let values: { box?: string; out?: string; report?: string; state?: string; mode?: string };
try {
  values = parseArgs({
    args: rest,
    options: {
      box: { type: 'string' },
      out: { type: 'string' },
      report: { type: 'string' },
      state: { type: 'string' },
      mode: { type: 'string' },
    },
    strict: true,
  }).values;
} catch (e) {
  bad(`参数不对（${e instanceof Error ? e.message : String(e)}）`);
}
if (command !== 'files' && command !== 'verify')
  bad(`认不出的命令：${command ?? '（没给）'}（files 或 verify）`);
if (values.box === undefined) bad('没给 --box（矩阵里这一台）');
const box = parseBox(values.box);
if (typeof box === 'string') bad(box);

/** 读文件；不存在是 undefined，别的读错判红。 */
function read(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    bad(`读不了 ${path}（${e instanceof Error ? e.message : String(e)}）`);
  }
}

if (command === 'files') {
  if (values.out === undefined) bad('files 要给 --out（文件清单写到哪）');
  try {
    writeFileSync(values.out, `${box.files.join('\n')}\n`);
  } catch (e) {
    bad(`写不进 ${values.out}（${e instanceof Error ? e.message : String(e)}）`);
  }
  const extras = [box.pg ? '起 Postgres' : '', box.temporal ? '装 Temporal 命令行' : ''].filter(Boolean);
  console.log(
    `这一台（${box.label}）分到 ${box.files.length} 个测试文件，按耗时表估 ${Math.round(box.estMs / 1000)} 秒（耗时合计，并行跑墙钟约一半）${extras.length > 0 ? `；${extras.join('、')}` : ''}`,
  );
  for (const f of box.files) console.log(`  ${f}`);
} else {
  const mode = values.mode ?? '';
  if (!(VERIFY_MODES as readonly string[]).includes(mode)) bad(`认不出的缓存模式「${mode}」`);
  let reported: Set<string> | undefined;
  const reportText = read(values.report);
  if (reportText !== undefined) {
    const r = passedFiles(reportText, root);
    if (typeof r === 'string') bad(r);
    reported = r.reported;
  }
  const result = verifyRun({
    assigned: box.files,
    mode: mode as VerifyMode,
    reported,
    stateText: read(values.state),
  });
  for (const line of result.problems) console.error(`::error::${box.label}：${line}`);
  for (const line of result.lines) console.log(line);
  process.exitCode = result.ok ? 0 : 1;
}
