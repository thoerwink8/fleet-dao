// 演示版的流程配置说法不能带会让打包扫描失败的词。正式版那一句必须和需求一字不差。
import { describe, expect, test } from 'vitest';
import { scanText } from '../build/scan';
import { brand as cockpit } from './cockpit';
import { brand as demo } from './demo';

describe('流程配置的说法', () => {
  test('正式版小标那一句一字不差', () => {
    expect(cockpit.flow.fileName).toBe('.fleet/flow.json');
    expect(cockpit.flow.orgName).toBe('fleet-dao');
    expect(cockpit.flow.orgDefaultDetail).toBe(
      '这个项目没有 .fleet/flow.json，这一轮按 fleet-dao 的全组织默认流程配置派（每步模型顺序、验证几轮都用默认的）',
    );
  });

  test('演示版换掉文件名和组织名，扫不出 fleet', () => {
    const why = `流程配置认不出：不是合法的 JSON。改好仓里的 ${demo.flow.fileName}，合进主线、对账读成后自动恢复`;
    const text = [demo.flow.fileName, demo.flow.orgName, demo.flow.orgDefaultDetail, why].join('\n');
    expect(demo.flow.fileName).toBe('自己的流程配置文件');
    expect(demo.flow.orgName).toBe('组织');
    expect(scanText('演示版流程配置', text)).toEqual([]);
  });
});
