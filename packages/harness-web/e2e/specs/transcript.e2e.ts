// 工人会话详情 e2e（#3781）：工人运行时 stream-json 的每一步落成事件，会话页按时间串起来。
// 样例是 dev/seed.ts 的 worker-d12-a1：26 步（18 次工具调用、7 句话、1 次运行结束），穿插 2 条进度和 1 次交结果；
// 库里的事件号是真相，页面渲染出来的事件号必须一致（不漏、不重、有序）。1440 和 390 两种屏宽各跑一遍。
import { events } from '@fleet-dao/harness-store';
import { asc, eq } from 'drizzle-orm';
import { DEMO_RUN_ID, seed } from '../../dev/seed.ts';
import type { Stack } from '../../dev/stack.ts';
import { expect, feedStatus, test } from '../support/fixtures.ts';

const WORKER = `worker-${DEMO_RUN_ID}`;

async function open(page: import('@playwright/test').Page, stack: Stack, id = WORKER) {
  await page.goto(`${stack.url}/next/s/${id}`);
  await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live');
}

async function transcriptRows(stack: Stack, runId = DEMO_RUN_ID) {
  return stack.db
    .select({ id: events.id, type: events.type })
    .from(events)
    .where(eq(events.streamId, `transcript:${runId}`))
    .orderBy(asc(events.id));
}

