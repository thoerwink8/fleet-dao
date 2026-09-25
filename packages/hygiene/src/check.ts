// 全仓卫生检查的判定：扫仓库、按白名单放行，给出退出码和要打印的行。命令行入口在 bin/check.ts。
// 退出码：0 = 扫了、名单也读到了、没查出东西；1 = 查出了（或白名单有没写理由的条目）；
// 2 = 没扫全：列文件出错、一个文件都没扫到、清单里缺必有的文件、已知敏感值名单没读到。2 和 1 分得开，「没扫全」不冒充「查过没事」。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ALLOWLIST, type Allow } from './allowlist.ts';
import { formatFinding, listRepoFiles, scanFiles } from './scan.ts';
import { type LoadedValues, loadSensitiveValues } from './values.ts';

export interface CheckOptions {
  root: string;
  list?: (root: string) => string[];
  read?: (path: string) => Buffer;
  allowlist?: readonly Allow[];
  /** 必须在扫描清单里的文件（相对仓库根）：清单里没它，说明列文件那一步就错了，不能当成扫过。 */
  mustInclude?: string;
  /** 已知敏感值名单；不给就按 values.ts 的顺序去找。 */
  values?: LoadedValues;
}

export interface CheckResult {
  code: 0 | 1 | 2;
  lines: string[];
}

export const FIX_HINT =
  '公开仓不放邮箱、公网 IP、私钥、令牌、密码、账号和组织编号，也不放密钥文件（.gitignore 挡着的那几类，git add -f 也不行）。' +
  '真该放行的，加进 packages/hygiene/src/allowlist.ts 并写明理由。';

export function runCheck(options: CheckOptions): CheckResult {
  const list = options.list ?? listRepoFiles;
  const read = options.read ?? ((path: string) => readFileSync(join(options.root, path)));
  const allowlist = options.allowlist ?? ALLOWLIST;
  const loaded = options.values ?? loadSensitiveValues();
  let files: string[];
  try {
    files = list(options.root);
  } catch (e) {
    return {
      code: 2,
      lines: [`卫生检查没扫成：列文件出错（${e instanceof Error ? e.message : String(e)}）`],
    };
  }
  const report = scanFiles(files, read, allowlist, loaded.ok ? loaded.values : []);
  const summary =
    `卫生检查：扫了 ${report.scanned.length} 个文件，查出 ${report.findings.length} 条` +
    `（二进制 ${report.binary.length} 个只按文件名判、工作树里已删的 ${report.missing.length} 个没扫；` +
    `${loaded.ok ? `已知敏感值名单 ${loaded.values.length} 条` : '已知敏感值名单没读到'}）`;
  const problems = [
    ...report.findings.map(formatFinding),
    ...allowlist
      .filter((a) => a.reason.trim().length < 10)
      .map((a) => `白名单这条没写清理由：${a.rule} ${a.path}`),
  ];
  const hints = report.unusedAllows.map(
    (a) => `提示：白名单这条这次一处都没用上，确实不用了就删掉：${a.rule} ${a.path}`,
  );
  const body = [...problems, ...(problems.length > 0 ? [FIX_HINT] : []), ...hints];

  if (report.scanned.length === 0) {
    return { code: 2, lines: [summary, '一个文件都没扫到：这不算干净，先查 git ls-files 为什么没列出东西'] };
  }
  if (options.mustInclude && !report.scanned.includes(options.mustInclude)) {
    return {
      code: 2,
      lines: [summary, `扫描清单里没有 ${options.mustInclude}：列文件那一步错了（仓库根不对？），不算扫过`],
    };
  }
  if (!loaded.ok) {
    return {
      code: 2,
      lines: [
        summary,
        ...body,
        `没扫全：${loaded.reason}。真实的组织编号、账号靠这份名单才认得出，名单没读到不算干净。` +
          '本机放在 ~/.fleet-dao/sensitive-values.txt，或用环境变量 FLEET_SENSITIVE_VALUES_FILE 指过去；CI 读 Actions 密钥 FLEET_SENSITIVE_VALUES。',
      ],
    };
  }
  return { code: problems.length > 0 ? 1 : 0, lines: [summary, ...body] };
}
