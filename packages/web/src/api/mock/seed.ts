// 假数据的初始盘面。时间都相对「现在」生成，打开页面时各种「已 12 分钟」「38 分钟后清零」才说得通。
// 名字、账号都是编的：公开仓里不放真实账号。
import type { RunOutcome, SessionRun, StageKind, Step, SubtaskState, TaskState } from '@fleet-dao/shared';
import type { AuditEntry, Notification, Setting } from '../types';
import type { MAsk, MJob, MLog, MockState, MSubtask, MTask, PlanTemplate } from './model';

const MIN = 60_000;

export function createSeed(now: number): MockState {
  const at = (min: number) => new Date(now + min * MIN).toISOString();
  let seq = 0;
  const id = (prefix: string) => `${prefix}-${++seq}`;

  // ---------- 小工具 ----------
  interface RunSpec {
    task: string;
    sub?: string;
    stage: StageKind;
    route: string;
    why: string;
    /** 进队列的时间（相对现在，分钟）。 */
    queued: number;
    /** 排了几分钟队。 */
    wait?: number;
    /** 干了几分钟；不填表示还在干。 */
    work?: number;
    outcome?: RunOutcome;
    tokens?: [number, number];
  }
  function run(s: RunSpec): SessionRun {
    const r: SessionRun = {
      id: id('run'),
      taskId: s.task,
      stage: s.stage,
      routeId: s.route,
      whyRoute: s.why,
      queuedAt: at(s.queued),
    };
    if (s.sub) r.subtaskId = s.sub;
    const start = s.queued + (s.wait ?? 0.3);
    if (start <= 0) r.startedAt = at(start);
    if (s.work !== undefined) {
      r.endedAt = at(start + s.work);
      r.outcome = s.outcome ?? 'ok';
    }
    if (s.tokens) {
      r.inputTokens = s.tokens[0];
      r.outputTokens = s.tokens[1];
    }
    return r;
  }
  function steps(titles: string[], done: number, active = true): Step[] {
    return titles.map((title, index) => ({
      index,
      title,
      state: index < done ? 'done' : index === done && active ? 'in_progress' : 'pending',
    }));
  }
  interface SubSpec {
    task: string;
    key: string;
    index: number;
    title: string;
    touches: string[];
    deps?: string[];
    state: SubtaskState;
    steps?: Step[];
    runs?: SessionRun[];
    pr?: number;
    say?: [string, number];
  }
  function sub(s: SubSpec): MSubtask {
    const subtask: MSubtask['subtask'] = {
      id: `${s.task}-${s.key}`,
      taskId: s.task,
      index: s.index,
      title: s.title,
      touches: s.touches,
      dependsOn: s.deps ?? [],
      state: s.state,
    };
    if (s.pr) subtask.prNumber = s.pr;
    const v: MSubtask = { subtask, steps: s.steps ?? [], runs: s.runs ?? [], paused: false };
    if (s.say) v.lastSay = { text: s.say[0], at: at(s.say[1]) };
    if (s.steps?.length) v.planUpdatedAt = at(s.say?.[1] ?? -1);
    return v;
  }
  interface TaskSpec {
    id: string;
    repo: string;
    issue: number;
    title: string;
    raw: string;
    by: string;
    state: TaskState;
    priority: number;
    created: number;
    spec?: string;
    runs?: SessionRun[];
    subtasks?: MSubtask[];
    asks?: MAsk[];
  }
  function task(s: TaskSpec): MTask {
    const t: MTask['task'] = {
      id: s.id,
      repoId: s.repo,
      issueNumber: s.issue,
      title: s.title,
      rawRequest: s.raw,
      requestedBy: s.by,
      state: s.state,
      priority: s.priority,
      createdAt: at(s.created),
    };
    if (s.spec) t.specDir = s.spec;
    return { task: t, runs: s.runs ?? [], subtasks: s.subtasks ?? [], paused: false, asks: s.asks ?? [] };
  }
  /** 分诊、需求文档、方案三段需求级会话。 */
  function frontRuns(taskId: string, start: number, planDone = true): SessionRun[] {
    const list = [
      run({
        task: taskId,
        stage: 'triage',
        route: 'r-ca-sonnet',
        why: '分诊阶段排第一',
        queued: start,
        wait: 0.2,
        work: 0.7,
        tokens: [8200, 640],
      }),
      run({
        task: taskId,
        stage: 'spec',
        route: 'r-ca-opus',
        why: '需求文档阶段排第一',
        queued: start + 1,
        wait: 0.3,
        work: 3.4,
        tokens: [21_400, 3100],
      }),
    ];
    if (planDone) {
      list.push(
        run({
          task: taskId,
          stage: 'plan',
          route: 'r-ca-opus',
          why: '方案阶段已钉住，排第一',
          queued: start + 5,
          wait: 0.2,
          work: 6.1,
          tokens: [44_300, 5200],
        }),
      );
    }
    return list;
  }

  // ---------- 需求 ----------
  const tasks: MTask[] = [
    task({
      id: 't-12',
      repo: 'r-orbit',
      issue: 12,
      title: '登录页加手机验证码',
      raw: '给登录页加手机验证码，短信别用按条付费的',
      by: 'u-lan',
      state: 'running',
      priority: 1,
      created: -190,
      spec: 'specs/12-登录验证码',
      runs: frontRuns('t-12', -188),
      asks: [
        {
          id: 'ask-12-1',
          taskId: 't-12',
          question: '验证码几分钟过期？',
          options: ['5 分钟', '10 分钟'],
          askedAt: at(-186),
          answer: '5 分钟',
          answeredBy: 'u-lan',
          answeredAt: at(-184),
        },
      ],
      subtasks: [
        sub({
          task: 't-12',
          key: 'a',
          index: 0,
          title: '验证码接口与限流',
          touches: ['packages/api/src/auth/sms.ts', 'packages/api/src/auth/limit.ts'],
          state: 'merged',
          steps: steps(['读现有登录接口', '写发送与校验接口', '加一分钟限流', '写测试', '开 PR'], 5),
          runs: [
            run({
              task: 't-12',
              sub: 't-12-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一，A 号有空位',
              queued: -176,
              wait: 0.5,
              work: 34,
              tokens: [310_000, 22_400],
            }),
            run({
              task: 't-12',
              sub: 't-12-a',
              stage: 'review',
              route: 'r-grok',
              why: '第二意见换厂商：Grok 4.7',
              queued: -141,
              wait: 0.4,
              work: 6.2,
              tokens: [88_000, 2100],
            }),
          ],
          pr: 31,
          say: ['PR #31 已合并', -128],
        }),
        sub({
          task: 't-12',
          key: 'b',
          index: 1,
          title: '登录页输入框与倒计时',
          touches: ['packages/web/src/routes/login.tsx', 'packages/web/src/components/code-input.tsx'],
          deps: ['t-12-a'],
          state: 'running',
          steps: steps(
            ['读登录页现有代码', '写验证码输入框', '写 60 秒倒计时', '写验证码过期的测试', '跑测试并开 PR'],
            3,
          ),
          runs: [
            run({
              task: 't-12',
              sub: 't-12-b',
              stage: 'ui',
              route: 'r-cb-opus',
              why: 'UI 阶段排第一；GPT 族不接界面活',
              queued: -13,
              wait: 0.7,
            }),
          ],
          say: ['正在写验证码过期的测试', -1.5],
        }),
        sub({
          task: 't-12',
          key: 'c',
          index: 2,
          title: '登录失败的提示文案',
          touches: ['packages/web/src/routes/login.tsx'],
          deps: ['t-12-b'],
          state: 'waiting_deps',
        }),
      ],
    }),
    task({
      id: 't-14',
      repo: 'r-orbit',
      issue: 14,
      title: '支付对账表：每个渠道 × 每一天',
      raw: '对账表要能看到每个渠道每天到账多少、差多少',
      by: 'u-zhou',
      state: 'running',
      priority: 2,
      created: -260,
      spec: 'specs/14-对账表',
      runs: frontRuns('t-14', -258),
      subtasks: [
        sub({
          task: 't-14',
          key: 'a',
          index: 0,
          title: '对账读取：银行卡渠道',
          touches: ['packages/billing/src/card/settle.ts'],
          state: 'verifying',
          steps: steps(['找渠道对账接口', '写读取与解析', '读失败时报警', '写测试', '开 PR'], 5),
          runs: [
            run({
              task: 't-14',
              sub: 't-14-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一，A 号有空位',
              queued: -150,
              wait: 1.2,
              work: 41,
              tokens: [402_000, 30_800],
            }),
            run({
              task: 't-14',
              sub: 't-14-a',
              stage: 'review',
              route: 'r-grok',
              why: '第二意见换厂商：Grok 4.7',
              queued: -4.3,
              wait: 0.3,
            }),
          ],
          pr: 34,
          say: ['PR #34 已开，等第二意见', -4],
        }),
        sub({
          task: 't-14',
          key: 'b',
          index: 1,
          title: '对账读取：钱包渠道',
          touches: ['packages/billing/src/wallet/settle.ts'],
          state: 'running',
          steps: steps(['找到钱包对账文件', '写读取与解析', '读失败时报警', '写测试', '开 PR'], 1),
          runs: [
            run({
              task: 't-14',
              sub: 't-14-b',
              stage: 'execute',
              route: 'r-rl-kimi',
              why: 'Claude A 号 5/5 满；Kimi k3 写码近 7 天成功率 82%，按 10% 试探派给它',
              queued: -31,
              wait: 6.5,
            }),
          ],
          say: ['正在解析钱包对账文件里的金额字段', -2],
        }),
        sub({
          task: 't-14',
          key: 'c',
          index: 2,
          title: '对账表页面',
          touches: ['packages/web/src/routes/reconcile.tsx'],
          state: 'waiting_slot',
        }),
      ],
    }),
    task({
      id: 't-15',
      repo: 'r-orbit',
      issue: 15,
      title: '站内通知 7 天没读就再提醒一次',
      raw: '通知放久了没人看，7 天没读就再提醒一次',
      by: 'u-lan',
      state: 'asking',
      priority: 3,
      created: -95,
      spec: 'specs/15-通知再提醒',
      runs: frontRuns('t-15', -93, false),
      asks: [
        {
          id: 'ask-15-1',
          taskId: 't-15',
          question: '再提醒时，要发一条新消息，还是把旧消息顶上来？顶上来的话列表顺序会变。',
          options: ['发一条新消息', '把旧消息顶上来'],
          askedAt: at(-26),
        },
      ],
    }),
    task({
      id: 't-16',
      repo: 'r-orbit',
      issue: 16,
      title: '商品列表：拖动排序后前台马上按新顺序显示',
      raw: '后台拖完商品顺序，前台要马上生效',
      by: 'u-zhou',
      state: 'planning',
      priority: 4,
      created: -40,
      runs: [
        ...frontRuns('t-16', -38, false),
        run({
          task: 't-16',
          stage: 'plan',
          route: 'r-ca-opus',
          why: '方案阶段已钉住，排第一',
          queued: -5.5,
          wait: 0.4,
        }),
      ],
    }),
    task({
      id: 't-17',
      repo: 'r-orbit',
      issue: 17,
      title: '数据库夜间备份，保留 7 天 + 4 周',
      raw: '数据库每晚备份到异地，加密，留 7 天和 4 周',
      by: 'u-zhou',
      state: 'stalled',
      priority: 5,
      created: -150,
      spec: 'specs/17-夜间备份',
      runs: frontRuns('t-17', -148),
      subtasks: [
        sub({
          task: 't-17',
          key: 'a',
          index: 0,
          title: '备份脚本与加密',
          touches: ['deploy/backup.sh', 'deploy/setup.sh'],
          state: 'stalled',
          steps: steps(['写备份脚本', '加密与传输', '保留策略', '写测试'], 1),
          runs: [
            run({
              task: 't-17',
              sub: 't-17-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一，A 号有空位',
              queued: -64,
              wait: 0.6,
            }),
          ],
          say: ['正在测试 ssh 连备份机的加密传输', -22],
        }),
        sub({
          task: 't-17',
          key: 'b',
          index: 1,
          title: '恢复演练',
          touches: ['deploy/restore.sh'],
          deps: ['t-17-a'],
          state: 'waiting_deps',
        }),
      ],
    }),
    task({
      id: 't-18',
      repo: 'r-orbit',
      issue: 18,
      title: '商品下架后，购物车里的对应商品自动失效',
      raw: '商品下架了购物车要自己标失效，别等结账才发现',
      by: 'u-lan',
      state: 'queued',
      priority: 6,
      created: -12,
    }),
    task({
      id: 't-19',
      repo: 'r-orbit',
      issue: 19,
      title: '部分退款后订单状态回到已发货',
      raw: '部分退款以后订单状态乱了，要回到已发货',
      by: 'u-lan',
      state: 'failed',
      priority: 7,
      created: -210,
      spec: 'specs/19-部分退款',
      runs: frontRuns('t-19', -208),
      subtasks: [
        sub({
          task: 't-19',
          key: 'a',
          index: 0,
          title: '部分退款的状态流转',
          touches: ['packages/api/src/orders/refund.ts'],
          state: 'failed',
          steps: steps(['读退款现有逻辑', '写状态流转', '写测试', '在最新主线上重测'], 4),
          runs: [
            run({
              task: 't-19',
              sub: 't-19-a',
              stage: 'execute',
              route: 'r-rl-opus',
              why: 'A 号满，写码阶段第三条：中转站 · Opus 5.5',
              queued: -120,
              wait: 2.1,
              work: 52,
              outcome: 'failed',
              tokens: [512_000, 41_000],
            }),
          ],
          pr: 36,
          say: ['测试没过，等人决定', -47],
        }),
      ],
    }),
    task({
      id: 't-11',
      repo: 'r-orbit',
      issue: 11,
      title: '支付回调校验签名，漏收的补回来',
      raw: '支付回调要验签，漏了的要能补',
      by: 'u-zhou',
      state: 'done',
      priority: 10,
      created: -420,
      spec: 'specs/11-回调签名',
      runs: frontRuns('t-11', -418),
      subtasks: [
        sub({
          task: 't-11',
          key: 'a',
          index: 0,
          title: '签名校验',
          touches: ['packages/api/src/pay/webhook.ts'],
          state: 'merged',
          steps: steps(['写验签', '写测试', '开 PR'], 3),
          runs: [
            run({
              task: 't-11',
              sub: 't-11-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一',
              queued: -400,
              wait: 0.4,
              work: 28,
              tokens: [220_000, 16_000],
            }),
          ],
          pr: 27,
        }),
        sub({
          task: 't-11',
          key: 'b',
          index: 1,
          title: '漏收补回',
          touches: ['packages/api/src/pay/reconcile.ts'],
          state: 'merged',
          steps: steps(['写轮询补回', '写测试', '开 PR'], 3),
          runs: [
            run({
              task: 't-11',
              sub: 't-11-b',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一',
              queued: -360,
              wait: 0.4,
              work: 47,
              tokens: [380_000, 26_000],
            }),
          ],
          pr: 28,
        }),
      ],
    }),
    task({
      id: 't-20',
      repo: 'r-orbit',
      issue: 20,
      title: '发布 v2.3 到生产',
      raw: 'v2.3 可以上了',
      by: 'u-zhou',
      state: 'merging',
      priority: 8,
      created: -70,
      runs: frontRuns('t-20', -68),
      subtasks: [
        sub({
          task: 't-20',
          key: 'a',
          index: 0,
          title: '打包与上线脚本',
          touches: ['deploy/release.sh'],
          state: 'in_merge_queue',
          steps: steps(['写打包脚本', '写回滚', '跑演练', '开 PR'], 4),
          runs: [
            run({
              task: 't-20',
              sub: 't-20-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一',
              queued: -55,
              wait: 0.5,
              work: 33,
              tokens: [250_000, 18_000],
            }),
            run({
              task: 't-20',
              sub: 't-20-a',
              stage: 'review',
              route: 'r-grok',
              why: '第二意见换厂商',
              queued: -21,
              wait: 0.3,
              work: 9,
              tokens: [70_000, 2000],
            }),
          ],
          pr: 38,
        }),
      ],
    }),
    task({
      id: 't-21',
      repo: 'r-orbit',
      issue: 21,
      title: '巡检：每 6 小时跑一遍下单全流程',
      raw: '加巡检，每 6 小时从下单一直跑到发货',
      by: 'u-lan',
      state: 'triaging',
      priority: 9,
      created: -2,
      runs: [
        run({
          task: 't-21',
          stage: 'triage',
          route: 'r-ca-sonnet',
          why: '分诊阶段排第一',
          queued: -1.6,
          wait: 0.1,
        }),
      ],
    }),
    // ---------- 巡检仓 ----------
    task({
      id: 't-c7',
      repo: 'r-canary',
      issue: 7,
      title: '给 README 加一行当前时间',
      raw: '巡检：给 README 加一行当前时间',
      by: 'u-bot',
      state: 'running',
      priority: 1,
      created: -9,
      runs: [
        run({
          task: 't-c7',
          stage: 'triage',
          route: 'r-ca-sonnet',
          why: '分诊阶段排第一',
          queued: -9,
          wait: 0.1,
          work: 0.4,
        }),
        run({
          task: 't-c7',
          stage: 'plan',
          route: 'r-ca-opus',
          why: '方案阶段已钉住，排第一',
          queued: -8.4,
          wait: 0.2,
          work: 1.5,
        }),
      ],
      subtasks: [
        sub({
          task: 't-c7',
          key: 'a',
          index: 0,
          title: 'README 加时间',
          touches: ['README.md'],
          state: 'running',
          steps: steps(['改 README', '跑测试', '开 PR'], 1),
          runs: [
            run({
              task: 't-c7',
              sub: 't-c7-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一',
              queued: -6.5,
              wait: 0.2,
            }),
          ],
          say: ['正在跑测试', -0.5],
        }),
      ],
    }),
    task({
      id: 't-c6',
      repo: 'r-canary',
      issue: 6,
      title: '给 README 加一行当前时间',
      raw: '巡检：给 README 加一行当前时间',
      by: 'u-bot',
      state: 'done',
      priority: 2,
      created: -372,
      runs: [
        run({
          task: 't-c6',
          stage: 'triage',
          route: 'r-ca-sonnet',
          why: '分诊阶段排第一',
          queued: -372,
          wait: 0.1,
          work: 0.4,
        }),
      ],
      subtasks: [
        sub({
          task: 't-c6',
          key: 'a',
          index: 0,
          title: 'README 加时间',
          touches: ['README.md'],
          state: 'merged',
          steps: steps(['改 README', '跑测试', '开 PR'], 3),
          runs: [
            run({
              task: 't-c6',
              sub: 't-c6-a',
              stage: 'execute',
              route: 'r-ca-opus',
              why: '写码阶段排第一',
              queued: -370,
              wait: 0.2,
              work: 6,
            }),
          ],
          pr: 14,
        }),
      ],
    }),
    // ---------- 官网 ----------
    task({
      id: 't-s3',
      repo: 'r-site',
      issue: 3,
      title: '首页加定价区块',
      raw: '首页加一块定价，三档',
      by: 'u-zhou',
      state: 'running',
      priority: 1,
      created: -80,
      spec: 'specs/3-定价区块',
      runs: frontRuns('t-s3', -78),
      subtasks: [
        sub({
          task: 't-s3',
          key: 'a',
          index: 0,
          title: '定价卡片组件',
          touches: ['src/components/pricing.tsx'],
          state: 'running',
          steps: steps(['读首页结构', '写三档卡片', '手机竖排', '写测试', '开 PR'], 2),
          runs: [
            run({
              task: 't-s3',
              sub: 't-s3-a',
              stage: 'ui',
              route: 'r-rl-opus',
              why: 'B 号满，UI 阶段第二条：中转站 · Opus 5.5',
              queued: -40,
              wait: 3.2,
            }),
          ],
          say: ['正在调手机上的竖排', -3],
        }),
        sub({
          task: 't-s3',
          key: 'b',
          index: 1,
          title: '首页接入定价区块',
          touches: ['src/routes/home.tsx'],
          deps: ['t-s3-a'],
          state: 'waiting_deps',
        }),
      ],
    }),
    task({
      id: 't-s4',
      repo: 'r-site',
      issue: 4,
      title: '移动端导航遮住了标题',
      raw: '手机上导航把标题挡住了',
      by: 'u-lan',
      state: 'done',
      priority: 2,
      created: -300,
      runs: frontRuns('t-s4', -298),
      subtasks: [
        sub({
          task: 't-s4',
          key: 'a',
          index: 0,
          title: '修导航高度',
          touches: ['src/components/nav.tsx'],
          state: 'merged',
          steps: steps(['复现', '改样式', '开 PR'], 3),
          runs: [
            run({
              task: 't-s4',
              sub: 't-s4-a',
              stage: 'ui',
              route: 'r-cb-opus',
              why: 'UI 阶段排第一',
              queued: -285,
              wait: 0.4,
              work: 18,
            }),
          ],
          pr: 9,
        }),
      ],
    }),
    task({
      id: 't-s5',
      repo: 'r-site',
      issue: 5,
      title: '博客列表分页',
      raw: '博客多了，列表要分页',
      by: 'u-zhou',
      state: 'queued',
      priority: 3,
      created: -30,
    }),
  ];

  // ---------- 还没拆出来的子任务 ----------
  const plans: Record<string, PlanTemplate[]> = {
    't-15': [
      {
        title: '到第 7 天再提醒',
        touches: ['packages/notify/src/reminder.ts'],
        stage: 'execute',
        steps: ['读现有通知逻辑', '加第 7 天再提醒', '处理旧消息', '写测试', '开 PR'],
      },
      {
        title: '再提醒的端到端测试',
        touches: ['packages/notify/test/reminder.e2e.ts'],
        stage: 'execute',
        steps: ['用测试账号发一条', '断言提醒已送达', '开 PR'],
      },
    ],
    't-16': [
      {
        title: '保存排序的接口',
        touches: ['packages/api/src/catalog/sort.ts'],
        stage: 'execute',
        steps: ['读商品表结构', '写保存接口', '写测试', '开 PR'],
      },
      {
        title: '前台读新顺序',
        touches: ['packages/web/src/routes/shop.tsx'],
        stage: 'execute',
        steps: ['读前台列表代码', '改成每次读最新', '写测试', '开 PR'],
      },
    ],
    't-18': [
      {
        title: '下架检测',
        touches: ['packages/api/src/catalog/retire.ts'],
        stage: 'execute',
        steps: ['读商品状态', '加下架判断', '写测试', '开 PR'],
      },
      {
        title: '购物车标失效',
        touches: ['packages/api/src/cart/stale.ts'],
        stage: 'execute',
        steps: ['找到购物车表', '下架商品标失效', '推通知', '开 PR'],
      },
    ],
    't-21': [
      {
        title: '巡检流程',
        touches: ['packages/e2e/src/patrol.ts'],
        stage: 'execute',
        steps: ['写定时流程', '在测试店铺下单', '断言每一步', '开 PR'],
      },
      {
        title: '巡检失败报警',
        touches: ['packages/e2e/src/alerts.ts'],
        stage: 'execute',
        steps: ['接报警', '写测试', '开 PR'],
      },
    ],
    't-s5': [
      {
        title: '分页组件',
        touches: ['src/components/pager.tsx'],
        stage: 'ui',
        steps: ['写分页组件', '写测试', '开 PR'],
      },
    ],
  };

  // ---------- 定时任务 ----------
  const jobs: MJob[] = [
    {
      id: 'job-quota',
      name: '额度读取',
      schedule: '每 15 分钟',
      expectEveryMinutes: 15,
      lastRun: { startedAt: at(-4), endedAt: at(-3.9), outcome: 'ok', found: 0 },
      lastSuccessAt: at(-4),
      nextRunAt: at(11),
    },
    {
      id: 'job-watchdog',
      name: '看门狗',
      schedule: '每 5 分钟',
      expectEveryMinutes: 5,
      lastRun: { startedAt: at(-2), endedAt: at(-2), outcome: 'ok', found: 0 },
      lastSuccessAt: at(-2),
      nextRunAt: at(3),
    },
    {
      id: 'job-reconcile',
      name: '每小时对账',
      schedule: '每小时',
      expectEveryMinutes: 60,
      lastRun: {
        startedAt: at(-12),
        endedAt: at(-11.5),
        outcome: 'unscanned',
        why: 'GitHub 接口限流，这次没查成',
      },
      lastSuccessAt: at(-72),
      nextRunAt: at(48),
      keepsFailing: 'unscanned',
    },
    {
      id: 'job-marshal',
      name: 'AI 调度员',
      schedule: '每 30 分钟',
      expectEveryMinutes: 30,
      lastRun: { startedAt: at(-11), endedAt: at(-8), outcome: 'ok', found: 2 },
      lastSuccessAt: at(-8),
      nextRunAt: at(19),
    },
    {
      id: 'job-patrol',
      name: '巡检任务',
      schedule: '每 6 小时',
      expectEveryMinutes: 360,
      lastRun: {
        startedAt: at(-128),
        endedAt: at(-117),
        outcome: 'partial',
        scanned: 12,
        found: 0,
        why: '3 个仓的分支列表没读到',
      },
      lastSuccessAt: at(-117),
      nextRunAt: at(232),
    },
    {
      id: 'job-models',
      name: '模型扫描',
      schedule: '每天 06:00',
      expectEveryMinutes: 1440,
      lastRun: { startedAt: at(-610), endedAt: at(-609), outcome: 'ok', found: 1 },
      lastSuccessAt: at(-609),
      nextRunAt: at(830),
    },
    {
      id: 'job-backup',
      name: '夜间备份',
      schedule: '每天 03:00',
      expectEveryMinutes: 1440,
      lastRun: { startedAt: at(-1500), endedAt: at(-1498), outcome: 'failed', why: 'ssh 连备份机超时' },
      lastSuccessAt: at(-3000),
      nextRunAt: at(560),
      keepsFailing: 'failed',
    },
    {
      id: 'job-digest',
      name: '日报',
      schedule: '每天 21:00',
      expectEveryMinutes: 1440,
      lastRun: { startedAt: at(-900), endedAt: at(-899), outcome: 'ok' },
      lastSuccessAt: at(-899),
      nextRunAt: at(540),
    },
    {
      id: 'job-limit',
      name: '续期证书',
      schedule: '每 5 个月',
      expectEveryMinutes: 216_000,
      lastRun: { startedAt: at(-57_600), endedAt: at(-57_600), outcome: 'ok' },
      lastSuccessAt: at(-57_600),
      nextRunAt: at(158_400),
    },
  ];

  // ---------- 通知 ----------
  const delivered = (min: number) => [
    { channel: 'feishu', delivered: true, attempts: 1, lastAttemptAt: at(min) },
  ];
  const notifications: Notification[] = [
    {
      id: 'n-1',
      level: 'decision',
      title: '等你点头：发布 v2.3',
      body: '对外发布到生产，能一键回滚到上一版。',
      link: '/tasks/t-20',
      taskId: 't-20',
      createdAt: at(-8),
      deliveries: delivered(-8),
    },
    {
      id: 'n-2',
      level: 'alert',
      title: '#17 子任务 A 停滞 22 分钟',
      body: '最后一步在等 ssh 连备份机；调度员建议重试。',
      link: '/tasks/t-17',
      taskId: 't-17',
      createdAt: at(-3),
      deliveries: delivered(-3),
    },
    {
      id: 'n-3',
      level: 'alert',
      title: '每小时对账没查成',
      body: 'GitHub 接口限流，这次没查成（不是「没问题」）。',
      link: '/schedules',
      createdAt: at(-12),
      deliveries: [
        {
          channel: 'feishu',
          delivered: false,
          attempts: 3,
          error: '飞书返回 99991663：机器人不在群里',
          lastAttemptAt: at(-10),
        },
      ],
    },
    {
      id: 'n-4',
      level: 'decision',
      title: '#15 在问你：发新消息还是把旧的顶上来？',
      body: '再提醒时怎么处理旧消息。',
      link: '/tasks/t-15',
      taskId: 't-15',
      createdAt: at(-26),
      deliveries: delivered(-26),
    },
    {
      id: 'n-5',
      level: 'daily',
      title: 'AI 调度员调整了写码路由',
      body: '把 Kimi k3 挪到第 4：近 24 小时 5 次里 3 次测试没过。可以在调度台一键撤回。',
      link: '/dispatch',
      createdAt: at(-20),
      resolvedAt: at(-15),
      resolvedBy: 'u-lan',
      deliveries: delivered(-20),
    },
    {
      id: 'n-6',
      level: 'alert',
      title: 'Grok 额度读数 42 分钟没更新',
      body: '网页接口返回 403，先按我们自己的用量估算。',
      link: '/quota',
      createdAt: at(-42),
      resolvedAt: at(-30),
      resolvedBy: 'u-zhou',
      deliveries: delivered(-42),
    },
    {
      id: 'n-7',
      level: 'alert',
      title: '#19 子任务 A 测试没过',
      body: 'refund.test.ts 2 条失败；可以换模型重来。',
      link: '/tasks/t-19',
      taskId: 't-19',
      createdAt: at(-47),
      deliveries: delivered(-47),
    },
    {
      id: 'n-8',
      level: 'daily',
      title: '昨日日报',
      body: '合并 6 个 PR，失败 1 次；Claude A 号周窗用了 43%。',
      link: '/overview',
      createdAt: at(-900),
      resolvedAt: at(-880),
      resolvedBy: 'u-lan',
      deliveries: delivered(-900),
    },
  ];

  // ---------- 操作记录 ----------
  const lan = { kind: 'user' as const, id: 'u-lan', name: '阿岚' };
  const zhou = { kind: 'user' as const, id: 'u-zhou', name: '老周' };
  const marshal = { kind: 'ai' as const, id: 'marshal', name: 'AI 调度员' };
  const engine = { kind: 'engine' as const, id: 'engine', name: '引擎' };
  const execBefore = ['r-ca-opus', 'r-rl-kimi', 'r-cb-opus', 'r-rl-opus', 'r-cursor', 'r-ca-opus5'];
  const execAfter = ['r-ca-opus', 'r-cb-opus', 'r-rl-opus', 'r-rl-kimi', 'r-cursor', 'r-ca-opus5'];
  const audit: AuditEntry[] = [
    {
      id: 'a-1',
      at: at(-1.6),
      actor: engine,
      action: 'run.start',
      target: 'task:t-21',
      after: { stage: 'triage', routeId: 'r-ca-sonnet' },
      reason: '分诊阶段排第一',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-2',
      at: at(-8),
      actor: engine,
      action: 'notify.decision',
      target: 'task:t-20',
      reason: '要人拍板：要上线',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-3',
      at: at(-13),
      actor: engine,
      action: 'run.start',
      target: 'task:t-12',
      after: { stage: 'ui', routeId: 'r-cb-opus' },
      reason: 'UI 阶段排第一；GPT 族不接界面活',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-4',
      at: at(-20),
      actor: marshal,
      action: 'stage_policy.update',
      target: 'stage:execute',
      before: { routeIds: execBefore, pinned: false },
      after: { routeIds: execAfter, pinned: false },
      reason: '近 24 小时 Kimi k3 写码 5 次里 3 次测试没过，挪到第 4',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-5',
      at: at(-31),
      actor: engine,
      action: 'run.start',
      target: 'task:t-14',
      after: { stage: 'execute', routeId: 'r-rl-kimi' },
      reason: 'A 号 5/5 满；按 10% 试探',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-6',
      at: at(-47),
      actor: engine,
      action: 'run.fail',
      target: 'task:t-19',
      reason: 'refund.test.ts 2 条失败',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-7',
      at: at(-72),
      actor: lan,
      action: 'login',
      target: 'cockpit',
      after: { method: 'feishu-in-app' },
      via: 'cockpit',
      ok: true,
    },
    {
      id: 'a-8',
      at: at(-130),
      actor: marshal,
      action: 'route.offline',
      target: 'route:r-ca-opus5',
      reason: 'Opus 5 已下架，对应路由自动离线',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-9',
      at: at(-141),
      actor: engine,
      action: 'pr.merge',
      target: 'task:t-12',
      after: { prNumber: 31 },
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-10',
      at: at(-175),
      actor: engine,
      action: 'task.close',
      target: 'task:t-11',
      reason: '两个子任务都已合并',
      via: 'engine',
      ok: true,
    },
    {
      id: 'a-11',
      at: at(-184),
      actor: lan,
      action: 'ask.answer',
      target: 'task:t-12',
      after: { askId: 'ask-12-1', answer: '5 分钟' },
      via: 'feishu',
      ok: true,
    },
    {
      id: 'a-12',
      at: at(-1500),
      actor: zhou,
      action: 'stage_policy.update',
      target: 'stage:plan',
      before: { routeIds: ['r-ca-opus', 'r-cb-opus', 'r-rl-opus'], pinned: false },
      after: { routeIds: ['r-ca-opus', 'r-cb-opus', 'r-rl-opus'], pinned: true },
      reason: '方案阶段先只用 Opus 5.5',
      via: 'cockpit',
      ok: true,
    },
    {
      id: 'a-13',
      at: at(-1520),
      actor: zhou,
      action: 'setting.update',
      target: 'setting:notify.quietHours',
      before: null,
      after: { start: '23:00', end: '08:00' },
      via: 'cockpit',
      ok: true,
    },
  ];

  const settings: Setting[] = [
    { key: 'sessions.maxConcurrent', value: 6, version: 3, updatedAt: at(-2000), updatedBy: 'u-zhou' },
    {
      key: 'notify.quietHours',
      value: { start: '23:00', end: '08:00' },
      version: 1,
      updatedAt: at(-1520),
      updatedBy: 'u-zhou',
    },
    { key: 'judge.dailyCallLimit', value: null, version: 0 },
  ];

  const state: MockState = {
    me: { user: { id: 'u-lan', displayName: '阿岚', role: 'founder' }, csrfToken: 'mock-csrf' },
    repos: [
      { id: 'r-orbit', owner: 'acme', name: 'orbit', defaultBranch: 'main', testCommand: 'pnpm check' },
      {
        id: 'r-canary',
        owner: 'acme',
        name: 'orbit-canary',
        defaultBranch: 'main',
        testCommand: 'pnpm test',
      },
      { id: 'r-site', owner: 'acme', name: 'website', defaultBranch: 'main', testCommand: 'pnpm test' },
    ],
    channels: [
      { id: 'ch-claude', name: 'Claude 订阅', billing: 'subscription', enabled: true },
      { id: 'ch-relay', name: '中转站', billing: 'subscription', enabled: true },
      { id: 'ch-cursor', name: 'Cursor', billing: 'subscription', enabled: true },
      { id: 'ch-grok', name: 'Grok', billing: 'subscription', enabled: true },
      { id: 'ch-ds', name: 'DeepSeek 接口', billing: 'metered', enabled: true },
    ],
    pools: [
      { id: 'claude-a', channelId: 'ch-claude', maxConcurrency: 5, expiresAt: at(19 * 1440) },
      { id: 'claude-b', channelId: 'ch-claude', maxConcurrency: 1, expiresAt: at(8 * 1440) },
      { id: 'relay', channelId: 'ch-relay', maxConcurrency: 4, expiresAt: at(5 * 1440) },
      { id: 'cursor-pro', channelId: 'ch-cursor', maxConcurrency: 2, expiresAt: at(21 * 1440) },
      { id: 'supergrok', channelId: 'ch-grok', maxConcurrency: 2, expiresAt: at(12 * 1440) },
      { id: 'deepseek', channelId: 'ch-ds', maxConcurrency: 4 },
    ],
    models: [
      { id: 'opus-5.5', family: 'claude', displayName: 'Opus 5.5' },
      { id: 'sonnet-5', family: 'claude', displayName: 'Sonnet 5' },
      { id: 'opus-5', family: 'claude', displayName: 'Opus 5', retiredAt: at(-130) },
      { id: 'fable-5.1', family: 'claude', displayName: 'Fable 5.1' },
      { id: 'gpt-5.6-luna', family: 'gpt', displayName: 'GPT 5.6 luna' },
      { id: 'kimi-k3', family: 'kimi', displayName: 'Kimi k3' },
      { id: 'deepseek-v4.1-flash', family: 'deepseek', displayName: 'DeepSeek v4.1 flash' },
      { id: 'cursor-auto', family: 'cursor', displayName: 'Cursor Auto' },
      { id: 'grok-4.7', family: 'grok', displayName: 'Grok 4.7' },
    ],
    routes: [
      {
        id: 'r-ca-opus',
        channelId: 'ch-claude',
        poolId: 'claude-a',
        modelId: 'opus-5.5',
        hostId: 'claude-code',
        alive: true,
        probe: { state: 'ok', at: at(-4), detail: '答上了：OK · 用时 9 秒 · 按 API 价折合 $0.021' },
      },
      {
        id: 'r-cb-opus',
        channelId: 'ch-claude',
        poolId: 'claude-b',
        modelId: 'opus-5.5',
        hostId: 'claude-code',
        alive: true,
        probe: { state: 'ok', at: at(-4), detail: '答上了：OK · 用时 11 秒 · 按 API 价折合 $0.023' },
      },
      {
        id: 'r-ca-sonnet',
        channelId: 'ch-claude',
        poolId: 'claude-a',
        modelId: 'sonnet-5',
        hostId: 'claude-code',
        alive: true,
        probe: { state: 'ok', at: at(-4), detail: '答上了：OK · 用时 6 秒 · 按 API 价折合 $0.004' },
      },
      {
        id: 'r-ca-opus5',
        channelId: 'ch-claude',
        poolId: 'claude-a',
        modelId: 'opus-5',
        hostId: 'claude-code',
        alive: false,
        probe: { state: 'skipped', at: at(-4), detail: '模型「Opus 5」已下架，不探' },
      },
      {
        id: 'r-rl-opus',
        channelId: 'ch-relay',
        poolId: 'relay',
        modelId: 'opus-5.5',
        hostId: 'mirasim',
        alive: true,
        probe: { state: 'ok', at: at(-5), detail: '答上了：OK · 用时 14 秒' },
      },
      {
        id: 'r-rl-gpt',
        channelId: 'ch-relay',
        poolId: 'relay',
        modelId: 'gpt-5.6-luna',
        hostId: 'codex',
        alive: true,
        probe: { state: 'ok', at: at(-5), detail: '答上了：OK · 用时 8 秒' },
      },
      {
        id: 'r-rl-kimi',
        channelId: 'ch-relay',
        poolId: 'relay',
        modelId: 'kimi-k3',
        hostId: 'mirasim',
        alive: true,
        probe: { state: 'ok', at: at(-5), detail: '答上了：OK · 用时 7 秒' },
      },
      {
        id: 'r-rl-fable',
        channelId: 'ch-relay',
        poolId: 'relay',
        modelId: 'fable-5.1',
        hostId: 'mirasim',
        alive: false,
        probe: {
          state: 'skipped',
          at: at(-5),
          detail: '没有哪个阶段在用这条路由（挂着但关着的不算），不花额度去探；哪个阶段用上它，下一轮就探',
        },
      },
      {
        id: 'r-cursor',
        channelId: 'ch-cursor',
        poolId: 'cursor-pro',
        modelId: 'cursor-auto',
        hostId: 'cursor-agent',
        alive: false,
        probe: {
          state: 'failed',
          at: at(-5),
          detail: '连探两次都没通：等了 150 秒还没起来（第一次：进程退出（退出码 1），没有终帧）',
        },
      },
      {
        id: 'r-grok',
        channelId: 'ch-grok',
        poolId: 'supergrok',
        modelId: 'grok-4.7',
        hostId: 'grok',
        alive: true,
        probe: { state: 'ok', at: at(-5), detail: '答上了：OK · 用时 13 秒' },
      },
      {
        id: 'r-ds',
        channelId: 'ch-ds',
        poolId: 'deepseek',
        modelId: 'deepseek-v4.1-flash',
        hostId: 'api-shell',
        alive: false,
        probe: {
          state: 'skipped',
          at: at(-5),
          detail: '按量计费的渠道不自动探：探一次就多一笔账（design 第三节第 21 条）',
        },
      },
    ],
    stages: [
      { stage: 'triage', routeIds: ['r-ca-sonnet', 'r-ds', 'r-rl-kimi'], pinned: false },
      { stage: 'spec', routeIds: ['r-ca-opus', 'r-rl-opus'], pinned: false },
      { stage: 'plan', routeIds: ['r-ca-opus', 'r-cb-opus', 'r-rl-opus'], pinned: true },
      { stage: 'execute', routeIds: execAfter, pinned: false },
      { stage: 'ui', routeIds: ['r-cb-opus', 'r-rl-opus', 'r-cursor'], pinned: false },
      { stage: 'review', routeIds: ['r-grok', 'r-rl-gpt', 'r-ca-sonnet'], pinned: false },
      { stage: 'research', routeIds: ['r-rl-gpt', 'r-grok', 'r-ds'], pinned: false },
      { stage: 'judge', routeIds: ['r-ca-sonnet', 'r-ds'], pinned: false },
    ],
    // 两条全局禁令写死在 shared/bans.ts；库里只放另外加的（这条是样例）。
    bans: [{ family: 'deepseek', stage: 'ui', reason: '（样例）库里另配的禁令：DeepSeek 暂不进 UI' }],
    quota: [
      {
        poolId: 'claude-a',
        window: '5h',
        label: '5h',
        unit: 'percent',
        source: 'claude-usage',
        utilization: 0.62,
        resetsAt: at(108),
        reading: 'measured',
        readAt: at(-4),
      },
      {
        poolId: 'claude-a',
        window: '7d',
        label: '7d',
        unit: 'percent',
        source: 'claude-usage',
        utilization: 0.71,
        resetsAt: at(3240),
        reading: 'measured',
        readAt: at(-4),
      },
      {
        poolId: 'claude-a',
        window: '7d_model',
        label: '7d_opus',
        scope: 'opus',
        unit: 'percent',
        source: 'claude-usage',
        utilization: 0.83,
        resetsAt: at(3240),
        reading: 'measured',
        readAt: at(-4),
      },
      {
        poolId: 'claude-b',
        window: '5h',
        label: '5h',
        unit: 'percent',
        source: 'claude-usage',
        utilization: 0.18,
        resetsAt: at(38),
        reading: 'measured',
        readAt: at(-4),
      },
      {
        poolId: 'claude-b',
        window: '7d',
        label: '7d',
        unit: 'percent',
        source: 'claude-usage',
        utilization: 0.44,
        resetsAt: at(3420),
        reading: 'measured',
        readAt: at(-4),
      },
      {
        poolId: 'relay',
        window: 'period_usd',
        label: 'period_usd',
        unit: 'usd',
        source: 'relay-web',
        used: 61.2,
        limit: 100,
        resetsAt: at(5 * 1440),
        reading: 'measured',
        readAt: at(-9),
      },
      {
        // 只扣 fable 这一组模型的周窗，已经用满：同池的 Kimi、Opus 照常能用（调度台按路由看）。
        poolId: 'relay',
        window: '7d_model',
        label: '7d_fable',
        scope: 'fable',
        unit: 'percent',
        source: 'relay-web',
        utilization: 1,
        upstreamStatus: 'limit_reached',
        resetsAt: at(2 * 1440 + 300),
        reading: 'measured',
        readAt: at(-9),
      },
      {
        poolId: 'cursor-pro',
        window: 'month_usd',
        label: 'month_usd',
        unit: 'usd',
        source: 'estimate',
        used: 12.5,
        limit: 20,
        resetsAt: at(17 * 1440),
        reading: 'estimated',
        readAt: at(-2),
      },
      {
        poolId: 'supergrok',
        window: '5h',
        label: '5h',
        unit: 'percent',
        source: 'estimate',
        utilization: 0.35,
        resetsAt: at(200),
        reading: 'estimated',
        readAt: at(-42),
      },
      {
        poolId: 'supergrok',
        window: '7d',
        label: '7d',
        unit: 'percent',
        source: 'estimate',
        utilization: 0.21,
        resetsAt: at(4 * 1440),
        reading: 'estimated',
        readAt: at(-42),
      },
      {
        poolId: 'deepseek',
        window: 'month_usd',
        label: 'month_usd',
        unit: 'usd',
        source: 'deepseek-balance',
        used: 6.4,
        limit: 30,
        resetsAt: at(7 * 1440),
        reading: 'measured',
        readAt: at(-12),
      },
    ],
    tasks,
    logs: [],
    jobs,
    notifications,
    audit,
    settings,
    plans,
    nextPr: 40,
    seq,
  };
  state.logs = seedLogs(state, now);
  state.seq = seq + state.logs.length;
  return state;
}

