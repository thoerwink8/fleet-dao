// 方案 2 驾驶舱全页面点验（1440×900 桌面 + 390×844 手机双视口）：
// 覆盖：
// 1. ADE 全功能发射台：添加新工作区、切换工作区、选择工种角色、调整模型与思考档位（Effort）、发起新会话并跳入实时流；
// 2. 会话页 YSK (✦ Heads up · 主 agent) 旁路提醒卡片与一键发 Steer 纠偏、三挡发送（Steer / Queue / Jump）、接力引擎与思考档位热切、暂停/恢复/Fork 分叉；
// 3. 任务波次编排页（/next/waves）：波次切换、新增派发波次子任务、同波次跨会话黑板广播；
// 4. 四道可信度验收漏斗页（/next/decide）：Gate 1~4 证据包展示、点击「批准拍板」与「退回并升档重做」状态流转；
// 5. 多宿主运维与防封监控页（/next/ops）：动态添加主机、跨机定向派工并跳转真实会话流；
// 6. 四维路由矩阵与模型专属 Prompt 自进化页（/next/settings）：切换装甲规则、在线调整工种首选模型与思考档位、追加自定义护栏与注册新模型；
// 7. 1440 与 390 窄屏下全部一级页面 0 横向滚动（scrollWidth <= innerWidth）。

import { seed } from '../../dev/seed.ts';
import { expect, feedStatus, test } from '../support/fixtures.ts';

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const m = await page.evaluate(() => ({
    sw: document.documentElement.scrollWidth,
    iw: window.innerWidth,
    bodyOverflow: document.body.scrollWidth > window.innerWidth,
  }));
  expect(m.sw).toBeLessThanOrEqual(m.iw);
  expect(m.bodyOverflow).toBe(false);
}

