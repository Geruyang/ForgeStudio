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

## Z1 产品补全（2026-10-17 完成）

1. ~~**模型列表直拉各家实测**~~ ✅ 方舟 35/智谱 3/千问 176 live 过；DeepSeek/Kimi 待 key。
2. ~~**D-12a 根修**~~ ✅ refreshTask 单飞合并 + updatedAt 防御（3 例回归）；安装态走查复验后撤重试兜底。
3. ~~**turn usage 呈现**~~ ✅ D19 已实现；补测试 + 修复会话切换残留。
4. ~~**should 级错误场景（可环境内部分）**~~ ✅ 中文/空格路径 + 二进制/大工程组合；余项见下。
5. ~~**会话增强**~~ ✅ 多会话管理（重命名/删除/搜索）+ compact 入口（Z1-5 纵切片）。

Z1 遗留（并入 Z2 或条件项）：
- should 场景余项：B级快照（随 Z2-1）、多型号热插拔/长串口（设备 fixture 扩展）、
  第二 Windows 用户全项回归（需环境）
- DeepSeek/Kimi 模型列表 live（待 key）
- 安装包重建（当前 v14 包不含 Z0/Z1 改动；下次打包时合并 D-12a 复验走查）

## Z2A 打包与安装态验证关口（**下一阶段最优先**，P0）

> 背景：Z0/Z1 全部改动（契约增量、会话管理、D-12a 修复、token 用量）只有 dev/测试级验证；
> 当前正式包仍是 v14。**安装态验证是本产品"不虚报"原则的关口**，D-12a 根修的复验也绑定在此。

| # | 事项 | 验收口径 |
|---|---|---|
| Z2-0 | 文档补漏：BUILD.md 补 vendored codex 恢复步骤（npm + DECISIONS D1 SHA-256 校验）；ENVIRONMENT.md 更新 git 可用（K-3 解除）与 live 测试运行方式（FD_LIVE_ENGINE_HOME） | 两文档与现状一致 |
| Z2-1 | 构建打包：`npm run build` → `npm run package`（NSIS v15），记录 SHA-256 与 git commit 对应 | 构建零错误，产物哈希入 PROJECT_STATE |
| Z2-2 | 安装态冒烟：smoke-runner.mjs 13 步工程闭环（A-13 深检口径）+ 引擎隔离冒烟 | 13 步全绿 |
| Z2-3 | GUI 走查扩展：gui-walkthrough.mjs **新增断言**——会话搜索/重命名/删除、压缩上下文入口、token 用量条；**背靠背"运行验证"×2 不重点直接点亮**（D-12a 复验）；全绿后撤走 7 步重试兜底 | 新功能走查 + D-12a 不复现 |
| Z2-4 | model-task-e2e 重跑（模型驱动工程闭环在新包上） | 全链通过 |
| Z2-5 | 阶段收尾：全量回归 + typecheck + PROJECT_STATE（v15）/ACCEPTANCE 记录 | 文档同步 |

## Z2B T3 顺延项（P1，Z2A 后可并行）

1. **B 级快照证据**：任务专属输入快照 + 独立产物目录（SourceSnapshot.snapshotPath 已预留）；
   启用前 UI 文案合规检查（不得出现"防篡改构建"表述）。
2. **审阅面板增强**：评估引擎原生 `review/start` 接入（协议方法存在，未消费）。
3. **should 余项**：设备 fixture 扩展——多型号热插拔身份变化、长串口流与旧日志边界组合。
4. **DeepSeek/Kimi 模型列表 live**（用户提供 key 后即测，live 测试框架已就绪）。
5. **第二 Windows 用户全项回归**（需用户创建第二账号环境）。

## Z2C 发布工程（P2，部分依赖用户提供）

1. **代码签名**：证书/服务选型，消 SmartScreen 告警（需用户提供证书或选定服务）。
2. **自动更新通道**：electron-updater + 更新源选型（generic provider 起步；blockmap 已随包保留）。
3. **发布物规范**：安装包 + SHA-256 + git commit 对应关系（git 已入库，发布可追溯）。

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

## Z4 评审后 backlog（2026-10-18，用户指令"列出已实现/未实现目标并安排后续工作"）

> 基线：v21（PROJECT_STATE 深度审查收尾）。T1 全部完成；T2 完成 SSH 变体（FZ3B/ZU3EG）；
> 剩余项分四类，均为**外部依赖或范围决策**，无产品缺陷性欠账（已知非缺陷观察项除外）。

### 已实现（存档口径，不再列入排期）

