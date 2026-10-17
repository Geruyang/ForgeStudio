# sample-tool —— T1 软件故事目标工程（fixture）

任务书 §3.3 软件故事："修复这个工具在输入为空时崩溃的问题。" 本目录是该故事的目标工程，作为 ForgeDesk
工程面板驱动软件任务闭环的验收对象。

**性质声明：真实代码、真实缺陷、真实测试（非 mock）。** 缺陷修复本身留给模型/用户在产品内完成——
"模型驱动的修复闭环"依赖模型凭证（当前本机无凭证，属阻塞项，见 docs/KNOWN_ISSUES.md K-1）；
不含模型参与时，本工程也可用工程面板（构建 + 固定验收 + 证据）驱动真实闭环。

## 文件清单

| 文件 | 作用 |
|---|---|
| `tool.mjs` | 被修复对象：统计文本行数/字符数的 CLI。**含真实缺陷**：输入为空（空 stdin / 空文件参数）时抛未捕获 TypeError 崩溃 |
| `run-tests.mjs` | 固定验收测试（评分规则，模型不可改写）：T1/T2 空输入不崩溃（**当前失败，可复现**）；T3/T4 正常统计正确（当前通过）。退出码非 0 = 验收失败，输出 `TEST_FAILED` 标记 |
| `build.mjs` | 构建步骤：语法检查 + 生成 `build-report.json` 构建产物（打印 BUILD_OK / BUILD_FAILED） |
| `fix-hint.md` | 修复提示（几行，不代修） |
| `sample-tool.profile.json` | 工程 profile（`EngineeringProfileSchema` 校验通过；verifier 以 passExitCode=0 + MustContain/MustNotContain 判定） |

## 当前状态（截至本文件创建时）

- `node run-tests.mjs` → **失败退出（预期状态：缺陷未修复）**，输出 `TEST_FAILED`
- `node tool.mjs "hello"` → 正常输出统计
- 修复 `tool.mjs` 后 `run-tests.mjs` 全绿（`TESTS_PASSED`）

## 手动验证命令

```powershell
cd engineering\fixtures\software\sample-tool
node tool.mjs "hello"          # 正常统计输出
node build.mjs                 # 构建通过（BUILD_OK + build-report.json）
node run-tests.mjs             # 验收失败（缺陷可复现；这是当前正确状态）
echo $null | node tool.mjs     # 复现空输入崩溃（stderr 含 TypeError）
```

注意：`build-report.json` 为构建生成的派生产物（已列入 `inputExcludes`，不参与输入指纹）。