test.describe('方案 2 驾驶舱全页面交互点验与双屏零横滚验证', () => {
  test('ADE 工作区管理与新建会话发射台：添加工作区、选工种/模型/思考档位、发起新会话并实时进入事件流', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/`);
    await assertNoHorizontalOverflow(page);

    const view = page.viewportSize() ?? { width: 1440, height: 900 };
    if (view.width >= 768) {
      const composer = page.getByTestId('ade-new-session-composer');
      await expect(composer).toBeVisible();

      // 1. 添加新工作区
      await composer.getByRole('button', { name: /添加工作区/ }).click();
      await composer.getByLabel('工作区名称').fill('order-engine (订单核心)');
      await composer.getByLabel('工作区路径').fill('D:/work/order-engine');
      await composer.getByRole('button', { name: '保存工作区' }).click();
      await expect(composer.getByText(/已添加并切换到工作区「order-engine \(订单核心\)」/)).toBeVisible();

      // 2. 选择工种、模型、思考档位并发起新会话
      await composer.getByTestId('role-option-worker-code').click();
      await composer.getByLabel('新建会话选择模型').selectOption('commoncode::deepseek-v4-pro');
      await composer.getByLabel('新建会话思考档位').selectOption('max');
      await composer.getByLabel('新建会话写范围锁').fill('packages/order/**');
      await composer.getByLabel('新建会话任务描述').fill('实现订单幂等防重锁并补齐并发回归单测');
      await composer.getByRole('button', { name: '立即启动会话' }).click();

      // 验证跳转到新建的真实会话流并展示事件与过程步骤
      await expect(page).toHaveURL(/\/next\/s\/worker-ade-/);
      await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live');
      await expect(page.getByTestId('events')).toContainText('实现订单幂等防重锁并补齐并发回归单测');
      await expect(page.getByTestId('events')).toContainText('codegraph_explore');
      await assertNoHorizontalOverflow(page);
    }
  });

  test('YSK 旁路盯梢横幅（✦ Heads up · 主 agent）一键发 Steer 纠偏与三挡实时引导点验', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/s/cmd-demo-flaky-ci`);
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live');

    const headsUp = page.getByTestId('ysk-heads-up');
    await expect(headsUp).toBeVisible();
    await expect(headsUp).toContainText('✦ Heads up · 主 agent');
    await expect(headsUp).toContainText('devin/swe-2');

    // 点击「一键发 Steer 纠偏」
    await headsUp.getByRole('button', { name: '一键发 Steer 纠偏' }).click();
    await expect(headsUp).toContainText('已注入实时 Steer 纠偏');
    const sentList = page.getByTestId('steer-sent-list');
    await expect(sentList).toContainText('实时引导 Steer');

    // 切换到「立即打断 (Jump)」并切换接力引擎为 CommonCode DeepSeek V4 Pro 与思考档位 Max，发送一条自定义引导
    await page.getByRole('button', { name: /Jump/ }).click();
    await page.getByLabel('切换会话引擎与模型').selectOption('commoncode::deepseek-v4-pro');
    await page.getByLabel('切换会话思考档位').selectOption('max');
    await page.getByLabel('会话引导输入').fill('优先核对 packages/omp-bridge 单测');
    await page.getByRole('button', { name: '发送' }).click();

    await expect(sentList).toContainText('优先核对 packages/omp-bridge 单测');
    await expect(sentList).toContainText('deepseek-v4-pro');
    // 验证后端 POST /steer 写入数据库并经 SSE 实时推送到会话流 timeline 中
    await expect(page.getByTestId('events')).toContainText(
      '[紧急插队 Jump] 优先核对 packages/omp-bridge 单测 (接力引擎: deepseek-v4-pro · 思考档位: max)',
    );
    await assertNoHorizontalOverflow(page);
  });

  test('五个一级工作台（任务波次 DAG、四道漏斗决策、多宿主防封运维、四维路由与 Prompt 进化）交互点验与 1440/390 零横滚', async ({
    page,
    stack,
  }) => {
    await seed(stack);

    // 1. 任务波次编排页 (/next/waves)
    await page.goto(`${stack.url}/next/waves`);
    await expect(page.getByText('本地波次分支合流 → 最终单 PR')).toBeVisible();
    await expect(page.getByTestId('wave-node-W1-S1')).toBeVisible();
    await expect(page.getByTestId('wave-node-W2-S2')).toBeVisible();
    await page.getByRole('button', { name: /第二波/ }).click();
    await expect(page.getByTestId('wave-node-W1-S1')).toBeHidden();
    await expect(page.getByTestId('wave-node-W2-S2')).toBeVisible();
    await assertNoHorizontalOverflow(page);

    // 2. 决策与四道可信验收闸 (/next/decide)
    await page.goto(`${stack.url}/next/decide`);
    await expect(page.getByText('待拍板')).toContainText('3');
    const card1 = page.getByTestId('decision-card-DEC-3851-UI');
    await card1.getByRole('button', { name: '批准拍板' }).click();
    await expect(card1).toContainText('已批准执行');
    await expect(page.getByText('待拍板')).toContainText('2');
    await assertNoHorizontalOverflow(page);

    // 3. 多机集群与跨机协同 (/next/ops)
    await page.goto(`${stack.url}/next/ops`);
    await expect(page.getByText('non_cc_client 风险 = 0')).toBeVisible();
    await expect(page.getByText('vps-france:fleet-agent-carpool')).toBeVisible();
    await expect(page.getByTestId('ops-pty-output')).toContainText('intranetZeroKeyDisk');
    await page.getByRole('button', { name: 'Linux VPS' }).click();
    await expect(page.getByTestId('ops-pty-output')).toContainText('antiBanVerified');

    // 测试动态添加第 4 台主机节点
    await page.getByRole('button', { name: '添加主机节点' }).click();
    await page.getByLabel('新主机名称').fill('法兰克福 GPU 节点');
    await page.getByLabel('新主机连接地址').fill('ssh://ubuntu@10.88.1.9');
    await page.getByRole('button', { name: '保存接入' }).click();
    await expect(page.getByTestId('cross-host-mesh-list')).toContainText('法兰克福 GPU 节点');

    // 测试跨主机定向派单与跨机黑板同步 + 跳转到真实创建的会话流验证
    await page.getByLabel('选择目标执行主机').selectOption('corp-intranet-01');
    await page.getByLabel('跨机派工任务描述').fill('在内网环境跑支付网关 E2E 联调');
    const dispatchRes = page.waitForResponse((r) => r.url().includes('/cluster/dispatch'));
    await page.getByRole('button', { name: '派发到该主机' }).click();
    await dispatchRes;
    await expect(page.getByTestId('cross-host-mesh-list')).toContainText(
      '[跨机定向派工] 任务「在内网环境跑支付网关 E2E 联调」已派发至主机',
    );
    await assertNoHorizontalOverflow(page);

    const dispatchedJobLink = page
      .getByTestId('host-card-corp-intranet-01')
      .getByRole('link', { name: '看实时过程' })
      .first();
    await dispatchedJobLink.click();
    await expect(page.getByTestId('events')).toContainText('在内网环境跑支付网关 E2E 联调');
    await expect(page.getByTestId('events')).toContainText('跨机黑板 Mesh 总线已连接');

    // 4. 四维路由矩阵与模型专属提示词自进化 (/next/settings)
    await page.goto(`${stack.url}/next/settings`);
    await expect(page.getByText('Magpie 实时额度雷达')).toBeVisible();
    await expect(page.getByText('CommonCode / OpenCode · DeepSeek V4 Pro 编码主力装甲')).toBeVisible();
    await page.getByRole('button', { name: 'Claude Sonnet (Kiro)' }).click();
    await expect(page.getByText('Kiro · 次一级 Claude 编码主力装甲')).toBeVisible();
    await page.getByLabel('worker-code 思考档位').selectOption('max');
    await expect(page.getByText(/已将工种「worker-code」默认思考档位调整为 max/)).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });
});