- T1 十二项验收（A-1/2/3/4/5/6/7/8/9/10/11/12/13 + A-C）全绿；六家模型提供方接入并实测；
  多会话管理、B 级快照、MCP 桥七工具 + elicitation 审批卡、SSH 凭据产品内管理、
  electron-updater 完整通道、审阅入口、token 用量呈现、bundle -91%。
- T2 SSH 变体：A-14-SSH（FZ3B 实机，含 make 工程与 semantic-video-search 用户项目、
  B 级快照×SSH 组合、GUI 走查 9d）；A-15 设备 fixture 49/49（模拟）。

### 未实现——按用户指示暂缓（恢复需用户明示）

| # | 事项 | 现状与重启条件 |
|---|---|---|
| Z4-A1 | STM32/probe-rs 实机（A-14 原路径：烧录→串口 nonce/buildId 验证） | **部分实证（2026-10-19，用户接板）**：fireDAP 烧录+读回校验、网口测试固件（新代码）构建烧录、产品级 SWD 验收闭环全通；剩：板上 ETH 数据通路板级问题（ARP 无应答，见 fixture README 排查记录）与串口 VCP 接线确认，通后补 nonce/buildId 身份验证 |
| Z4-A2 | 第二 Windows 用户全项回归 | 需第二账户环境（codex 线已做过限定范围验收，本线全项未做） |

### 未实现——依赖外部输入（阻塞）

| # | 事项 | 需要 |
|---|---|---|
| Z4-B1 | ~~DeepSeek~~/**Kimi** 模型列表 live | **DeepSeek 已完成（2026-10-18，用户提供 key：2 模型 + 推理 sanity，见 ACCEPTANCE）**；仅剩 Kimi 一家 key（用户指示暂缓，恢复即测） |
| Z4-B2 | ~~安装包代码签名~~ | **签名管线已完成（2026-10-19）：自签证书端到端验证通过，证书选型文档见 BUILD.md**；剩余动作=用户提供/购买真实证书（环境变量一配即签名） |
| Z4-B3 | ~~MXC 沙箱预置评估~~ | **已完成（2026-10-19，管理员授权）**：账户×2 + offline 防火墙规则已装，受限令牌实测；评估结论见 KNOWN_ISSUES（产品设备操作语义不变） |

### 未实现——可选增强（T3，按需排期）

1. ~~完整审阅面板 UI~~ ✅ **v22 完成（2026-10-19）**：审阅回合结构化呈现（状态/报告/文件），
   协议无 decision 能力不虚构；详见 PROJECT_STATE v22。
2. ~~设备授权卡与 SSH 目标的 UI 语义整合~~ ✅ **v22 完成**：远程设备卡并入设备区
   （凭据徽标=授权语义、远程计数、空态区分）。
3. ~~FZ3B 更大工程样例~~ ✅ **v22 完成**：多文件 C 工程 + 板上单元测试框架（实机验收通过）。
4. 远程实验室方向（probe-rs `serve` 多用户令牌 + 探针级 ACL）——长期评估，不排期。
5. 双引擎（Claude Agent SDK）——任务书裁定不进首发，维持备选。

### 观察项与平台边界（如实保留，不排期）

- ~~D-4b engine-adapter "patches" 用例偶发抖动~~ **已修复（2026-10-18）**：根因为 patch 落盘
  异步与 turn/completed 同步投影的乱序竞态（适配层真实缺陷），改同步落盘保序 + 顺序断言，
  20 轮压测全绿（见 KNOWN_ISSUES/ACCEPTANCE）。
- ~~环境残留：`release/win-unpacked/`~~ **已清理（2026-10-18）**；`release/` 与 `release-final/`
  包哈希复核均为 v21。
- 仅认证 Windows 11 x64；Win10/ARM64 未验证。测试环境已知项见 KNOWN_ISSUES D-12b/c/d。

### 执行顺序建议

1. ~~资源到位即做：Z4-B1~~ **DeepSeek 半项已完成（10-18）**；剩余：Kimi key 到位即测
   （用户暂缓中）；~~win-unpacked 清理~~ / ~~D-4b 复查~~ 均已完成。
2. ~~用户决策后做：Z4-B2（证书）、~~**Z4-B2 管线完成（10-19，待真实证书）、Z4-B3 完成（10-19）**~~；~~
   Z4-A1/A2（若恢复实机/第二用户）仍待用户明示。
3. ~~按需增强：Z4 可选 1–3~~ **全部完成（v22，2026-10-19，已过打包验证关口）**；
   可选 4/5 维持不排期。
4. **Z4 清单至此全部闭环（Kimi/Z4-A1/A2 用户暂缓项除外）**——后续仅剩：真实签名证书到位
   （一配即签，走 v23 验证关口）、暂缓项恢复。
