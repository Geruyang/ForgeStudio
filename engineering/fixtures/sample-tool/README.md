# sample-tool —— T1 软件故事目标工程（fixture）

> **fixture 工程，用于演示/验收，非生产代码。**

任务书 §3.3 软件故事："修复这个工具在输入为空时崩溃的问题。" 本目录是该故事的目标工程
（wordcount 版），作为 ForgeDesk 工程面板驱动软件任务闭环的验收对象。
性质：真实代码、真实缺陷、真实测试（非 mock）。缺陷修复本身留给模型/用户在产品内完成——
"模型驱动的修复闭环"依赖模型凭证（当前本机无凭证，阻塞项见 docs/KNOWN_ISSUES.md K-1）。

> 同名先例：`engineering/fixtures/software/sample-tool/`（行数统计版，同一故事的另一实现）。
> 两者独立：本目录是任务书 §3.3 的 wordcount 版交付物，profile id 互不冲突
> （`sample-tool-wordcount` vs `sample-tool`）。

## 文件清单

| 文件 | 作用 |
|---|---|
| `tools/wordcount.mjs` | 被修复对象：统计文本词数的 CLI。**含真实缺陷**：空输入（空文件/空 stdin）时对 `null.length` 抛未捕获 `TypeError` 崩溃（非 0 退出） |
| `test/wordcount.test.mjs` | 固定验收测试（node:test；评分规则，模型不可改写）：T1 正常文本通过；T2 空输入当前崩溃（**缺陷复现用例**） |
| `fixtures/normal.txt` | 正常文本（12 词），T1/verifier `wordcount-normal` 输入 |
| `fixtures/empty.txt` | 0 字节空文件，T2/verifier `wordcount-empty-crash-repro` 输入 |
| `scripts/build.mjs` | 构建步骤：语法检查 + 生成 `build/build-manifest.json`（打印 BUILD_OK / BUILD_FAILED） |
| `forgedesk.profile.json` | 工程 profile（contracts `EngineeringProfileSchema` 校验通过；verifier 以 passExitCode + MustContain/MustNotContain 判定） |

## 当前状态（截至本文件创建时，均经实际运行验证）

- `node scripts/build.mjs` → 构建通过（BUILD_OK + build/build-manifest.json）
- `node tools/wordcount.mjs fixtures/normal.txt` → 输出 `words=12`（退出码 0）
- `node tools/wordcount.mjs fixtures/empty.txt` → **崩溃**（stderr 含 `TypeError`，退出码 1）——缺陷可复现
- `node test/wordcount.test.mjs` → T1 通过、T2 通过（T2 断言"当前会崩"，是缺陷复现器）

## 手动验证命令（工程根目录 = 本目录）

```powershell
node scripts/build.mjs                              # BUILD_OK
node tools/wordcount.mjs fixtures\normal.txt        # words=12
node tools\wordcount.mjs fixtures\empty.txt         # TypeError 崩溃（退出码 1）
node test\wordcount.test.mjs                        # node:test：T1 通过、T2 通过（复现器）
```

## 修复后如何验证（修复留给产品内完成）

缺陷：`tools/wordcount.mjs` 中 `const count = words.length;`——空输入时
`text.match(/\S+/g)` 为 `null`。最小修复：`const count = (words ?? []).length;`
（或先判空回退 `[]`）。修复后：

1. `node tools/wordcount.mjs fixtures\empty.txt` 应输出 `words=0` 且退出码 0；
2. `node test/wordcount.test.mjs` 的 **T2 将失败**（它断言"当前会崩"）——按预期翻转该用例为
   "空输入不崩溃且输出 words=0"（或删除复现用例），这是缺陷已修复的证据；
3. profile verifier `wordcount-empty-crash-repro`（passExitCode=1）在修复后也会**失败**：
   "复现器不再复现" 即缺陷已修复。该翻转的判定不在可执行验收内完成——**留给验收单人工项
   （人工复核 diff + 确认复现器翻转）**，防止以"改测试"代替"改代码"骗绿；
4. `wordcount-normal` 必须仍通过（无回归）；`node scripts/build.mjs` 必须仍 BUILD_OK。

注意：`test/wordcount.test.mjs`（评分规则）与 `forgedesk.profile.json`（验收定义）是验收契约，
修复代码时**不得改动**这两个文件来"直接通过"；也不得在 `wordcount.mjs` 内特判测试输入。

## profile verifier 语义速查

| verifierId | 判定 | 缺陷未修复时 | 修复后 |
|---|---|---|---|
| `wordcount-normal` | 退出码 0 且 stdout 含 `words=12`、不含 `TypeError` | ✅ 通过 | ✅ 应仍通过（无回归） |
| `wordcount-empty-crash-repro` | 退出码 1（非 0）且 stdout 不含 `words=0`（缺陷复现器） | ✅ 通过（复现成功） | ❌ 失败（复现消失=已修复；翻转判定归人工项） |
