# engineering/fixtures/transcripts —— 引擎事件流 fixture（模拟）

> **模拟数据**：本目录事件流按 `packages/contracts/src/engine.ts` 的 `EngineEvent` 投影形状手工构造，
> **不是真实引擎会话录制**（本机无模型凭证，见 docs/KNOWN_ISSUES.md K-1）。用于 M2/M3 等 must 场景的
> 语义测试：审批配对、连接代次、停止语义、turn/completed 实际 status 检查。
> 由 QA（Agent D）维护；设备类 fixtures（virtual-probe/virtual-device）属 Agent C，不在本目录。

## 格式

- 每行一个 JSON 对象（JSONL），即一个 `EngineEvent` 投影事件
- `seq` 严格递增；`connectionGeneration` 表示引擎连接代次（子进程重启 +1）
- 时间戳为 ISO-8601（构造用固定值，非真实时间）

## 文件清单

| 文件 | 场景 | 用途 |
|---|---|---|
| `approval-basic.jsonl` | 单回合正常审批流：requested → resolved(accept) → 工具输出 → turn success | M2 审批应答与 requestId 配对基线 |
| `approval-stale-generation.jsonl` | 引擎重启（代次 1→2）：旧代次审批未应答即断连，新代次产生新 requestId | M2 窗口重载不错误放行、旧批准不得重放到新连接 |
| `stop-semantics.jsonl` | 用户停止：stopping → 工具收尾 → turn/completed(status=interrupted) → stopped | M3 停止有终态、不把中断显示成成功 |
| `stop-failure.jsonl` | 回合失败：error(model_failure) → turn/completed(status=failure) | M3 turn/completed 事件名之外必须检查实际 status |
