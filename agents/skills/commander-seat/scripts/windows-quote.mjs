// Windows：把一个参数转义成 cmd.exe 这层和目标程序自己的 argv 解析都能还原成原样的样子。算法出处
// https://qntm.org/cmd（cross-spawn 等主流工具用的就是这套）。单独放一个文件（不放 worker.mjs 里）是因为
// worker.mjs 顶层直接跑 runWorker（有副作用：读 process.argv、真的起子进程），测试没法直接 import 它；
// 这两个函数是 worker.mjs 里唯一带真正算法、不只是转发 io 调用的部分——09-28 靠它们才排出两个真 bug
// （pnpm/grok/codex 在这台都是 npm 装的 .cmd 套壳，spawnSync 不给 shell:true 就 ENOENT；给 shell:true 又是
// Node 自己也警告的「参数只是拼接、没转义」），所以拆出来单独配单元测试（agents/test/worker.test.ts
// 「Windows 引号」那节，golden 值是 09-28 拿真的 pnpm.cmd 和一串刁钻字符跑通之后现算的，不是凭空编的）：
// 有回归就在那测破，不用每次改完再靠真跑 grok 才发现。
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
