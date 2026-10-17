# 修复提示（fix-hint）

对应任务（任务书 §3.3 软件故事）："修复这个工具在输入为空时崩溃的问题。"

- 崩溃点：`tool.mjs` 中 `const preview = firstNonEmpty.slice(0, 20);`
- 根因：空输入（空 stdin / 空文件 / 空字面参数）时不存在任何非空行，`segments.find(...)` 返回 `undefined`，对 `undefined` 调用 `.slice()` 抛出未捕获 `TypeError`，进程以退出码 1 崩溃。
- 期望行为（修复后语义）：空输入时正常退出（退出码 0），输出全 0 统计与空 `preview`，例如：

  ```
  lines=0
  chars=0
  longestLine=0
  nonEmptyLines=0
  preview=
  ```

- 建议修复方向（任选其一，改动应最小化）：
  1. `firstNonEmpty` 判空回退为空字符串：`const firstNonEmpty = segments.find(...) ?? '';`
  2. 或仅对 preview 计算做空值保护：`const preview = (firstNonEmpty ?? '').slice(0, 20);`
- 修复后验证：`node run-tests.mjs` —— T1/T2 应转为 PASS，全部用例通过时输出 `TESTS_PASSED` 且退出码 0。
- 边界提醒：`run-tests.mjs`（评分规则）与 `sample-tool.profile.json`（验收定义）是验收契约，修复代码时**不得改动**这两个文件；也不得在 `tool.mjs` 内特判测试输入。
