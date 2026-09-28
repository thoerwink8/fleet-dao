// Cursor CLI 在 Windows 上借道读这份钩子登记（targets.ts 的注释）时，喂给钩子的 stdin 有时带 UTF-8 BOM
// （社区已知的坑，forum.cursor.com「On Windows, Cursor's hook stdin JSON payload includes a UTF-8 BOM…」）：
// Node 的 readFileSync(0,'utf8') 不会替你摘掉，见 agents/hooks/pretool.mjs 的 decide()。两条小拦本身由
// agents/test/rules/pretool.rules.test.ts 钉住；这里只测「打头多一个 BOM 字符」这一件事，不改、不碰那份钉住的规矩。
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
