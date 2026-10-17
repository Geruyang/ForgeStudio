# ForgeStudio 开发路线图（ZCode 阶段）

> 2026-10-17 起，开发环境由 Trae 迁移至 ZCode，工作目录 `E:\AiProject\agent-design\ForgeDesk-zcode\`。
> **所有后续开发输出只放入本目录**（用户指令）。本文档由集成负责人（ZCode 主会话）维护，
> 每完成一项即更新状态并同步 `PROJECT_STATE.md`。
> 沿用既有工作规则：不虚报、fixture 标注"模拟"、未知审批必答不静默、契约变更走集成负责人。

## 现状基线（v14，Z0 迁移后）

- T1 软件闭环已全部打通：A-13（工程面板驱动）与 A-12（模型驱动缺陷修复全链）均已验收；
  六家模型提供方（ChatGPT 订阅 + 智谱/Kimi/千问/DeepSeek/方舟）接入并实测。
- 安装包 v14（NSIS per-user）通过 A-10 安装态验收 + GUI 自动化走查；未签名。
- 测试基线：contracts 34 / runner 173+ / mcp 35 / adapter 50 / desktop 55+，全绿；typecheck 0 错误。
- 遗留缺陷：D-12a 背靠背验证 UI 偶发不刷新（数据层无损，观察中）。
- 阻塞：K-2 实机硬件（无板卡/探针）；K-3 git 已随 ZCode 环境解除（待启用验证）。

## Z0 迁移与基线（已完成 2026-10-17）

| # | 事项 | 状态 |
|---|---|---|
| Z0-1 | 目录迁移 ForgeDesk-trae → ForgeDesk-zcode（复制方案 + junction 重建） | ✅ typecheck 复验 0 错误 |
| Z0-2 | 旧目录清理（3.8GB 内容已删，空壳待重启删除；新目录 dist/缓存已清） | ✅ |
| Z0-3 | 路径引用修正（docs ×3、scripts ×2） | ✅ |
| Z0-4 | `git init` + 初始提交，验证 A 级证据 hasGit=true 路径（gitCommit/diffDigest） | ⬜ 建议 Z1 开工首日执行 |
| Z0-5 | 全量测试回归（五工作区 vitest）确认迁移零损 | ⬜ 建议 Z1 开工首日执行 |

## Z1 产品补全（P1，建议顺序）

1. **模型列表直拉各家实测**：智谱 `/api/v1/models` 等 GET /models 兼容性核对，「拉取模型列表」
   按钮四家全验；设置页记住每厂商常用模型。
2. **D-12a 根修**：背靠背验证 UI 偶发不刷新——main→renderer IPC / MCP bridge stdio 响应投递
   竞态定位（加 main 侧事件遥测后深挖），修复后撤走走查重试兜底。
3. **turn usage 呈现**：token 计数在会话 UI 展示；未识别事件样本进诊断导出。
4. **should 级错误场景补齐**：M 场景 should 集（约 9 个）回归入库。
5. **会话增强**：多会话管理（重命名/删除/搜索）、上下文压缩（compact）入口。

## Z2 T3 顺延项 + 发布工程（P1-P2）

1. **B 级快照证据**：任务专属输入快照 + 独立产物目录（首发旗舰嵌入式工程）；启用前 UI 文案
   不得出现"防篡改构建"表述（P0-6 约束）。
2. **审阅面板增强**：评估引擎原生 `review/start` 接入。
3. **第二用户全项回归**：全新账号/机器走全套验收。
4. **代码签名**：证书/服务接入，消除 SmartScreen 告警；自动更新通道（electron-updater +
   更新源选型，注意 blockmap 已随包保留）。

## Z3 条件项（依赖外部输入）

1. **硬件实机闭环（T2，K-2 → A-14）**：待用户提供板卡 + 探针 + 串口。流程：手工
   构建→烧录→串口读取演练 → M6/M8/M9 实机用例 → probe-rs 烧录 + nonce/buildId 串口身份验证。
   设备 fixture（49 测试）已就绪，拿到硬件即可开工。
2. **远程实验室方向（长期评估）**：probe-rs `serve` 多用户令牌 + 探针级 ACL；Symphony
   编排规范对齐（多 Agent 场景）。

## 环境与工具备忘（ZCode 阶段）

- Node v24.21.0 / npm 11.19.0（与交付环境一致）；git CLI 可用（Git Bash）。
- Codex CLI 0.162.1 vendored 于 `tools/vendored/codex`（SHA-256 见 DECISIONS D1）。
- 迁移敏感点：**不得用会展开 junction 的工具复制本仓库**（robocopy 默认遍历 junction，
  会把 `node_modules/@forgedesk/*` 链接目标实体化）；如需迁移用 `robocopy /XJ` 或 git。
- 旧 `ForgeDesk-trae` 空目录壳：重启后删除（系统句柄锁定）。
- ZCode 环境已装的技能库（`~/.zcode/skills`，836 个）与 MCP（工作区 `.zcode/config.json`，
  20 个）属 agent-design 层级的环境资源，不属于本产品输出，不纳入本目录。
