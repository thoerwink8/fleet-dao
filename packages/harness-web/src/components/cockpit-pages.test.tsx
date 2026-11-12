// @vitest-environment happy-dom
// 方案 2 新增的四大工作台页面 + ADE 工作区管理/新建会话发射台 + YSK 旁路横幅 + Steer 实时引导栏单测。
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DecidePage } from '../pages/decide';
import { OpsPage } from '../pages/ops';
import { SettingsPage } from '../pages/settings';
import { WorkWavePage } from '../pages/work-wave';
import { AdeNewSessionComposer } from './ade-composer';
import { SessionSteerBar } from './ysk-heads-up';

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({ ok: true, sessionId: 'worker-ade-test-01' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('方案 2 驾驶舱：YSK 旁路盯梢横幅与三挡实时引导（SessionSteerBar）', () => {
  it('在问题会话里显示 ✦ Heads up · 主 agent 横幅，点一键发 Steer 纠偏立即注入引导队列', () => {
    render(
      <MemoryRouter>
        <SessionSteerBar sessionId="cmd-demo-flaky-ci" />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ysk-heads-up').textContent).toContain('✦ Heads up · 主 agent');
    expect(screen.getByTestId('ysk-heads-up').textContent).toContain('devin/swe-2');

    fireEvent.click(screen.getByRole('button', { name: /一键发 Steer 纠偏/ }));
    expect(screen.getByTestId('steer-sent-list').textContent).toContain('实时引导 Steer');
    expect(screen.getByText('已注入实时 Steer 纠偏')).toBeTruthy();
  });

  it('支持切换 Queue / Steer / Jump 三挡发送模式、接力引擎模型与思考档位 Effort', () => {
    render(
      <MemoryRouter>
        <SessionSteerBar sessionId="clean-session" />
      </MemoryRouter>,
    );
    expect(screen.queryByTestId('ysk-heads-up')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Jump/ }));
    fireEvent.change(screen.getByLabelText('切换会话思考档位'), { target: { value: 'max' } });
    const input = screen.getByLabelText('会话引导输入');
    fireEvent.change(input, { target: { value: '先停一下，优先跑类型检查' } });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));

    expect(screen.getByTestId('steer-sent-list').textContent).toContain('紧急插队 Jump');
    expect(screen.getByTestId('steer-sent-list').textContent).toContain('先停一下，优先跑类型检查');
    expect(screen.getByTestId('steer-sent-list').textContent).toContain('(max)');
  });
});

describe('ADE 核心基础功能：添加工作区、发起新会话、切换工种与模型、调整四维路由', () => {
  it('支持在新建会话发射台中添加新工作区、选择工种角色、调整模型与思考档位并发起新会话', async () => {
    render(
      <MemoryRouter>
        <AdeNewSessionComposer />
      </MemoryRouter>,
    );
    expect(screen.getByTestId('ade-new-session-composer')).toBeTruthy();

    // 1. 打开添加工作区面板并保存新工作区
    fireEvent.click(screen.getByRole('button', { name: /添加工作区/ }));
    fireEvent.change(screen.getByLabelText('工作区名称'), {
      target: { value: 'billing-core (计费中心)' },
    });
    fireEvent.change(screen.getByLabelText('工作区路径'), {
      target: { value: 'D:/work/billing-core' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存工作区' }));
    expect(screen.getByText(/已添加并切换到工作区「billing-core \(计费中心\)」/)).toBeTruthy();

    // 2. 切换工种模式为「前端视觉 (Worker-UI · 禁 GPT)」，调整模型与思考档位
    fireEvent.click(screen.getByTestId('role-option-worker-ui'));
    fireEvent.change(screen.getByLabelText('新建会话选择模型'), {
      target: { value: 'kiro::kiro-claude-sonnet' },
    });
    fireEvent.change(screen.getByLabelText('新建会话思考档位'), {
      target: { value: 'high' },
    });
    fireEvent.change(screen.getByLabelText('新建会话任务描述'), {
      target: { value: '优化计费工作台窄屏响应式布局并跑双视口截图核验' },
    });
    fireEvent.click(screen.getByRole('button', { name: '立即启动会话' }));
  });

  it('任务波次页：按波次筛选子任务、支持派发新波次子任务，并展示同波次跨会话实时黑板', () => {
    render(
      <MemoryRouter>
        <WorkWavePage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/wave\/3851-option2/)).toBeTruthy();
    expect(screen.getByTestId('wave-node-W1-S1')).toBeTruthy();
    expect(screen.getByTestId('wave-node-W2-S2')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /第一波/ }));
    expect(screen.getByTestId('wave-node-W1-S1')).toBeTruthy();
    expect(screen.queryByTestId('wave-node-W2-S2')).toBeNull();

    // 切回全部波次并新增一个波次子任务
    fireEvent.click(screen.getByRole('button', { name: /全部波次/ }));
    fireEvent.click(screen.getByRole('button', { name: /派发波次任务/ }));
    fireEvent.change(screen.getByLabelText('新波次子任务描述'), {
      target: { value: '新增宿主集群断线恢复测试' },
    });
    fireEvent.click(screen.getByRole('button', { name: '加入波次并启动' }));
    expect(screen.getAllByText(/新增宿主集群断线恢复测试/).length).toBeGreaterThanOrEqual(1);
  });

  it('决策页：展示四道可信漏斗证据包，支持批准拍板或退回升档重做', () => {
    render(
      <MemoryRouter>
        <DecidePage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/待拍板/)).toBeTruthy();
    const approveBtns = screen.getAllByRole('button', { name: '批准拍板' });
    const firstBtn = approveBtns[0];
    if (!firstBtn) throw new Error('missing button');
    fireEvent.click(firstBtn);
    expect(screen.getByText('已批准执行')).toBeTruthy();
  });

  it('运维与四维路由设置页：支持在线调整每个工种的首选模型、思考档位、追加模型专属护栏与注册新模型', () => {
    render(
      <MemoryRouter>
        <OpsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/non_cc_client 风险 = 0/)).toBeTruthy();
    expect(screen.getAllByText(/127\.0\.0\.1:19820:127\.0\.0\.1:19820/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/跨主机实时通信与协同总线/)).toBeTruthy();

    cleanup();
    render(
      <MemoryRouter>
        <SettingsPage />
      </MemoryRouter>,
    );
    expect(screen.getByText(/CommonCode \/ OpenCode · DeepSeek V4 Pro 编码主力装甲/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Claude Sonnet (Kiro)' }));
    expect(screen.getByText(/Kiro · 次一级 Claude 编码主力装甲/)).toBeTruthy();

    // 在线调整 worker-code 的思考档位
    fireEvent.change(screen.getByLabelText('worker-code 思考档位'), {
      target: { value: 'max' },
    });
    expect(screen.getByText(/已将工种「worker-code」默认思考档位调整为 max/)).toBeTruthy();
  });
});
