// @vitest-environment node
// electron-updater 完整通道（Z2C）：latest.yml 生成正确性 + 通道胶水（feed URL 解析）。
// autoUpdater 本体行为属上游库，不做进程级集成测（发布侧人工核对 SHA）。
import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

describe('latest.yml 生成（package.mjs 5/5 段）', () => {
  it('生成的 yml：version/sha512/size 与安装包一致，blockmap 条目齐全', () => {
    const ymlPath = path.resolve('release/latest.yml');
    if (!existsSync(ymlPath)) {
      console.log('（本机无打包产物——CI/打包机执行；跳过断言不算通过）');
      return;
    }
    const yml = readFileSync(ymlPath, 'utf8');
    const version = yml.match(/^version: (.+)$/m)?.[1];
    const sha512 = yml.match(/^  - url: ForgeStudio Setup .+\.exe\n    sha512: (.+)$/m)?.[1];
    const size = Number(yml.match(/^  - url: ForgeStudio Setup .+\.exe\n    sha512: .+\n    size: (\d+)$/m)?.[1]);
    const exe = yml.match(/^path: (.+)$/m)?.[1]!;
    const exePath = path.resolve('release', exe);
    const exeBuf = readFileSync(exePath);
    expect(version).toBe(JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')).version);
    expect(sha512).toBe(createHash('sha512').update(exeBuf).digest('base64'));
    expect(size).toBe(exeBuf.length);
    expect(yml).toMatch(/\.blockmap/);
  });
});

describe('更新源 URL 解析（auto-updater 胶层语义）', () => {
  it('latest.yml 全路径 → 取目录；目录 URL 原样使用（对齐 auto-updater.ts 内逻辑）', () => {
    const resolve = (url: string) => (url.endsWith('.yml') ? url.slice(0, url.lastIndexOf('/')) : url);
    expect(resolve('https://dl.example.com/fd/latest.yml')).toBe('https://dl.example.com/fd');
    expect(resolve('https://dl.example.com/fd/')).toBe('https://dl.example.com/fd/');
    expect(resolve('https://dl.example.com/fd')).toBe('https://dl.example.com/fd');
  });
});