test.describe('工人会话详情', () => {
  test('过程按时间串起来：话、工具调用、进度、交结果、运行结束，号和库里一致、顺序对', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await open(page, stack);
    // 页面上每一条（含折叠里的）：事件号严格递增
    const domIds = await page.$$eval('[data-event-id],[data-step-id]', (els) =>
      els.map((e) => Number((e as HTMLElement).dataset.eventId ?? (e as HTMLElement).dataset.stepId)),
    );
    expect(domIds).toEqual([...domIds].sort((a, b) => a - b));
    expect(new Set(domIds).size).toBe(domIds.length);
    // 步骤 = 库里的 assistant、tool_use、result 三类（tool_result 并进对应的调用行里，不单独成行）
    const rows = await transcriptRows(stack);
    const wantSteps = rows.filter((r) => r.type !== 'transcript.tool_result').map((r) => r.id);
    const stepIds = await page.$$eval('[data-step-id]', (els) =>
      els.map((e) => Number((e as HTMLElement).dataset.stepId)),
    );
    expect(stepIds).toEqual(wantSteps);
    expect(wantSteps.length).toBe(26);
    // 会话里的进度和交结果夹在中间
    await expect(page.locator('[data-event-type="worker.progress.reported"]')).toHaveCount(2);
    await expect(page.locator('[data-event-type="worker.result.submitted"]')).toHaveCount(1);
    await expect(page.locator('[data-step-kind="say"]')).toHaveCount(7);
    await expect(page.locator('[data-step-kind="end"]')).toContainText('登录页窄屏修好');
    // 助手的话是正文：不套卡片边框
    const say = page.locator('[data-step-kind="say"]').first();
    await expect(say).toContainText('先看登录页的组件');
    expect(await say.evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe('0px');
  });

  test('连续工具调用折叠成一行摘要，点开才看到每一步；出错的在摘要里有数', async ({ page, stack }) => {
    await seed(stack);
    await open(page, stack);
    const runs = page.locator('[data-step-run]');
    await expect(runs).toHaveCount(4);
    await expect(runs.nth(0)).toContainText('调了 3 个工具：Read×2、Grep×1');
    await expect(runs.nth(1)).toContainText('调了 5 个工具：Edit×3、Read×1、Bash×1 · 1 个出错');
    await expect(runs.nth(1)).toHaveAttribute('data-failed', '1');
    // 收起时每一步仍在页面里（hidden），不可见
    const inside = runs.nth(1).locator('[data-step-kind="tool"]');
    await expect(inside).toHaveCount(5);
    await expect(inside.first()).toBeHidden();
    await runs.nth(1).getByRole('button').first().click();
    await expect(inside.first()).toBeVisible();
    await expect(runs.nth(1).locator('[data-tool-status="error"]')).toHaveCount(1);
    await expect(runs.nth(1).locator('[data-tool-status="error"]')).toContainText('出错');
    // 不够 3 次的不折叠：直接一行一个调用（长输出那次 Bash、中间那次 Grep）
    await expect(page.locator('[data-testid="events"] > li[data-step-kind="tool"]')).toHaveCount(2);
    // 收起再展开
    await runs.nth(1).getByRole('button').first().click();
    await expect(inside.first()).toBeHidden();
  });

  test('一次工具调用一行，点开看参数和结果；长输出默认只显示前 12 行，可展开全部', async ({
    page,
    stack,
  }) => {
    await seed(stack);
    await open(page, stack);
    const bash = page.locator('[data-testid="events"] > li[data-step-kind="tool"]').first();
    await expect(bash).toContainText('Bash');
    await expect(bash).toContainText('npx vitest run packages/web/src/routes');
    await expect(bash.getByTestId('tool-detail')).toHaveCount(0);
    await bash.getByRole('button').first().click();
    const detail = bash.getByTestId('tool-detail');
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('"command"');
    const outputs = detail.getByTestId('tool-output');
    const result = outputs.nth(1);
    await expect(result).toHaveAttribute('data-clamped', 'closed');
    await expect(result).not.toContainText('case-40');
    await expect(result).toContainText('case-01');
    await result.getByRole('button', { name: /展开全部/ }).click();
    await expect(result).toHaveAttribute('data-clamped', 'open');
    await expect(result).toContainText('case-40');
  });

  test('指挥会话里的派工请求和交回，一键跳到对应的工人会话', async ({ page, stack }) => {
    await seed(stack);
    await page.goto(`${stack.url}/next/s/cmd-demo-login-fix`);
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live');
    // 派工请求：链接按派工请求的事件号推出运行编号 d<事件号>-a1（派工器就是这么起的编号）
    const spawn = page.locator('[data-event-type="worker.spawn.requested"]');
    const spawnId = await spawn.getAttribute('data-event-id');
    await expect(spawn.getByTestId('open-worker')).toHaveAttribute(
      'data-worker-session',
      `worker-d${spawnId}-a1`,
    );
    // 交回核验：载荷里的 runId
    const link = page.locator('[data-event-type="handback.recorded"]').getByTestId('open-worker');
    await expect(link).toHaveAttribute('data-worker-session', WORKER);
    await link.click();
    await expect(page).toHaveURL(new RegExp(`/next/s/${WORKER}$`));
    await expect(feedStatus(page)).toHaveAttribute('data-feed-status', 'live');
    await expect(page.locator('[data-step-kind="end"]')).toBeVisible();
  });

  test('运行中：新的一步实时出现，没有结果的调用显示「运行中」，结果到了就变', async ({ page, stack }) => {
    const run = 'live-run';
    await open(page, stack, `worker-${run}`);
    await stack.emitStream(`transcript:${run}`, 'transcript.assistant', {
      runId: run,
      text: '开始干活',
      truncated: false,
      chars: 4,
    });
    await expect(page.locator('[data-step-kind="say"]')).toContainText('开始干活');
    await stack.emitStream(`transcript:${run}`, 'transcript.tool_use', {
      runId: run,
      toolUseId: 'toolu_live',
      name: 'Bash',
      summary: 'sleep 5',
      input: '{"command":"sleep 5"}',
      inputTruncated: false,
    });
    const row = page.locator('[data-step-kind="tool"]');
    await expect(row).toHaveAttribute('data-tool-status', 'running');
    await expect(row).toContainText('运行中');
    await stack.emitStream(`transcript:${run}`, 'transcript.tool_result', {
      runId: run,
      toolUseId: 'toolu_live',
      isError: false,
      text: '完成',
      truncated: false,
      chars: 2,
    });
    await expect(row).toHaveAttribute('data-tool-status', 'ok');
    await expect(row).not.toContainText('运行中');
  });

  test('过程很长：先显示最新一页，「加载更早的事件」往前翻，不重不漏', async ({ page, stack }) => {
    const run = 'big-run';
    for (let i = 0; i < 250; i++) {
      await stack.emitStream(`transcript:${run}`, 'transcript.assistant', {
        runId: run,
        text: `第 ${i} 句`,
        truncated: false,
        chars: 4,
      });
    }
    await open(page, stack, `worker-${run}`);
    await expect(page.locator('[data-step-kind="say"]')).toHaveCount(200);
    await page.getByRole('button', { name: '加载更早的事件' }).click();
    await expect(page.locator('[data-step-kind="say"]')).toHaveCount(250);
    const ids = await page.$$eval('[data-step-id]', (els) =>
      els.map((e) => Number((e as HTMLElement).dataset.stepId)),
    );
    expect(ids).toEqual((await transcriptRows(stack, run)).map((r) => r.id));
    await expect(page.getByRole('button', { name: '加载更早的事件' })).toHaveCount(0);
  });

  test('窄屏和宽屏都不横向滚动', async ({ page, stack }) => {
    await seed(stack);
    await open(page, stack);
    await page.locator('[data-step-run]').nth(1).getByRole('button').first().click();
    await page
      .locator('[data-testid="events"] > li[data-step-kind="tool"]')
      .first()
      .getByRole('button')
      .first()
      .click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