/** 按会话的起止时间编一段过程记录（和真后端 describeTimeline 的说法一致）。 */
function seedLogs(state: MockState, now: number): MLog[] {
  const logs: MLog[] = [];
  let n = 0;
  const push = (l: Omit<MLog, 'id'>) => logs.push({ id: `log-seed-${++n}`, ...l });
  for (const t of state.tasks) {
    push({
      taskId: t.task.id,
      at: t.task.createdAt,
      source: 'engine',
      kind: 'state',
      text: '状态：（新建）→ queued',
    });
    for (const r of t.runs) {
      if (!r.startedAt) continue;
      push({
        taskId: t.task.id,
        runId: r.id,
        at: r.startedAt,
        source: 'session',
        kind: 'say',
        text: `开始${stageSay(r.stage)}`,
      });
      if (r.endedAt)
        push({
          taskId: t.task.id,
          runId: r.id,
          at: r.endedAt,
          source: 'session',
          kind: 'done',
          text: `交活：${stageSay(r.stage)}完成`,
        });
    }
    for (const a of t.asks) {
      push({ taskId: t.task.id, at: a.askedAt, source: 'session', kind: 'ask', text: `问：${a.question}` });
      if (a.answer && a.answeredAt)
        push({
          taskId: t.task.id,
          at: a.answeredAt,
          source: 'person',
          kind: 'answer',
          text: `回答追问：${a.answer}`,
        });
    }
    for (const s of t.subtasks) {
      for (const r of s.runs) {
        if (!r.startedAt) continue;
        const start = Date.parse(r.startedAt);
        const end = r.endedAt ? Date.parse(r.endedAt) : now - 20_000;
        const base = { taskId: t.task.id, runId: r.id, subtaskId: s.subtask.id, source: 'session' as const };
        const done = s.steps.filter((x) => x.state === 'done').length;
        const cur = s.steps.find((x) => x.state === 'in_progress');
        push({
          ...base,
          at: r.startedAt,
          kind: 'plan',
          text: `步骤清单：完成 ${done}/${s.steps.length}${cur ? `，正在${cur.title}` : ''}`,
        });
        const count = Math.min(14, Math.max(3, Math.round((end - start) / (2.5 * 60_000))));
        for (let i = 0; i < count; i++) {
          const when = new Date(start + ((end - start) * (i + 1)) / (count + 1)).toISOString();
          push({ ...base, at: when, ...fakeAction(s.subtask.touches, i) });
        }
        if (r.endedAt && r.outcome === 'ok') {
          push({
            ...base,
            at: r.endedAt,
            kind: 'done',
            text: r.stage === 'review' ? '交活：第二意见没有必须改的' : '交活：测试通过，PR 已开',
          });
        }
        if (r.outcome === 'failed') {
          push({
            ...base,
            at: r.endedAt ?? new Date(now).toISOString(),
            kind: 'test',
            text: '跑测试（pnpm vitest run refund）：没过',
            detail: { command: 'pnpm vitest run refund', passed: false },
          });
        }
      }
      if (s.lastSay)
        push({
          taskId: t.task.id,
          subtaskId: s.subtask.id,
          runId: s.runs[s.runs.length - 1]?.id ?? '',
          at: s.lastSay.at,
          source: 'session',
          kind: 'say',
          text: s.lastSay.text,
        });
    }
  }
  return logs;
}

