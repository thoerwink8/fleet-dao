// fleet --help 的全部文字。读者是 AI 会话，也是人：一眼看懂每条命令什么时候用、怎么写。
export const MAIN_HELP = `fleet —— 在 fleet 派的会话里，向驾驶舱汇报进度、提问、交活。

用法：fleet <子命令> [参数] [选项]

子命令：
  task                          看自己的任务：需求、做完标准、要改哪里、当前步骤
  plan [步骤…]                  列出或更新步骤清单（整张替换）；不带参数就只看
  say <一句话>                  报一句白话进度，例如「正在写验证码过期的测试」
  ask <问题> -o 选项… -r 推荐   问创始人：一定带选项和推荐，按推荐先做、不停下等回答
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

用法：fleet ask <问题> -o <选项> -o <选项>… -r <推荐的那个> [--outside | --hold <人闸>]

  创始人多半不在场，问他不许卡住活：命令当场返回，不等回答。
  这张单范围内的岔路（默认）：按推荐先做，接着干；他之后改了，下一个存档点会告诉你。交活总结里写上这个假设。
  -o, --option <选项>     备选答案，至少 2 个、最多 4 个
  -r, --recommend <选项>  推荐哪个，照抄其中一个选项（必填）
  --outside               超出这张单的范围：另开一张单等他拍，这张单绕开它接着做
  --hold <人闸>           碰了人闸：release 对外发布、spend 花钱、delete 删数据、standard 改标准。
                          也先按推荐做，合并前等他批
  没带选项、没带推荐的会被后端退回（退出码 4），照提示补齐再问。
  只有他本人才有的东西（账号、权限、登录）不是提问：用 fleet blocked "<缺什么>" --needs access，这一块等他。

  问之前把问题写完整：起因、推荐哪个、为什么。

例子：
  fleet ask "验证码有效期 5 分钟还是 10 分钟？推荐 5 分钟，和短信平台默认一致" -o "5 分钟" -o "10 分钟" -r "5 分钟"
  fleet ask "注册页也要验证码吗？这张单只管登录" -o "要" -o "不要" -r "不要" --outside
  fleet ask "短信平台用哪家？要开按量付费" -o "阿里云" -o "腾讯云" -r "阿里云" --hold spend
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

  后端会核实本次会话真跑过仓的测试命令（起会话时的任务里写着；fleet-dao 是 pnpm test:changed，只跑改动影响到的测试），
  而且最后一次是过的；别的测试命令不算，核实不过会拒收（退出码 4）。
  原样跑，别接管道（例如 pnpm test:changed | tail）、别放后台：退出码不是测试的，结果记成「认不出」，同样拒收。

例子：
  git add -A && git commit -m "登录：验证码 5 分钟过期"
  fleet done "加了验证码过期逻辑和 3 个测试；pnpm test:changed 全绿" --tests passed
`,
  blocked: `fleet blocked —— 报卡住

用法：fleet blocked <原因> --needs human|info|access|other

  --needs 需要什么才能继续：
    access   缺只有创始人本人才有的东西（权限、账号、登录）：这一块等他
    info     缺信息（找不到资料）；要他在几个做法里挑一个的，别用这个，用 fleet ask 带选项和推荐
    human    要人动手的事；要他拍板的用 fleet ask，按推荐先做、不停下
    other    其他
  原因写清卡在哪、试过什么（4000 字以内）。

例子：
  fleet blocked "测试要连短信网关，沙箱里没有测试账号" --needs access
`,
};
