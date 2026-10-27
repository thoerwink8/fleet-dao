// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Section, SectionGrid } from './section';
import { LAYOUT_TONES } from './tone';

afterEach(cleanup);

describe('Section', () => {
  test('标题、说明、操作、正文都在；默认是 card 变体', () => {
    render(
      <Section title="区块" description="一句说明" actions={<button type="button">操作</button>}>
        <p>正文</p>
      </Section>,
    );
    expect(screen.getByRole('heading', { name: '区块' })).toBeTruthy();
    expect(screen.getByText('一句说明')).toBeTruthy();
    expect(screen.getByRole('button', { name: '操作' })).toBeTruthy();
    expect(document.querySelector('section')?.dataset.variant).toBe('card');
  });

  test('flush 区块的 toolbar（头和列表之间）、footer（列表下面）带边线，不给就不画', () => {
    render(
      <Section flush title="渠道" toolbar={<span>筛选</span>} footer={<span>脚注</span>}>
        <p>列表</p>
      </Section>,
    );
    expect(document.querySelector('[data-section-toolbar]')?.textContent).toBe('筛选');
    expect(document.querySelector('[data-section-footer]')?.textContent).toBe('脚注');
    cleanup();
    render(
      <Section flush title="渠道">
        <p>列表</p>
      </Section>,
    );
    expect(document.querySelector('[data-section-toolbar]')).toBeNull();
    expect(document.querySelector('[data-section-footer]')).toBeNull();
  });

  test('没有标题和操作就不画页眉', () => {
    render(<Section>正文</Section>);
    expect(document.querySelector('header')).toBeNull();
  });

  test.each(LAYOUT_TONES)('tone=%s 渲染 data-tone 和左边竖线', (tone) => {
    render(
      <Section title="出问题" tone={tone}>
        x
      </Section>,
    );
    expect(document.querySelector('section')?.dataset.tone).toBe(tone);
    expect(document.querySelector('[data-section-rail]')).not.toBeNull();
    cleanup();
  });

  test('plain 变体没有边框和竖线；flush 正文没有内边距', () => {
    const { container } = render(
      <Section variant="plain" tone="fail" title="设置">
        x
      </Section>,
    );
    expect(container.querySelector('[data-section-rail]')).toBeNull();
    expect(container.querySelector('section')?.className).not.toContain('border');
    cleanup();
    const flush = render(
      <Section flush title="列表">
        <i data-body />
      </Section>,
    );
    expect(flush.container.querySelector('[data-body]')?.parentElement?.className).not.toContain('p-section');
  });
});

describe('Section 收起（#3707 批次 3）', () => {
  test('collapsible + open：头照画、正文画，行尾没有摘要', () => {
    render(
      <Section title="卡住报警" collapsible open onToggle={() => {}} summary="2 件卡住 · 1 件还没人接">
        <i data-body />
      </Section>,
    );
    const section = document.querySelector('section') as HTMLElement;
    expect(section.dataset.collapsible).toBe('true');
    expect(section.dataset.open).toBe('true');
    expect(document.querySelector('[data-body]')).not.toBeNull();
    expect(document.querySelector('[data-section-summary]')).toBeNull();
  });

  test('收起：正文不画，摘要行有字（行尾一份 + 窄屏在标题下面一份）', () => {
    render(
      <Section
        title="卡住报警"
        collapsible
        open={false}
        onToggle={() => {}}
        summary="2 件卡住 · 1 件还没人接"
      >
        <i data-body />
      </Section>,
    );
    const section = document.querySelector('section') as HTMLElement;
    expect(section.dataset.open).toBe('false');
    expect(document.querySelector('[data-body]')).toBeNull();
    const summaries = [...document.querySelectorAll('[data-section-summary]')];
    expect(summaries.length).toBeGreaterThanOrEqual(1);
    for (const s of summaries) expect(s.textContent).toBe('2 件卡住 · 1 件还没人接');
    // 标题和条数照画（收起后还认得出是哪一块）
    expect(screen.getByRole('heading', { name: '卡住报警' })).toBeTruthy();
  });

  test('点开关叫 onToggle；aria-expanded 跟着开合', () => {
    const toggles: number[] = [];
    render(
      <Section title="项目" collapsible open={false} onToggle={() => toggles.push(1)} summary="4 个仓">
        x
      </Section>,
    );
    const button = document.querySelector('[data-section-toggle]') as HTMLButtonElement;
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(toggles).toHaveLength(1);
  });

  test('不给 collapsible 就是老样子：没有开关、没有摘要、正文照画', () => {
    render(
      <Section title="最近上线" summary="这一行不该出现">
        <i data-body />
      </Section>,
    );
    expect(document.querySelector('[data-section-toggle]')).toBeNull();
    expect(document.querySelector('[data-section-summary]')).toBeNull();
    expect(document.querySelector('[data-body]')).not.toBeNull();
  });

  test('收起时操作还在（「全部通知」这类入口不能跟着藏起来）', () => {
    render(
      <Section
        title="要你拍的"
        collapsible
        open={false}
        onToggle={() => {}}
        summary="没有要你拍的"
        actions={<button type="button">全部通知</button>}
      >
        x
      </Section>,
    );
    expect(screen.getByRole('button', { name: '全部通知' })).toBeTruthy();
    expect(document.querySelector('[data-section-toggle]')).not.toBeNull();
  });
});

describe('SectionGrid', () => {
  test('两栏：lg 起两列，手机一列', () => {
    const { container } = render(
      <SectionGrid cols={2}>
        <div />
      </SectionGrid>,
    );
    const cls = (container.firstElementChild as HTMLElement).className;
    expect(cls).toContain('grid-cols-1');
    expect(cls).toContain('lg:grid-cols-2');
  });
});
