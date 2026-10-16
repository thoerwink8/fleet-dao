import { ActivityFailure, TimeoutFailure } from '@temporalio/workflow';
import { describe, expect, it } from 'vitest';
import { failureOf } from '../src/workflows/kit.ts';

describe('failureOf：活动超时证据', () => {
  it('保留活动名、StartToClose 时长和最后一次心跳的引擎启动时刻', () => {
    const timeout = new TimeoutFailure(
      'activity StartToClose timeout',
      { engineStartedAt: '2026-10-16T12:00:00.000Z' },
      'START_TO_CLOSE',
    );
    const failed = new ActivityFailure(
      'runSegment 超时',
      'runSegment',
      'activity-1',
      'TIMEOUT',
      'old-engine',
      timeout,
    );

    expect(failureOf(failed, 'session:execute')).toMatchObject({
      source: 'session:execute',
      code: 'TIMEOUT_START_TO_CLOSE',
      activity: 'runSegment',
      startToCloseSeconds: 4500,
      engineStartedAt: '2026-10-16T12:00:00.000Z',
    });
  });
});
