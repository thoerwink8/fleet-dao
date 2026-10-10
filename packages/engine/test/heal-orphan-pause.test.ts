// #1739：巡检跳过时 healOrphanMaster 见暂停标记不能一律 return——驱动死了仍应开回。
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { franceReleasePauseBlocksHeal, readFranceTrainSlice } from '../src/real/canary.ts';

describe('franceReleasePauseBlocksHeal（#1739 返工：驱动死掉不挡开回）', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function layout(files: { marker?: boolean; state?: object | null }) {
    dir = mkdtempSync(join(tmpdir(), 'fleet-1739-heal-'));
    const markerPath = join(dir, 'release-train.paused');
    const statePath = join(dir, 'release-train.json');
    if (files.marker) writeFileSync(markerPath, '{}\n');
    if (files.state !== undefined && files.state !== null) {
      writeFileSync(statePath, `${JSON.stringify(files.state)}\n`);
    }
    return { markerPath, statePath };
  }

  it('标记在且驱动 pid 活着：挡', () => {
    const { markerPath, statePath } = layout({
      marker: true,
      state: { status: 'running', phase: 3, pid: 999001 },
    });
    expect(franceReleasePauseBlocksHeal({ markerPath, statePath, pidAlive: () => true })).toBe(true);
  });

  it('标记在、进度 running 但驱动已死：不挡（旧逻辑会在这里永远不开回）', () => {
    const { markerPath, statePath } = layout({
      marker: true,
      state: { status: 'running', phase: 2, pid: 999002 },
    });
    expect(franceReleasePauseBlocksHeal({ markerPath, statePath, pidAlive: () => false })).toBe(false);
  });

  it('标记在、进度 failed：不挡', () => {
    const { markerPath, statePath } = layout({
      marker: true,
      state: { status: 'failed', phase: 4, pid: 999003, why: '驱动没了' },
    });
    expect(franceReleasePauseBlocksHeal({ markerPath, statePath, pidAlive: () => true })).toBe(false);
  });

  it('没有标记：不挡', () => {
    const { markerPath, statePath } = layout({ marker: false, state: null });
    expect(franceReleasePauseBlocksHeal({ markerPath, statePath, pidAlive: () => true })).toBe(false);
  });

  it('标记在、没有进度文件：不挡', () => {
    const { markerPath, statePath } = layout({ marker: true, state: null });
    expect(franceReleasePauseBlocksHeal({ markerPath, statePath, pidAlive: () => true })).toBe(false);
  });

  it('readFranceTrainSlice：读出 status 与 pid', () => {
    dir = mkdtempSync(join(tmpdir(), 'fleet-1739-slice-'));
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'release-train.json');
    writeFileSync(statePath, JSON.stringify({ status: 'running', pid: 7, phase: 1 }));
    expect(readFranceTrainSlice(statePath)).toEqual({ status: 'running', pid: 7 });
  });
});
