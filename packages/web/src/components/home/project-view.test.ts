import { describe, expect, test } from 'vitest';
import { visibleForProject } from './project-view';

const orbit = { title: '甲', repo: 'acme/orbit' };
const site = { title: '乙', repo: 'acme/website' };
const machine = { title: '整机', repo: null };
const oldSnapshot = { title: '老快照' };

describe('看板按当前项目收', () => {
  test('还没选出项目：先都留着', () => {
    const items = [orbit, site, machine];
    expect(visibleForProject(items, undefined)).toBe(items);
  });

  test('只留这一仓的，和没挂仓的；别的仓藏掉', () => {
    expect(visibleForProject([orbit, site, machine, oldSnapshot], 'acme/orbit')).toEqual([
      orbit,
      machine,
      oldSnapshot,
    ]);
  });
});
