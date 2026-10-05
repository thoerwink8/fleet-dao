import { describe, expect, it } from 'vitest';
import { annotation } from '../src/pr-fields.ts';

describe('Actions 注解', () => {
  it('报错是 error、提醒是 warning；% 和换行转义掉', () => {
    expect(annotation('缺了 100%\n第二行')).toBe('::error::缺了 100%25%0A第二行');
    expect(annotation('提醒：没贴类别标签', 'warning')).toBe('::warning::提醒：没贴类别标签');
  });
});
