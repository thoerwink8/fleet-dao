// Windows：把一个参数转义成 cmd.exe 这层和目标程序自己的 argv 解析都能还原成原样的样子。算法出处
// https://qntm.org/cmd（cross-spawn 等主流工具用的就是这套）。pnpm 在这台是 npm 装的 .cmd 套壳，
// spawnSync 不给 shell:true 就 ENOENT，给了又不转义，所以发版车走这里。单元测试：agents/test/windows-quote.test.ts。
export function windowsQuoteArg(arg) {
  let s = String(arg);
  s = s.replace(/(\\*)"/g, '$1$1\\"'); // 反斜杠后面跟双引号：反斜杠数量翻倍，再加一个转义的引号
  s = s.replace(/(\\*)$/, '$1$1'); // 结尾的反斜杠：数量翻倍（后面要接右引号，不能被吞掉）
  s = `"${s}"`;
  s = s.replace(/[()%!^"<>&|]/g, '^$&'); // cmd.exe 自己认的特殊字符，全加 ^ 转义（哪怕在双引号里也要）
  return s;
}

/** command 和 args 拼成一条 cmd.exe 能吃的命令行，外面再包一层引号（让 cmd 的 /C 剥掉这一层，不误伤里面）。 */
export function windowsCmdLine(command, args) {
  const inner = [windowsQuoteArg(command), ...args.map(windowsQuoteArg)].join(' ');
  return `"${inner}"`;
}
