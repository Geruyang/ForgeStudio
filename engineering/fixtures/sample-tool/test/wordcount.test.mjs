#!/usr/bin/env node
/**
 * wordcount 固定验收测试（node:test 风格；fixture 评分规则，模型不可改写本文件）。
 *
 * 用例：
 *   T1 正常文本统计正确：`node tools/wordcount.mjs fixtures/normal.txt` 退出码 0 且输出 words=9 ——当前通过
 *   T2 空输入崩溃复现：`node tools/wordcount.mjs fixtures/empty.txt` 当前以非 0 退出码崩溃（TypeError）
 *      ——【缺陷复现用例】如实记录当前（未修复）行为；修复 tool.mjs 后本用例将失败，
 *        届时应按 README"修复后如何验证"将其翻转为"空输入不崩溃且输出 words=0"。
 *
 * 运行：node test/wordcount.test.mjs（工程根目录）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const tool = join(root, 'tools', 'wordcount.mjs');

function runTool(args) {
  return spawnSync(process.execPath, [tool, ...args], { cwd: root, encoding: 'utf8' });
}

test('T1 正常文本统计正确（fixtures/normal.txt → words=12，退出码 0）', () => {
  const r = runTool(['fixtures/normal.txt']);
  assert.equal(r.status, 0, `stderr=${r.stderr}`);
  assert.equal(r.stdout.trim(), 'words=12');
});

test('T2 空输入当前会崩溃（缺陷复现：fixtures/empty.txt 非 0 退出，stderr 含 TypeError）', () => {
  const r = runTool(['fixtures/empty.txt']);
  assert.notEqual(r.status, 0, '空输入仍正常退出——缺陷已被修复？请按 README 翻转本用例');
  assert.match(r.stderr, /TypeError/);
});
