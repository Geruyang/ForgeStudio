#!/usr/bin/env node
/**
 * wordcount —— 统计文本词数的小型 Node CLI（按空白分词）。
 * ForgeDesk T1 软件故事（任务书 §3.3）目标工程 fixture：真实代码、真实缺陷、真实测试（非 mock）。
 *
 * 用法：
 *   node tools/wordcount.mjs fixtures/normal.txt   # 文件参数
 *   type fixtures\normal.txt | node tools/wordcount.mjs   # stdin
 *
 * 输出：单行 `words=<词数>`
 *
 * 已知缺陷（真实、可复现、未修复——修复留给模型/用户在产品内完成，见 README"修复后如何验证"）：
 *   输入为空（空文件 / 空 stdin）时 `text.match(/\S+/g)` 返回 null，
 *   对 null 取 .length 抛出未捕获 TypeError，进程以非 0 退出码崩溃。
 *
 * 【fixture 工程，用于演示/验收，非生产代码】
 */
import { existsSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

function readInput() {
  if (argv.length > 0) {
    if (existsSync(argv[0])) {
      return readFileSync(argv[0], 'utf8');
    }
    return argv[0]; // 参数不是文件路径：视为字面文本
  }
  return readFileSync(0, 'utf8'); // stdin（fd 0）
}

const text = readInput();

// 缺陷所在：空输入时 words === null，下一行 null.length 抛 TypeError（未捕获 → 进程崩溃）。
const words = text.match(/\S+/g);
const count = words.length;

process.stdout.write(`words=${count}\n`);
