#!/usr/bin/env node
/**
 * sample-tool —— 统计文本行数/字符数的小型 Node CLI。
 * ForgeDesk T1 软件故事（任务书 §3.3）目标工程 fixture：真实代码、真实缺陷、真实测试（非 mock）。
 *
 * 用法：
 *   echo "hello" | node tool.mjs        # 从 stdin 读取
 *   node tool.mjs <存在的文件路径>       # 从文件参数读取
 *   node tool.mjs "hello"               # 参数不是文件时视为字面文本
 *
 * 输出（每行一个 key=value）：
 *   lines=<行数（按 \n 计；结尾换行不计行）>
 *   chars=<字符数（按 Unicode 码点计，含换行符）>
 *   longestLine=<最长行的字符数>
 *   nonEmptyLines=<非空行数>
 *   preview=<首条非空行前 20 个字符>
 *
 * 已知缺陷（真实、可复现、未修复——修复留给模型/用户在产品内完成，见 fix-hint.md）：
 *   输入为空（空 stdin 或空文件参数）时不存在任何非空行，
 *   对 undefined 调用 .slice() 抛出未捕获 TypeError，进程以非 0 退出码崩溃。
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

const segments = text.split('\n');
const lineCount = text.endsWith('\n') ? segments.length - 1 : segments.length;
const charCount = [...text].length;
const longestLine = segments.reduce((max, seg) => Math.max(max, [...seg].length), 0);
const nonEmptyLines = segments.filter((seg) => seg.trim().length > 0).length;

// 输出预览：取首条非空行前 20 个字符。
// 缺陷所在：未校验"可能不存在非空行"。空输入时 firstNonEmpty 为 undefined，
// 下一行 .slice() 抛 TypeError 且未被捕获 → 进程崩溃（退出码 1）。
const firstNonEmpty = segments.find((seg) => seg.trim().length > 0);
const preview = firstNonEmpty.slice(0, 20);

process.stdout.write(
  `lines=${lineCount}\n` +
    `chars=${charCount}\n` +
    `longestLine=${longestLine}\n` +
    `nonEmptyLines=${nonEmptyLines}\n` +
    `preview=${preview}\n`,
);
