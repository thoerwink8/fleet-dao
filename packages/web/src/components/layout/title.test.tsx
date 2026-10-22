// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'vitest';
import { Title } from './title';

afterEach(cleanup);

describe('Title', () => {
  test('level=1 是 h1 页面标题档；level=3 是 h3 小标题', () => {
    render(
      <>
        <Title level={1}>动手</Title>
        <Title level={3}>小标题</Title>
      </>,
    );
    expect(screen.getByRole('heading', { level: 1, name: '动手' }).className).toContain('text-title');
    expect(screen.getByRole('heading', { level: 3, name: '小标题' }).className).toContain('text-body');
  });

  test('look 只换字号档、不换标题级别', () => {
    render(
      <Title level={2} look={1}>
        用途名
      </Title>,
    );
    expect(screen.getByRole('heading', { level: 2, name: '用途名' }).className).toContain('text-title');
  });

  test('truncate 一行放不下用省略号', () => {
    render(<Title truncate>很长的名字</Title>);
    expect(screen.getByRole('heading').className).toContain('truncate');
  });
});