function stageSay(stage: StageKind): string {
  switch (stage) {
    case 'triage':
      return '分诊';
    case 'spec':
      return '写需求文档';
    case 'plan':
      return '写方案';
    case 'review':
      return '第二意见';
    default:
      return '干活';
  }
}

/** 过程记录里的一条「动作」，按序号轮着来：读文件、搜索、改文件、跑命令、跑测试。 */
export function fakeAction(touches: string[], i: number): Pick<MLog, 'kind' | 'text' | 'detail'> {
  const file = touches[i % Math.max(1, touches.length)] ?? 'README.md';
  const base =
    file
      .split('/')
      .pop()
      ?.replace(/\.\w+$/, '') ?? 'index';
  switch (i % 5) {
    case 0:
      return { kind: 'tool', text: `用工具：Read ${file}`, detail: { name: 'Read', input: file } };
    case 1:
      return { kind: 'tool', text: `用工具：Grep "${base}"`, detail: { name: 'Grep', input: base } };
    case 2:
      return {
        kind: 'file',
        text: `改文件：${file}`,
        detail: { path: file, added: 12 + ((i * 7) % 40), removed: (i * 3) % 9 },
      };
    case 3:
      return {
        kind: 'tool',
        text: `用工具：Bash pnpm vitest run ${base}`,
        detail: { name: 'Bash', input: `pnpm vitest run ${base}` },
      };
    default:
      return {
        kind: 'test',
        text: `跑测试（pnpm vitest run ${base}）：通过`,
        detail: { command: `pnpm vitest run ${base}`, passed: true },
      };
  }
}
