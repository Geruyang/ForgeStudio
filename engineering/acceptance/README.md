# engineering/acceptance —— 验收单模板与固定验收定义

> QA（Agent D）维护。模板随安装包分发（electron-builder extraResources：`engineering/ → resources\engineering`，
> fixtures 除外）；用户数据目录中的同名文件优先。

## 文件

- `task-templates.json`：任务创建时的验收单模板（schemaVersion=1）。

## 模板使用

1. 用户在 GUI 创建任务时从模板选择（如"软件缺陷修复任务"）；
2. 模板中 `kind: executable` 的条目在创建时绑定工程 profile 的对应能力：
   - `software.build-pass` → profile `build` 命令（退出码 0 + artifactsGlob 命中）
   - `software.defect-repro-clear` → profile 中的缺陷复现器 verifier（如 sample-tool 的
     `wordcount-empty-crash-repro`）：修复前复现崩溃（非 0 退出=复现成功），修复后同一入口
     退出码 0（复现消失）；判定只认真实退出码与输出
   - `software.fixed-acceptance` → profile `verifiers[]` 中用户选定的固定验收定义（verifierId 一致，
     按 `passExitCode` / `stdoutMustContain` / `stdoutMustNotContain` 判定，评分规则不可由模型改写）
   - `embedded.*` → 对应设备操作（build 产物哈希 / flash 回执 / verify 串口身份与行为）
3. `kind: manual` 的条目由用户在面板上手动确认（`manualRequired: true`）；
4. 条目字段与 contracts `AcceptanceItem`（packages/contracts/src/engineering.ts）及
   `CreateTaskRequest.acceptance`（packages/contracts/src/runner-api.ts）保持兼容。

## 关键语义：模型只能提议（proposed），用户采纳才生效

- 模型/引擎**不得**直接写验收条目：其提议的验收项进入 `proposed` 状态（`AcceptanceItemStatus`），
  在用户显式采纳前不参与 `computeTaskAcceptance` 判定；
- `verifierId` 指向的固定验收定义（评分规则）**不可由模型改写**；
- 验收通过状态只能由工程执行器依据真实执行结果点亮（contracts `computeTaskAcceptance` 是唯一判定入口，
  UI 不允许自行点亮通过）。

## 判定速查（computeTaskAcceptance）

- 必需项（`required: true`）全部 `passed` 且无 stale 证据 → 任务 `passed`；
- 任一必需项未通过，或存在 stale 证据 → 不通过（证据过期需重新验证）。
