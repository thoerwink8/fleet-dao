// 规则表：认出来的失败 → 按什么梯子处置。每条规则至少有一条样本夹具（test/failure/fixtures/failure-samples.json），
// 夹具说明出处；只有合成样本的规则在夹具测试里点名列出。
//
// 认的顺序是三轮，每轮内按表里的先后：
//   1. 强码：原因码（account_banned、quota_exhausted、TIMEOUT_HEARTBEAT……），含原文里嵌着的 JSON 码——命中即终判；
//   2. 已知原文：上游错误原文（和少数写明读过程记录的规则）；
//   3. 只剩状态码、退出码、信号，或症状码（idle_timeout、not_delivered……）：原文认得出原因时让原文说了算。
// 状态码只在语义稳定时单独定类（401、402、429、5xx）；422 永远不单凭状态码定类（mirasim 用它表示繁忙、断网、
// 没账号十几种情况，GitHub 用它表示请求校验失败）。

import type { Scan } from './scan.ts';

/**
 * 梯子上的一级。等待类（waitShort、wait）落成 retry 动作，记在重试账上。
 * - retry：原路再试，退避翻倍；
 * - waitShort：上游给了等待时间而且不长，原地等到点；没给或太长就跳过；
 * - wait：等到上游给的时刻；没给按规则的默认等待翻倍；要等太久就跳过（落到挂起）。
 */
export type Rung = 'retry' | 'waitShort' | 'wait' | 'swapRoute' | 'swapModel' | 'park';

export interface FailureRule {
  id: string;
  /** 白话名，进原因和驾驶舱。 */
  title: string;
  /** 强码（第 1 轮）。小写。 */
  codes?: readonly string[];
  /** 已知原文（第 2 轮）。不带 g 标志。 */
  text?: RegExp;
  /** 过程记录里的已知句子（第 2 轮）；只收很具体的句子，助手正文里常有错误字样。 */
  transcript?: RegExp;
  /** 第 3 轮。 */
  statuses?: readonly number[];
  exitCodes?: readonly number[];
  signals?: readonly string[];
  /** 症状或结局码（第 3 轮）。小写。 */
  weakCodes?: readonly string[];
  /** 依次尝试，某一级的次数用完就往下走；最后一级总是 park。 */
  ladder: readonly Rung[];
  /** 重试记哪本账：返工（测试红、冲突、没交付）和基础设施处置分开。 */
  budget?: 'infra' | 'rework';
  /** 这条规则最多原路重试几次（和策略上限取小）。 */
  maxRetries?: number;
  /** 退避起点（秒）；不给用策略的。 */
  retryBaseSeconds?: number;
  /** wait 读不出上游时间时，第一次等多久（秒），之后翻倍。 */
  defaultWaitSeconds?: number;
  /** 换路由 / 换模型时避开什么。until：upstream = 上游给的时间（没给用默认冷却），cooldown = 默认冷却，none = 等人处理。 */
  avoid?: { scope: 'route' | 'pool' | 'model'; shared: boolean; until: 'upstream' | 'cooldown' | 'none' };
  /** 命中就报警（挂起总是报警）。 */
  alert?: boolean;
  /** 喂熔断：算不算这条路由的失败。 */
  routeOutcome: 'fail' | 'neutral';
  /** 原路再试时怎么试（接在原因后面）。 */
  hint?: string;
  /** 只认不是 AI 会话的步骤（GitHub 的报错）：AI 渠道报同样的字，说的是它自己的事。 */
  stepsOnly?: true;
}

const TRANSIENT_LADDER: readonly Rung[] = ['retry', 'swapRoute', 'park'];

