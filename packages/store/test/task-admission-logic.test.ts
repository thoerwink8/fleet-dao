import { describe, expect, it } from 'vitest';
import { canonicalExecutionInput } from '../src/task-admission-logic.ts';

describe('完整执行输入canonical的数组合同', () => {
  it('拒绝hole与附加属性数量对冲，不把两者静默丢成空数组', () => {
    const value = new Array(1);
    Object.defineProperty(value, 'extra', { value: 'private-input', enumerable: true });
    expect(() => canonicalExecutionInput(value)).toThrow();
  });
  it('拒绝中间hole与附加属性对冲，不返回非JSON文本', () => {
    const value = new Array(2);
    value[1] = 2;
    Object.defineProperty(value, 'extra', { value: 1, enumerable: true });
    expect(() => canonicalExecutionInput(value)).toThrow();
  });
  it('拒绝稠密数组的附加属性', () => {
    const value = [1];
    Object.defineProperty(value, 'extra', { value: 2, enumerable: true });
    expect(() => canonicalExecutionInput(value)).toThrow();
  });
  it('只允许规范数组索引，非枚举附加属性和symbol也不能静默丢弃', () => {
    const hidden = [1];
    Object.defineProperty(hidden, 'extra', { value: 2 });
    expect(() => canonicalExecutionInput(hidden)).toThrow();
    const symbolic = [1];
    Object.defineProperty(symbolic, Symbol('extra'), { value: 2 });
    expect(() => canonicalExecutionInput(symbolic)).toThrow();
  });
  it('拒绝非规范数字字符串属性，不能用01替代缺失index', () => {
    const value = new Array(1);
    Object.defineProperty(value, '01', { value: 1, enumerable: true });
    expect(() => canonicalExecutionInput(value)).toThrow();
  });
  it('拒绝空洞数组和继承的index', () => {
    expect(() => canonicalExecutionInput(new Array(1))).toThrow();
    const value = new Array(1);
    Object.setPrototypeOf(value, { 0: 1 });
    expect(() => canonicalExecutionInput(value)).toThrow();
  });
  it('普通嵌套JSON数组保留次序、空数组和原始字符串', () => {
    expect(canonicalExecutionInput({ z: [3, { b: [true, null, '  text\n'], a: [] }], a: [2, 1] })).toBe(
      '{"a":[2,1],"z":[3,{"a":[],"b":[true,null,"  text\\n"]}]}',
    );
  });
});
