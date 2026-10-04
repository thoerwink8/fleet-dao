// pretool.mjs 补 JSDoc 类型（#864）时碰到的一条失败路径：管道那头接着值的远端脚本里，某段命令只剩一个看不清的前缀（比如光秃秃的
// sudo，没有后面的命令），unwrap 回的是 complex、没有叶子命令；checkLine 往下读叶子的名字时会抛 TypeError，上层 secretVerdict 接住、
// 按拦处理，拦下提示里带着那条 TypeError 的原话。类型补上之后这条抛出改成显式写出（missingLeaf），文字不能变：这条测试钉着
// 「照样拦、提示里还是那句」，谁把它改成放行或改了说法，这里会红。
// 命令字符串拆开拼：免得跑这条测试的命令、或者有人 grep 它时，本机的护栏把自己拦下。
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

interface PretoolLib {
  decide(raw: string, fallbackCwd?: string): { code: number; message?: string };
}
const lib = (await import(
  pathToFileURL(fileURLToPath(new URL('../hooks/pretool.mjs', import.meta.url))).href
)) as PretoolLib;

const ETC = `/etc/fleet${'-dao'}`;
const SUDO = `su${'do'}`;
const bash = (command: string) =>
  lib.decide(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: '/work/fleet-dao' }));

describe('管道那头的远端脚本里叶子命令缺失', () => {
  it('【故意造出的失败】拦下（退出码 2），提示里还是原来那句 TypeError 的原话', () => {
    const r = bash(`echo x | ssh box 'X=1 cat ${ETC}/api.env | ${SUDO}'`);
    expect(r.code).toBe(2);
    expect(r.message).toContain("钩子没看懂这条命令（Cannot read properties of undefined (reading 'name')）");
  });

  it('对照：同一条命令里叶子命令齐全时不抛这句（只是普通的拦或放）', () => {
    const r = bash(`echo x | ssh box 'cat ${ETC}/api.env | sha256sum'`);
    expect(r.message ?? '').not.toContain('Cannot read properties');
  });
});
