// 演示版按细节级别收数据：标题、原话、要改的文件、正在做的那一步、追问、提醒和操作记录里的原话。
import { beforeAll, describe, expect, test } from 'vitest';
import { createMockApi } from '../api/mock/server';
import type { Audit, Board, Notifications, TaskDetail } from '../api/types';
import { HIDDEN_TEXT, redactAudit, redactBoard, redactNotifications, redactTaskDetail } from './redact';

const NOW = Date.parse('2026-09-25T08:00:00Z');
let board: Board;
let detail: TaskDetail;
let notices: Notifications;
let audit: Audit;
let issueOf: (id: string) => { issueNumber: number; title: string } | undefined;

beforeAll(async () => {
  const api = createMockApi({ live: false, now: () => NOW });
  board = await api.board('r-orbit');
  const withTouches = board.tasks.find((t) => t.subtasks.some((s) => s.touches.length && s.activity?.step));
  if (!withTouches) throw new Error('假数据里要有一条正在做某一步、写了要改的文件的子任务');
  detail = await api.task(withTouches.id);
  notices = await api.notifications({ status: 'all', limit: 200 });
  audit = await api.audit({ limit: 200 });
  issueOf = (id) => {
    const t = api.state().tasks.find((x) => x.task.id === id)?.task;
    return t ? { issueNumber: t.issueNumber, title: t.title } : undefined;
  };
});

describe('只看状态和耗时（status）', () => {
  test('看板：标题换成编号，要改的文件、正在做的那一步都收起，状态和时间照旧', () => {
    const r = redactBoard(board, 'status');
    for (const [i, t] of r.tasks.entries()) {
      const orig = board.tasks[i];
      expect(t.title).toBe(`需求 #${t.issueNumber}`);
      expect(t.state).toBe(orig?.state);
      for (const s of t.subtasks) {
        expect(s.title).toMatch(/^子任务 [A-Z]$/);
        expect(s.touches).toEqual([]);
        expect(s.activity?.step).toBeUndefined();
      }
    }
    for (const n of r.now) {
      expect(n.taskTitle).toMatch(/^需求 #\d+$/);
      expect(n.text).toMatch(/(排队中|在干活)$/);
    }
    // 原来的对象不能被改（那是假后端的内部状态）
    expect(board.tasks.some((t) => !t.title.startsWith('需求 #'))).toBe(true);
  });

  test('任务详情：原话、为什么派给它、追问的内容都收起', () => {
    const r = redactTaskDetail(detail, 'status');
    expect(r.task.title).toBe(`需求 #${detail.task.issueNumber}`);
    expect(r.task.rawRequest).toBe(HIDDEN_TEXT);
    expect(r.task.specDir).toBeUndefined();
    expect(r.runs.every((x) => x.whyRoute === HIDDEN_TEXT)).toBe(true);
    for (const a of r.asks) {
      expect(a.options).toEqual([]);
      expect(a.answer).toBeUndefined();
    }
  });

  test('提醒：标题按种类说、正文收起；操作记录：理由收起', () => {
    const n = redactNotifications(notices, 'status', issueOf);
    expect(n.items.length).toBe(notices.items.length);
    for (const x of n.items) {
      expect(x.body).toBe(HIDDEN_TEXT);
      expect(x.title).toMatch(/^(需求 #\d+|有一件事|有东西)?(在等你拍板|卡住了)$|^日报$/);
    }
    const a = redactAudit(audit, 'status');
    expect(a.items.filter((e) => e.reason !== undefined).every((e) => e.reason === HIDDEN_TEXT)).toBe(true);
    expect(a.items.map((e) => e.action)).toEqual(audit.items.map((e) => e.action));
  });
});

describe('能看任务标题（titles）', () => {
  test('标题照旧，要改的文件和正在做的那一步照样收起', () => {
    const r = redactBoard(board, 'titles');
    expect(r.tasks.map((t) => t.title)).toEqual(board.tasks.map((t) => t.title));
    expect(r.tasks.flatMap((t) => t.subtasks).every((s) => s.touches.length === 0 && !s.activity?.step)).toBe(
      true,
    );
    expect(redactTaskDetail(detail, 'titles').task.rawRequest).toBe(HIDDEN_TEXT);
  });
});

describe('能看步骤清单和过程（process）', () => {
  test('原样给，不动', () => {
    expect(redactBoard(board, 'process')).toBe(board);
    expect(redactTaskDetail(detail, 'process')).toBe(detail);
    expect(redactNotifications(notices, 'process', issueOf)).toBe(notices);
    expect(redactAudit(audit, 'process')).toBe(audit);
  });
});
