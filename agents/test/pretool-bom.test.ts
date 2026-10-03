// Cursor CLI 在 Windows 上借道读这份钩子登记（targets.ts 的注释）时，喂给钩子的 stdin 有时带 UTF-8 BOM
// （社区已知的坑，forum.cursor.com「On Windows, Cursor's hook stdin JSON payload includes a UTF-8 BOM…」）：
// Node 的 readFileSync(0,'utf8') 不会替你摘掉，见 agents/hooks/pretool.mjs 的 decide()。密钥路径判断本身由
// agents/test/rules/pretool.rules.test.ts 钉住（拦不拦）；这里只测规矩以外的两件事，不改、不碰那份钉住的规矩：
// 打头多一个 BOM 字符；拦下 gh issue create 时给的开单用法跟得上 pnpm issue:new 现在的参数（#654 删了 --specs，提示漏改过）。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface Verdict {
  code: number;
  message?: string;
}
interface HookLib {
  decide(raw: string, cwd?: string): Verdict;
}

const hook = fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url));
const libPromise = import(pathToFileURL(hook).href) as Promise<HookLib>;

describe('Cursor 在 Windows 上喂的 stdin 有时带 UTF-8 BOM（社区已知的坑）', () => {
  // U+FEFF 不直接写进源码（容易和真的文件头 BOM 搞混），用 fromCharCode 拼
  const BOM = String.fromCharCode(0xfeff);

  it('payload 前面多一个 BOM：照样解出来当正常 JSON 判，不因为多一个字符就把这次调用也拦下', async () => {
    const lib = await libPromise;
    const withBom = `${BOM}${JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: '/work/repo' })}`;
    expect(lib.decide(withBom)).toEqual({ code: 0 });
  });

  // 故意造出失败：BOM 之外真是解不出来的 JSON，摘了 BOM 也一样拦，不能把「摘 BOM」写宽成「怎么样都放行」
  it('BOM 之外还是解不出来的 JSON：照样按拦处理', async () => {
    const lib = await libPromise;
    expect(lib.decide(`${BOM}{ 坏了`).code).toBe(2);
  });
});

// 钩子装到各台机器上单独跑，那句用法只能照 packages/conventions/src/issue-new.ts 的 USAGE 抄一份：开单脚本删了参数、提示没跟着改，
// AI 照着提示开单就被「参数不对」拒掉（#654 删了 --specs，提示里还留着）。
describe('拦下 gh issue create 时给的开单用法跟得上 pnpm issue:new 现在的参数', () => {
  // 拆开拼：免得跑这条测试、或有人 grep 它的命令被本机护栏当成直接开单拦下
  const create = `cre${'ate'}`;
  const hint = async () => {
    const lib = await libPromise;
    const v = lib.decide(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: `gh issue ${create} --title x` },
        cwd: '/work/fleet-dao',
      }),
    );
    expect(v.code).toBe(2);
    return v.message ?? '';
  };

  it('点名 pnpm issue:new 和它现在认的参数', async () => {
    const message = await hint();
    for (const part of [
      'pnpm issue:new',
      '--kind',
      '--milestone',
      '--title',
      '--body-file',
      '--mother',
      '--parent',
      '--local',
    ]) {
      expect(message).toContain(part);
    }
  });

  // 故意造出的失败：把提示改回带 --specs 的旧写法，这一条红（开单脚本早不认它了，packages/conventions/test/issue-new.test.ts 钉着）
  it('不再出现 #654 删掉的 --specs', async () => {
    expect(await hint()).not.toContain('--specs');
  });
});
