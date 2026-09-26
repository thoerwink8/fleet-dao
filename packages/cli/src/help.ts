// fleet --help 的全部文字。读者是 AI 会话，也是人：一眼看懂每条命令什么时候用、怎么写。（临时 CI 实测）
export const MAIN_HELP = `fleet —— 在 fleet 派的会话里，向驾驶舱汇报进度、提问、交活。

用法：fleet <子命令> [参数] [选项]

子命令：
  task                          看自己的任务：需求、做完标准、要改哪里、当前步骤
  plan [步骤…]                  列出或更新步骤清单（整张替换）；不带参数就只看
  say <一句话>                  报一句白话进度，例如「正在写验证码过期的测试」
  ask <问题> [-o 选项]…         问创始人；默认等回答，等不到先按写明的假设继续
  history <关键词> [-n 条数]    翻做过的需求和结果，开新活之前先查
  done <总结> --tests passed|failed
                                交活：改动先在本地提交；推分支、开 PR 由引擎做。后端会核实
  blocked <原因> --needs human|info|access|other
                                报卡住：卡在哪、需要什么

选项：
  --json       输出后端的原始 JSON
  -h, --help   看说明；fleet <子命令> --help 看这个子命令的详细用法和例子

环境变量（引擎起会话时给好，不用自己设）：
  FLEET_API    后端地址
  FLEET_TOKEN  只对本任务这次会话有效的通行证

退出码：
  0  成功
  1  连不上后端或后端出错（已自动重试几次）
  2  用法不对（参数、缺环境变量）
  3  通行证无效或过期：会话已被收回，别再重试
  4  后端拒收（例如交活没通过核实），原因见输出
`;

export const COMMAND_HELP: Record<string, string> = {
  task: `fleet task —— 看自己的任务

用法：fleet task [--json]

  需求原文、做完标准、要改的地方、分支、当前步骤。开工先看一遍。
`,
  plan: `fleet plan —— 列出或更新步骤清单

用法：
  fleet plan                      看当前步骤
  fleet plan <步骤> [<步骤>…]     整张替换步骤清单

每个步骤是一个参数，前面标状态：
  [x] 做完了    [>] 正在做（同一时间最多一步）    [ ] 还没做（不标也算没做）

  用白话写，一步一件事；最多 30 步，每步 200 字以内。
  每开始或做完一步，就把整张清单重报一次。

例子：
  fleet plan "[x] 读需求和相关代码" "[>] 写验证码过期的测试" "[ ] 实现过期逻辑" "[ ] 跑全部测试"
`,
  say: `fleet say —— 报一句进度

用法：fleet say <一句话>

  白话，500 字以内。只说从过程记录里看不出来的事：在想什么、为什么换做法、等什么。

例子：
  fleet say "原方案要改数据库表，换成只改接口层，影响面小"
`,
  ask: `fleet ask —— 问创始人

用法：fleet ask <问题> [-o <选项>]… [--no-wait]

  默认等回答，最多几分钟。等不到会回「还没人回答」：先按你写明的假设继续，交活时在总结里注明。
  -o, --option <选项>   给出备选答案，最多 4 个
  --no-wait             发出去就走，不等回答

  问之前把问题写完整：起因、你倾向哪个、为什么。只问真要人拍板的事。

例子：
  fleet ask "验证码有效期 5 分钟还是 10 分钟？我倾向 5 分钟，和短信平台默认一致" -o "5 分钟" -o "10 分钟"
`,
  history: `fleet history —— 翻做过的需求

用法：fleet history <关键词> [-n <条数>]

  按改动位置和关键词找做过的需求与结果，开新活之前先查一遍。
  -n, --limit <条数>   最多返回几条（1–20，默认 5）

例子：
  fleet history "登录 验证码"
  fleet history packages/api -n 10
`,
  done: `fleet done —— 交活

用法：fleet done <总结> --tests passed|failed

  交活之前，所有改动都在本地 git commit 好：没提交的改动不算交付。
  不用推分支、不用开 PR，会话里也没有推送的凭据——这些由引擎在会话结束后做。
  总结写清做了什么、怎么验证的、还欠什么（4000 字以内）。
  --tests passed|failed   测试有没有全过，必填，如实写

  后端会核实本次会话真跑过测试、而且最后一次是过的；核实不过会拒收（退出码 4）。
  跑测试别接管道（例如 pnpm check | tail）：退出码是管道最后一段的，结果会记成「未知」。

例子：
  git add -A && git commit -m "登录：验证码 5 分钟过期"
  fleet done "加了验证码过期逻辑和 3 个测试；pnpm check 全绿" --tests passed
`,
  blocked: `fleet blocked —— 报卡住

用法：fleet blocked <原因> --needs human|info|access|other

  --needs 需要什么才能继续：
    human    要创始人拍板
    info     缺信息（需求说不清、找不到资料）
    access   缺权限或账号
    other    其他
  原因写清卡在哪、试过什么（4000 字以内）。

例子：
  fleet blocked "测试要连短信网关，沙箱里没有测试账号" --needs access
`,
};
