import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../adapters/test/helpers.ts';
import { artifactName, runtimeSourceHash } from '../src/build.ts';

describe('构建标识', () => {
  it('两种 Mac 对应不同产物；不支持的目标明确失败', () => {
    expect(artifactName('darwin', 'arm64')).toBe('mirasim-launcher-darwin-arm64');
    expect(artifactName('darwin', 'x64')).toBe('mirasim-launcher-darwin-amd64');
    expect(artifactName('win32', 'x64')).toBe('mirasim-launcher-windows-amd64');
    expect(() => artifactName('unknown', 'x64')).toThrow('平台或架构');
  });
  it('换行差异不造假升级，源码变化会改变标识；测试不改变运行产物标识', () => {
    const repo = tempDir();
    const dir = join(repo, 'packages', 'mirasim-reclaude', 'launcher');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'go.mod'), 'module fixture\ngo 1.22\n');
    writeFileSync(join(dir, 'main.go'), 'package main\nfunc main(){}\n');
    const first = runtimeSourceHash(repo);
    writeFileSync(join(dir, 'main.go'), 'package main\r\nfunc main(){}\r\n');
    expect(runtimeSourceHash(repo)).toBe(first);
    writeFileSync(join(dir, 'main_test.go'), 'test changes');
    expect(runtimeSourceHash(repo)).toBe(first);
    writeFileSync(join(dir, 'main.go'), 'package main\nfunc main(){println(1)}\n');
    expect(runtimeSourceHash(repo)).not.toBe(first);
  });
});