export const RULES: readonly FailureRule[] = [
  // 在途工作流重放对不上现在的代码：重试只会每轮再撞一次（windsurf-dao#1633）。
  {
    id: 'EN2',
    title: '在途任务和现在的引擎代码对不上',
    codes: ['tmprl1100'],
    text: /TMPRL1100|Nondeterminism error/i,
    ladder: ['park'],
    alert: true,
    routeOutcome: 'neutral',
  },
  // 下面两条是插头「没查成」（packages/adapters/src/judge.ts）：launch_unknown = prompt 发出去了、没等到本次的应答，
  // 会话可能已经在跑；relay_unknown = 会话说做完了、中转账本没读成，上游有没有真干活核实不了，活可能已经交了。
  // 原路重试、换路由都是再起一个会话：同一件活跑两遍、扣两次额度、同一棵树里两个会话。所以只挂起报警，等对账；
  // 是我们没查成，不是路由坏了，不记路由的失败。强码一轮按表的先后认，这两条只排在 EN2（同样只挂起）后面：
  // 原话里常夹着等应答时收到的别的报错（at capacity、overloaded_error、account_banned……），排在繁忙、封号这些规则
  // 后面就会被抢走。
  {
    id: 'ST2',
    title: '起会话没查成，可能已经在跑',
    codes: ['launch_unknown'],
    ladder: ['park'],
    alert: true,
    routeOutcome: 'neutral',
  },
  {
    id: 'DL3',
    title: '中转有没有真干活没查成',
    codes: ['relay_unknown'],
    ladder: ['park'],
    alert: true,
    routeOutcome: 'neutral',
  },
  // 我们自己停的不算失败，也不进路由的失败率（旧系统 236 条 interrupted 里 231 条是自己停的）。
  {
    id: 'OU1',
    title: '我们自己停的，不算失败',
    codes: ['aborted', 'interrupted', 'cancelled', 'canceled'],
    ladder: ['retry', 'park'],
    retryBaseSeconds: 0,
    routeOutcome: 'neutral',
  },
  // 封号：原文还写着「请稍后重试」，照做只会在同一个池里反复撞（2026-09-22 独享号被封，reclaude 实测）。
  {
    id: 'AU1',
    title: '账号被封',
    codes: ['account_banned'],
    text: /当前绑定账号暂不可用|account[_ ]banned/i,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'pool', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'neutral',
  },
  // 余额、欠费、订阅权益：只有花钱才回得来，归人闸。不许自动切到按量计费的路由——那是选路的事。
  {
    id: 'QT2',
    title: '余额不够或订阅不含这项',
    codes: [
      'insufficient_quota',
      'insufficient_balance',
      'insufficient_credits',
      'payment_required',
      'billing_hard_limit_reached',
      'cloud_plan_required',
      'cloud_plan_not_served',
    ],
    text: /payment required|insufficient[_ ](?:balance|credits?|quota|funds)|out of credits|credit balance|exceeded your current quota|billing|余额不足|充值|欠费/i,
    statuses: [402],
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'pool', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'neutral',
  },
  // 按分钟限流几十秒就恢复；当成额度用满去停账号池，一条报错停过一个挂着 28 条路线的池（旧 failure-class 的真实事故）。
  {
    id: 'RL1',
    title: '按分钟限流',
    text: /\bper[ -]?(?:second|minute|min)\b|\b(?:requests?|tokens?) per\b|每(?:秒|分钟)/i,
    ladder: ['wait', 'swapRoute', 'park'],
    maxRetries: 1,
    defaultWaitSeconds: 60,
    avoid: { scope: 'route', shared: true, until: 'upstream' },
    routeOutcome: 'fail',
  },
  // 时间窗额度用满（5 小时、周、月）：换一个账号池；别的池也满了就等到清零（按上游给的时间）。
  {
    id: 'QT1',
    title: '额度用满',
    codes: ['quota_exhausted', 'cloud_exhausted', 'usage_limit_reached', 'usage_limit_exceeded'],
    // 「(not your usage limit)」是 Claude Code 在服务端临时限流时自带的一句，说的恰恰不是额度用满：否定句不认。
    text: /(?<!\bnot (?:your |a |the )?)usage limit|额度已用完|额度用完|额度用尽|quota (?:is )?exhausted|weekly limit|monthly limit|周限|\b5[- ]?hour limit/i,
    ladder: ['swapRoute', 'wait', 'park'],
    defaultWaitSeconds: 900,
    avoid: { scope: 'pool', shared: true, until: 'upstream' },
    routeOutcome: 'neutral',
  },
  // mirasim「自有」档在这台机上没有账号：照原文处方换路由，不是账号失效，不停池。
  {
    id: 'AU4',
    title: '这台机上没有这个执行体的自有账号',
    codes: ['local_no_account'],
    text: /本机没有这个智能体的账号/,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // reclaude 只认 Claude Code 自己的流量；别的客户端穿过去会被上报，攒多了设备被解绑、且不能自己恢复。
  {
    id: 'AU3',
    title: 'reclaude 拒了非 Claude Code 客户端',
    codes: ['non_cc_client'],
    text: /仅支持 Claude Code 客户端/,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // 登录失效要人重新登录；「400 此设备已被解绑」是凭据失效，不是请求不合法。
  {
    id: 'AU2',
    title: '登录失效',
    codes: [
      'device_revoked',
      'auth_required',
      'authentication_error',
      'unauthenticated',
      'invalid_api_key',
      'signed_out',
      'cloud_credential_expired',
      'cloud_credential_stale',
      'mint_refused',
      'local_own_auth_refused',
      'auth',
    ],
    // 只认说「要重新登录」的整句：原文里随便一个带 /login 的网址不能让整个池停下。
    text: /not logged in|please run \/login|重新登录|完成登录|已被解绑|device[_ ]revoked|token (?:has )?expired|invalid (?:x-)?api[ _-]?key|authentication (?:failed|required)|unauthori[sz]ed|unauthenticated/i,
    statuses: [401],
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'pool', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'neutral',
  },
  {
    id: 'RG1',
    title: '所在地区不能用',
    codes: ['cloud_region_unavailable', 'unsupported_country_region_territory'],
    text: /RegionError|not available in your region/i,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // 原文写了处方就照办（盲设计题拍板 D3）：它说换模型就换模型，不在原路重试。
  // 满的是这条路上的这个模型，别的路由上的同一个模型不一定满，所以只这个任务避开。
  {
    id: 'MD2',
    title: '上游让换个模型',
    text: /try a different model/i,
    ladder: ['swapModel', 'park'],
    avoid: { scope: 'model', shared: false, until: 'cooldown' },
    routeOutcome: 'fail',
  },
  // 模型不存在或已下架：这个任务换模型，并报警好把对应路由下线（旧系统巡检判了下架的路线还在派，windsurf-dao#1840）。
  // 常常只是这一条路由的目录里没有它，别的路由上的同一个模型照样能用，所以不让所有任务一起避开这个模型；
  // 这条路由的失败记进熔断，由熔断去下线它。
  {
    id: 'MD1',
    title: '模型不存在或已下架',
    codes: ['model_not_found', 'model_unavailable', 'model_retired', 'unrecognized_model'],
    text: /issue with the selected model|may not exist or you may not have access|absent from the ACP model catalog|model catalog has no match|cannot use this model|model[_ ]not[_ ]found/i,
    ladder: ['swapModel', 'park'],
    avoid: { scope: 'model', shared: false, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // 点名的模型和实际回话的不一样：是这条路由的别名配错了（静默的），换路由比换模型准。
  {
    id: 'MD3',
    title: '回话的模型不是点名的那个',
    codes: ['model_mismatch'],
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // 这条路由在这台机上起不来：版本太旧、工作区信任、参数错、模型名重名、二进制不在……重试不会变，所有任务都会撞。
  {
    id: 'CF1',
    title: '执行方式或路由配置不对',
    codes: ['cli_too_old', 'agent_unconfigured', 'unsupported_capability', 'protocol_mismatch'],
    text: /Workspace Trust|ambiguous across providers|requires --verbose|unexpected argument|unknown option|spawn \S+ (?:ENOENT|EACCES)/i,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: true, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // 提示词拼进命令行参数超了系统上限：只有提示词长的任务撞，别的任务照用这条路由；插头该改成走 stdin 或文件。
  {
    id: 'CF2',
    title: '提示词太长，这条路由的起法塞不下',
    text: /\bE2BIG\b/,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: false, until: 'none' },
    alert: true,
    routeOutcome: 'neutral',
  },
  // 推送身份没有 workflows 权限：换有权限的身份属于改凭据，要人拍（旧系统判成可重试，退避白烧，#1725）。
  {
    id: 'PM1',
    title: '没有权限',
    codes: ['permission_denied', 'workflows_permission'],
    text: /refusing to allow a GitHub App|without [`']?workflows[`']? permission/i,
    ladder: ['park'],
    alert: true,
    routeOutcome: 'neutral',
  },
  {
    id: 'HM1',
    title: '要人拍板或缺配置',
    codes: ['needs_human', 'config_missing'],
    ladder: ['park'],
    alert: true,
    routeOutcome: 'neutral',
  },
  // 无头会话没人批权限：同一会话里会一直被拒（原文自己说了别重试），是这条路由的起法不对。
  {
    id: 'PM2',
    title: '会话里的操作要人批，没人批',
    text: /Permission for this tool use was denied|no approval surface/i,
    transcript: /Permission for this tool use was denied|no approval surface/i,
    ladder: ['swapRoute', 'park'],
    avoid: { scope: 'route', shared: false, until: 'none' },
    alert: true,
    routeOutcome: 'fail',
  },
  // 活动超时、工人重启丢了活动：从检查点重跑，不交人（旧系统落成 UNKNOWN → 没查成 → 等人，fleet 任务 #1608 g1）。
  {
    id: 'EN1',
    title: '引擎这边丢了这一步',
    codes: [
      'timeout_start_to_close',
      'timeout_heartbeat',
      'timeout_schedule_to_close',
      'timeout_schedule_to_start',
      'session_lost',
    ],
    text: /StartToClose timeout|活动随旧进程丢失|worker 部署重启|heartbeat timeout/i,
    ladder: ['retry', 'park'],
    retryBaseSeconds: 5,
    routeOutcome: 'neutral',
    hint: '从检查点接着跑',
  },
  // 下面三条只认不是会话的步骤（开 PR、推分支、查 CI）：AI 渠道报「API rate limit exceeded」说的是它自己限流，
  // 该换路由，不该按 GitHub 限流原地干等。
  // 我方请求数据被 GitHub 校验拒了：重试不会变。不许因为 422 当成平台繁忙。
  {
    id: 'GH1',
    title: 'GitHub 拒了请求数据',
    text: /Validation Failed/i,
    ladder: ['park'],
    alert: true,
    routeOutcome: 'neutral',
    stepsOnly: true,
  },
  // 2026-08-17 GitHub 部分中断时出现过；过几分钟再试，还不行再挂起（也可能真是权限不够）。
  {
    id: 'GH2',
    title: 'GitHub 暂时不让访问',
    text: /Resource not accessible by integration/i,
    ladder: ['wait', 'park'],
    maxRetries: 1,
    defaultWaitSeconds: 300,
    routeOutcome: 'neutral',
    stepsOnly: true,
  },
  // 次级限流：停几分钟、串行，不按主配额的重置时间干等。
  {
    id: 'RL2',
    title: 'GitHub 限流',
    text: /API rate limit exceeded|secondary rate limit/i,
    ladder: ['wait', 'park'],
    defaultWaitSeconds: 300,
    routeOutcome: 'neutral',
    stepsOnly: true,
  },
  // 冲突是必然失败，原地退避没用（windsurf-dao#1595）：同步主线、把冲突交回会话解决，记返工账。
  {
    id: 'MC1',
    title: '合并冲突',
    codes: ['merge_conflict', 'conflicting'],
    text: /mergeable\W{0,3}CONFLICTING|merge conflict|CONFLICT \(content\)|Automatic merge failed/i,
    ladder: ['retry', 'park'],
    budget: 'rework',
    retryBaseSeconds: 0,
    routeOutcome: 'neutral',
    hint: '先同步最新主线再解冲突',
  },
  // 远端分支比本地新：先抓远端、并好再推。原文要留全（旧系统只留 160 字，被拒原因正好截掉）。
  {
    id: 'MC2',
    title: '推送落后于远端',
    codes: ['non_fast_forward'],
    text: /non-fast-forward|\(fetch first\)|Updates were rejected because/i,
    ladder: ['retry', 'park'],
    routeOutcome: 'neutral',
    hint: '先抓远端、并好再推',
  },
  {
    id: 'TS1',
    title: '测试没过',
    codes: ['checks_failed', 'checks-failed', 'tests_failed', 'ci_red', 'ci_failed'],
    text: /契约检查未通过|\bchecks? failed\b|\bTests?\s+\d+\s+failed\b|^# fail [1-9]/im,
    ladder: ['retry', 'park'],
    budget: 'rework',
    retryBaseSeconds: 0,
    routeOutcome: 'neutral',
    hint: '带上失败的测试和输出',
  },
  // 交付没查成（抓取失败、git 出错）是我们查的时候出了事，不是执行体没交活：重查。
  {
    id: 'DL2',
    title: '交付没查成',
    codes: ['delivery_unknown'],
    ladder: ['retry', 'park'],
    routeOutcome: 'neutral',
    hint: '重查交付，不算执行体失败',
  },
  // 被 SIGKILL（多半是内存超限）或被外面停掉：从检查点重起一次；再来就是资源或任务本身的问题，交帅位。
  {
    id: 'KL2',
    title: '进程被信号杀掉',
    codes: ['oom_kill', 'oom_killed'],
    text: /\bSIGKILL\b|oom[-_ ]?kill|out of memory|\bKilled\b/i,
    exitCodes: [137, 143],
    signals: ['SIGKILL', 'SIGTERM'],
    ladder: ['retry', 'park'],
    maxRetries: 1,
    routeOutcome: 'neutral',
    hint: '从检查点重起；多半是内存超限',
  },
  // 会话里的命令跑超时被杀（Claude 的 Bash 默认 2 分钟，插头放宽到 10 分钟）：接着干并提醒它换跑法，再来就交帅位。
  {
    id: 'KL1',
    title: '命令跑超时被杀',
    text: /Command timed out after \d+|\bExit code (?:124|137|143)\b/,
    transcript: /Command timed out after \d+|\bExit code (?:124|137|143)\b/,
    ladder: ['retry', 'park'],
    maxRetries: 1,
    routeOutcome: 'neutral',
    hint: '接着干，提醒它把长命令放后台或缩小范围',
  },
  // 没有工具在跑、又长时间没动静：续一句 → 新会话 → 换模型（旧系统判卡死的依据是 360 秒没推进，windsurf-dao#1499）。
  {
    id: 'SL1',
    title: '会话卡住不动',
    text: /no progress for \d+\s*s\b|turn stalled past|session stalled/i,
    weakCodes: ['idle_timeout', 'stalled', 'session_stalled'],
    ladder: ['retry', 'swapModel', 'park'],
    routeOutcome: 'fail',
    hint: '续一句提醒它，续不上开新会话',
  },
  // 起不来：重起一次，再不行换路由（盲设计题有一臂就这么阵亡：codex initialize timed out）。
  {
    id: 'ST1',
    title: '会话起不来',
    text: /initialize'? timed out|did not accept the session in time|没收到 prompt 的应答帧|没收到 state 帧|did not become ready within|session\/new timed out|迟迟没有第一帧/i,
    weakCodes: ['startup_timeout'],
    ladder: ['retry', 'swapRoute', 'park'],
    maxRetries: 1,
    routeOutcome: 'fail',
  },
  // 总时长到顶：接着上次的进度续一轮；再到顶多半是子任务太大，交帅位去拆。
  {
    id: 'WT1',
    title: '会话总时长到顶',
    weakCodes: ['wall_clock_timeout'],
    ladder: ['retry', 'park'],
    maxRetries: 1,
    routeOutcome: 'neutral',
    hint: '接着上次的进度续一轮',
  },
  {
    id: 'SM1',
    title: '续会话没续上',
    codes: ['session_mismatch'],
    ladder: ['retry', 'park'],
    routeOutcome: 'neutral',
  },
  // 某条路由对一个任务报繁忙，所有任务一起避开它，过一会儿放一个试探（设计第十二节）。
  {
    id: 'BZ1',
    title: '路由繁忙',
    codes: [
      'overloaded',
      'overloaded_error',
      'route_refused',
      'route_busy',
      'capacity',
      'cloud_unavailable',
      'server_overloaded',
    ],
    text: /overloaded|容量已满|at capacity|high demand|繁忙|满载/i,
    statuses: [529],
    ladder: ['swapRoute', 'wait', 'park'],
    defaultWaitSeconds: 60,
    avoid: { scope: 'route', shared: true, until: 'upstream' },
    routeOutcome: 'fail',
  },
  // 没写处方的限流：上游给了不长的等待就原地等一次，否则换路由。
  {
    id: 'RL3',
    title: '限流',
    codes: ['rate_limited', 'rate_limit_error', 'rate_limit_exceeded', 'too_many_requests'],
    text: /rate[ _-]?limit|too many requests|temporarily limiting requests|限流/i,
    statuses: [429],
    ladder: ['waitShort', 'swapRoute', 'wait', 'park'],
    defaultWaitSeconds: 60,
    avoid: { scope: 'route', shared: true, until: 'upstream' },
    routeOutcome: 'fail',
  },
  // 长流半路被掐：续跑同一个会话；不进路由失败率的分母（旧系统据此把一条当天真干出活的路线判死，#1386）。
  {
    id: 'SB1',
    title: '流断了',
    codes: ['incomplete', 'prompt_incomplete'],
    text: /stream disconnected|stream closed before|stream (?:ended|broken)|断流|response ended prematurely/i,
    weakCodes: ['timeout'],
    ladder: TRANSIENT_LADDER,
    routeOutcome: 'neutral',
    hint: '续跑同一个会话',
  },
  // 上游内部错误：「403 Internal error during token generation」是上游的事，不因为 403 停账号池。
  {
    id: 'UP1',
    title: '上游出错',
    codes: ['internal_server_error', 'service_unavailable', 'bad_gateway', 'gateway_timeout'],
    text: /internal error|internal server error|server error|bad gateway|service unavailable|gateway timeout/i,
    statuses: [500, 502, 503, 504],
    weakCodes: ['transient'],
    ladder: TRANSIENT_LADDER,
    routeOutcome: 'fail',
  },
  {
    id: 'NT1',
    title: '网络不通',
    codes: [
      'econnreset',
      'econnrefused',
      'econnaborted',
      'etimedout',
      'epipe',
      'eai_again',
      'enotfound',
      'ehostunreach',
      'enetunreach',
      'transport_closed',
      'cloud_unreachable',
      'network',
    ],
    text: /\bE(?:CONNRESET|CONNREFUSED|CONNABORTED|TIMEDOUT|PIPE|AI_AGAIN|NOTFOUND|HOSTUNREACH|NETUNREACH)\b|socket hang up|fetch failed|connection (?:error|reset|refused|closed)|network error|tcp connect error|deadline has elapsed|error sending request|Reconnecting\.\.\.|waiting for network|Failed to reach|连不上|域名解析|建立连接失败/i,
    ladder: TRANSIENT_LADDER,
    routeOutcome: 'fail',
  },
  {
    id: 'NT2',
    title: '超时',
    // \b 挡住 idle_timeout 这类码：它们是症状码，归第 3 轮。
    text: /\btimed out\b|\btimeout\b/i,
    ladder: TRANSIENT_LADDER,
    routeOutcome: 'fail',
  },
  // 说做完了但没交付（旧系统一次零产出的假完成一路绿到合并，windsurf-dao#1572）：带着缺什么回会话；再犯换模型。
  {
    id: 'DL1',
    title: '说做完了，但没交付',
    weakCodes: ['not_delivered', 'wrong_output'],
    ladder: ['retry', 'swapModel', 'park'],
    budget: 'rework',
    retryBaseSeconds: 0,
    routeOutcome: 'neutral',
    hint: '告诉它缺什么',
  },
  {
    id: 'OU2',
    title: '会话被外面停掉了',
    weakCodes: ['session_stopped'],
    ladder: ['retry', 'park'],
    routeOutcome: 'neutral',
  },
];

export interface RuleHit {
  rule: FailureRule;
  via: 'signal' | 'text' | 'generic';
  /** 命中的那一小段（码、原文片段、状态码）。 */
  hit: string;
}

/** 三轮认：强码 → 已知原文 → 状态码 / 退出码 / 信号 / 症状码。认不出返回 undefined。 */
export function matchRule(scan: Scan, all: readonly FailureRule[] = RULES): RuleHit | undefined {
  const rules = scan.session ? all.filter((r) => !r.stepsOnly) : all;
  for (const rule of rules) {
    const code = rule.codes?.find((c) => scan.codes.has(c));
    if (code) return { rule, via: 'signal', hit: code };
  }
  for (const rule of rules) {
    const text = rule.text?.exec(scan.text)?.[0] ?? rule.transcript?.exec(scan.tail)?.[0];
    if (text) return { rule, via: 'text', hit: text };
  }
  for (const rule of rules) {
    if (scan.status !== undefined && rule.statuses?.includes(scan.status)) {
      return { rule, via: 'generic', hit: `HTTP ${scan.status}` };
    }
    if (scan.exitCode !== undefined && rule.exitCodes?.includes(scan.exitCode)) {
      return { rule, via: 'generic', hit: `退出码 ${scan.exitCode}` };
    }
    if (scan.signal && rule.signals?.includes(scan.signal)) {
      return { rule, via: 'generic', hit: `信号 ${scan.signal}` };
    }
    const weak = rule.weakCodes?.find((c) => scan.codes.has(c));
    if (weak) return { rule, via: 'generic', hit: weak };
  }
  return undefined;
}
