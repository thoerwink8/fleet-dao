// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
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
