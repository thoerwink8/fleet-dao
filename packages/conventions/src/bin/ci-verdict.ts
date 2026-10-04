// CI 汇总 job（必过检查 check）的入口（.github/workflows/ci.yml，判法在 ../ci-plan.ts 的 ciVerdict）：
//   CI_NEEDS='${{ toJSON(needs) }}' node packages/conventions/src/bin/ci-verdict.ts
// 退出码 0 = 该跑的都跑了且绿、不该跑的都跳过了；1 = 有不对的（逐条列出）；2 = 没拿到 CI_NEEDS 或不是 JSON。
import { ciVerdict } from '../ci-plan.ts';

const text = process.env.CI_NEEDS;
if (!text) {
  console.error('::error::没拿到各 job 的结果（环境变量 CI_NEEDS 是空的）');
  process.exit(2);
}
let needs: unknown;
try {
  needs = JSON.parse(text);
} catch (e) {
  console.error(`::error::CI_NEEDS 不是 JSON（${e instanceof Error ? e.message : String(e)}）`);
  process.exit(2);
}
// CI_EVENT = 这一轮的事件名（github.event_name）：同树复用只有主线推送认；没给不报错（旧调用照旧判），但带复用记录的 plan 会判红
const { ok, lines } = ciVerdict(needs, process.env.CI_EVENT || undefined);
for (const line of lines) (ok ? console.log : console.error)(line);
if (!ok) console.error('::error::CI 没过：上面打 ✗ 的 job 不对');
process.exitCode = ok ? 0 : 1;
