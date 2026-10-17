#!/usr/bin/env node
/**
 * build.mjs —— sample-tool 构建步骤（本工程无编译：构建 = 语法检查 + 生成构建报告）。
 * 成功：写出 build-report.json（构建产物，artifactsGlob 命中）并以退出码 0 结束，打印 BUILD_OK；
 * 失败：不写报告，打印 BUILD_FAILED 并以非 0 退出码结束。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const sources = ['tool.mjs', 'run-tests.mjs'];

const failed = [];
for (const file of sources) {
  const r = spawnSync(process.execPath, ['--check', join(root, file)], { encoding: 'utf8' });
  if (r.status !== 0) {
    failed.push({ file, stderr: (r.stderr || '').trim() });
  }
}

if (failed.length > 0) {
  for (const f of failed) {
    console.error(`语法检查失败: ${f.file}\n${f.stderr}`);
  }
  console.log('BUILD_FAILED');
  process.exit(1);
}

const report = {
  builtAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  checkedFiles: sources,
  ok: true,
};
writeFileSync(join(root, 'build-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log('BUILD_OK');
