#!/usr/bin/env node
/**
 * run-tests.mjs —— sample-tool 固定验收测试（ForgeDesk 评分规则；模型不可改写本文件）。
 *
 * 用例：
 *   T1 空输入不崩溃：stdin 为空、无参数时进程必须以退出码 0 正常结束 ——当前失败（缺陷未修复，可复现）
 *   T2 空文件输入不崩溃：空文件参数时同上 ——当前失败（同一缺陷）
 *   T3 正常统计正确（stdin 多行）：行数/字符数/最长行/非空行/预览全部符合预期 ——当前通过
 *   T4 字面文本参数：参数不是文件路径时按字面文本统计 ——当前通过
 *
 * 判定：任一用例失败 → 输出 TEST_FAILED 标记并以非 0 退出码结束；
 *       全部通过 → 输出 TESTS_PASSED 并以退出码 0 结束。
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = join(dirname(fileURLToPath(import.meta.url)), 'tool.mjs');
const failures = [];

function runTool({ args = [], stdin = '' } = {}) {
  return spawnSync(process.execPath, [tool, ...args], { input: stdin, encoding: 'utf8' });
}

function check(name, cond, detail) {
  if (cond) {
    console.log(`PASS ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

// T1 空输入不崩溃（任务书 §3.3 软件故事："修复这个工具在输入为空时崩溃的问题"）
{
  const r = runTool({ stdin: '' });
  const detail =
    r.status === 0 ? '' : `exit=${r.status}; stderr 首行=${(r.stderr || '').trim().split('\n')[0] || '(空)'}`;
  check('T1 空输入不崩溃（stdin 为空、无参数）', r.status === 0, detail);
}

// T2 空文件参数不崩溃（同一缺陷的另一入口）
{
  const dir = mkdtempSync(join(tmpdir(), 'forgedesk-sample-tool-'));
  const emptyFile = join(dir, 'empty.txt');
  writeFileSync(emptyFile, '');
  const r = runTool({ args: [emptyFile] });
  const detail =
    r.status === 0 ? '' : `exit=${r.status}; stderr 首行=${(r.stderr || '').trim().split('\n')[0] || '(空)'}`;
  check('T2 空输入不崩溃（空文件参数）', r.status === 0, detail);
  rmSync(dir, { recursive: true, force: true });
}

// T3 正常统计正确（stdin 多行输入）
{
  const r = runTool({ stdin: 'hello\nworld\n' });
  const expected = ['lines=2', 'chars=12', 'longestLine=5', 'nonEmptyLines=2', 'preview=hello'];
  const actual = (r.stdout || '').trim().split('\n');
  const ok =
    r.status === 0 && actual.length === expected.length && expected.every((l, i) => actual[i] === l);
  check('T3 正常统计正确（stdin 多行）', ok, `exit=${r.status}; stdout=${JSON.stringify(r.stdout)}`);
}

// T4 字面文本参数（参数不是文件路径）
{
  const r = runTool({ args: ['hello'] });
  const expected = ['lines=1', 'chars=5', 'longestLine=5', 'nonEmptyLines=1', 'preview=hello'];
  const actual = (r.stdout || '').trim().split('\n');
  const ok =
    r.status === 0 && actual.length === expected.length && expected.every((l, i) => actual[i] === l);
  check('T4 正常统计正确（字面文本参数）', ok, `exit=${r.status}; stdout=${JSON.stringify(r.stdout)}`);
}

console.log(`cases=4 passed=${4 - failures.length} failed=${failures.length}`);
if (failures.length > 0) {
  console.log(`TEST_FAILED 用例失败: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('TESTS_PASSED');
process.exit(0);
