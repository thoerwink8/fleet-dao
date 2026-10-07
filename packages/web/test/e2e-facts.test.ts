// e2e 读备库输出的校验（母单 #902）：认不出要明确失败，不能让用例拿着 undefined 往下走。
import { describe, expect, test } from 'vitest';
import { parseFacts } from '../e2e/support/facts.ts';

const good = {
  dbUrl: 'postgres://u@h/d',
  userId: 'u',
  username: 'n',
  password: 'p',
  tasks: { running: 'a', done: 'b', stalled: 'c', queued: 'd', failed: 'e', asking: 'f' },
  issues: { running: 1, done: 2, stalled: 3, queued: 4, failed: 5, asking: 6 },
  approvalNotificationId: 'z',
  alertNotificationId: 'w',
  pools: { carpool: 'c', solo: 's' },
};

describe('parseFacts', () => {
  test('形状对的照收', () => {
    expect(parseFacts(JSON.stringify(good)).tasks.asking).toBe('f');
  });
  test('不是 JSON：明确报错', () => {
    expect(() => parseFacts('备库失败')).toThrow('不是 JSON');
  });
  test('少了字段：说是哪一项', () => {
    const { alertNotificationId: _drop, ...bad } = good;
    expect(() => parseFacts(JSON.stringify(bad))).toThrow('alertNotificationId');
  });
});
