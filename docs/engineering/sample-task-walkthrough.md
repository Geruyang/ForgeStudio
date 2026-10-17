# 示例任务操作手册：sample-tool 软件闭环（T1 Walkthrough）

> QA（Agent D）维护。用 `engineering/fixtures/sample-tool/`（wordcount 版，含真实空输入崩溃缺陷）
> 演示 T1 软件任务闭环：创建任务 → 验收单 → inspect → build → test → 查看证据 → 导出。
> 【fixture 工程，用于演示/验收，非生产代码】；**模型驱动部分待凭证**（KNOWN_ISSUES K-1）。

## 0. 前提

- 已安装并启动 ForgeDesk（或开发态 `npm run dev`）；
- 不需要模型凭证即可走完本文全部"工程面板驱动"步骤；仅 §7"模型驱动修复"需要凭证。

## 1. 目标工程

`engineering/fixtures/sample-tool/`（安装包内位于 `resources\engineering\fixtures\sample-tool`）：

| 文件 | 说明 |
|---|---|
| `tools/wordcount.mjs` | 词数统计 CLI；**真实缺陷**：空输入抛 `TypeError` 崩溃（退出码 1） |
| `test/wordcount.test.mjs` | 固定验收测试：T1 正常文本通过；T2 空输入崩溃复现 |
| `fixtures/normal.txt`（12 词）/ `fixtures/empty.txt`（0 字节） | 验收输入 |
| `forgedesk.profile.json` | 工程 profile（id `sample-tool-wordcount`）：build + 两个 verifier |

verifier 语义（缺陷未修复的当前态）：

| verifierId | 判定 | 当前结果 |
|---|---|---|
| `wordcount-normal` | 退出码 0 且 stdout 含 `words=12`、不含 `TypeError` | ✅ 通过 |
| `wordcount-empty-crash-repro` | 退出码 1（非 0=复现成功）且 stdout 不含 `words=0` | ✅ 通过（缺陷仍在） |

## 2. 创建任务与验收单

1. 工程面板 → 新建任务；
2. 项目根选 sample-tool 目录，profile 选择 `sample-tool-wordcount`；
3. 模板选 **"软件缺陷修复任务"**（`engineering/acceptance/task-templates.json`），得到 4 项验收单：
   - 构建通过（可执行，`software.build-pass`）
   - 缺陷复现器由红转绿（可执行，`software.defect-repro-clear`）
   - 无回归：固定验收仍通过（可执行，`software.fixed-acceptance`）
   - 人工复核代码差异（**人工必填**）
4. 任务创建后状态 `draft`；验收项 `pending`。

## 3. inspect（工具链检查）

- 操作：任务面板 → "检查环境"（`engineering.inspect`）；
- 期望：node 可用；missing 为空；`currentSnapshot.inputDigest` 生成（A 级输入指纹）；
- 证据说明：无 git 的机器上 `hasGit=false`，指纹走完整输入清单内容摘要（等价有效）。

## 4. build（受控构建）

- 操作："构建"（`engineering.build`，需授权的设备操作之外的操作直接执行）；
- 期望：退出码 0，`BUILD_OK`；产物 `build/build-manifest.json` 命中 artifactsGlob，其 sha256
  记入 Artifact 与证据；
- 失败样例（可演示 M4）：故意在 `scripts/build.mjs` 制造语法错误 → 构建失败，**日志保留**、
  验收"构建通过"项失败，**不会自动进入任何后续步骤**。

## 5. test（固定验收执行）

- 操作："运行验收"→ 选择 verifier（或"全部运行"）：
  - `wordcount-normal` → 通过（证据：退出码 0 + stdout `words=12`）；
  - `wordcount-empty-crash-repro` → **通过（含义=复现成功，缺陷仍在）**；
- 此时验收单状态：可执行项中"构建通过"✅；"由红转绿"/"无回归"取决于绑定方式——修复前
  `wordcount-normal` 已绿（无回归项过），但缺陷未修复（转绿项不满足）；
- **任务整体不通过**（必需项不全过）——这是当前正确状态：缺陷还没修。

## 6. 查看证据与导出

- 证据面板：每条证据含 operationId、输入指纹（inputDigest）、工具版本、退出码/输出判定、
  日志引用；证据绑定当前输入指纹；
- 输入变化演示（M5）：手工编辑 `fixtures/normal.txt` → 证据标 **stale**，已点亮项不再显示通过，
  需重新运行验收；
- 导出（`engineering.export`）：生成交付包（任务+验收+证据+产物哈希+版本清单），
  **不含任何凭证**（M1）；重启客户端后任务与证据仍可查看（T1 完成标准）。

## 7. 模型驱动修复（待凭证，K-1）

配置模型后（见 install-guide §2）：

1. 在会话中下达任务："修复 sample-tool 在输入为空时崩溃的问题"；
2. 模型定位（可读 fix 提示：`null.length`）→ 提交最小修复（如 `(words ?? []).length`）→ 差异面板
   逐文件审阅（引擎审批由你逐项 accept/decline）；
3. 修复后重新 build + test：
   - `wordcount-normal` 仍通过（无回归）；
   - 空输入退出码 0 输出 `words=0` → **`wordcount-empty-crash-repro` 失败 = 复现消失 = 已修复**；
   - 该"复现器翻转"判定由人工验收项确认（防"改测试骗绿"：`test/` 与 profile 是验收契约，
     模型不得改动）；
4. 人工复核差异 → 全部必需项过 → 任务 `passed`。

> 无凭证时：步骤 2-4 可由你手工改代码后走工程面板重复 §4-§6 完成（等效闭环，仅"模型驱动"一环
> 标记为未验证）。

## 8. 命令行等效（fixture 级自检，不依赖产品）

```powershell
cd engineering\fixtures\sample-tool
node scripts\build.mjs                          # BUILD_OK
node tools\wordcount.mjs fixtures\normal.txt    # words=12
node tools\wordcount.mjs fixtures\empty.txt     # TypeError 崩溃（退出码 1，缺陷复现）
node test\wordcount.test.mjs                    # T1 通过、T2 通过（复现器）
```

（以上四条已在本机实际运行，真实输出见 docs/ACCEPTANCE.md A-13。）
