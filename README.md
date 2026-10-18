# ForgeStudio（ForgeDesk）

> Windows 工程 Agent 工作台：把**代码、固件和真实测试结果**一起交付的桌面产品。
> 模型驱动的工程任务闭环 + 真实硬件构建/验收 + 证据链留档，全程"不虚报"。

## 产品一句话

在 Windows 11 上，工程师创建带**验收单**的工程任务 → 模型（六家提供方任选）在真实工作区里
修复缺陷/实现功能 → 经产品内 MCP 工具执行**真实构建与固定验收** → 证据（输入指纹/产物哈希/
日志）落库形成可导出的交付包 → 本地 USB 设备或 SSH 远程板卡（如 Zynq UltraScale+）上的
构建/自检同样进入证据链 → 人工验收与导出。

## 核心能力（全部有实测记录，见 `docs/ACCEPTANCE.md`）

- **模型接入**：ChatGPT 订阅官方登录 + 火山方舟/智谱 GLM/通义千问/DeepSeek/Kimi API key
  产品内配置（key 只入产品引擎目录 provider.env，界面不回显）；模型列表直拉各家 /models 实测。
- **工程闭环**：任务 → 检查/构建/验证/导出 → 幂等操作 → A/B 级证据（内容指纹/B 级快照）→
  人工验收（manual 项 B 级人证）→ 交付包导出。
- **模型驱动缺陷修复全链**（A-12）：真实模型修复缺陷 → Node 侧独立核验 → MCP 工具留证 →
  验收点亮 → 导出，已实测（ChatGPT / 智谱 glm-5.3 双路径）。
- **真实硬件**：本地设备 fixture（绑定/授权/烧录/串口 nonce 验证，模拟 49 例）+ SSH 远程
  执行（FZ3B/ZU3EG 实机：板上 make 构建、多文件 C 工程与单元测试、产物取回、B 级快照×SSH）。
- **桌面体验**：多会话管理、上下文压缩、代码审阅（回合结构化面板）、token 用量、审批卡、
  更新通道（electron-updater generic 源，下载/安装均用户触发）。

## 仓库结构

```
apps/desktop        Electron 应用（main/preload/renderer/bridge + runner 桥）
packages/contracts  契约与协议类型（含生成自真实 CLI 的 codex 协议 schema）
packages/engineering-runner   工程执行器（存储/状态机/快照/证据/HTTP/MCP/设备适配）
packages/engineering-mcp      MCP 桥（7 工具：任务/检查/构建/验证/导出等）
packages/engine-adapter       引擎适配（JSONL 握手/回合/审批/补丁投影，真实子进程测试）
engineering/        profiles 与工程样例（wordcount 缺陷样例、FZ3B make/单测工程）
scripts/            冒烟/GUI 走查/模型端到端/打包/签名/走查恢复等工程脚本
docs/               项目状态、验收记录、构建手册、路线图、已知问题（本项目的"事实账本"）
```

## 状态（2026-10-19，v22）

- T1 软件闭环：**全部验收通过**（A-1…A-13 + A-C）；v22 安装包过完整验证关口
  （静默安装 → 13 步安装态冒烟 → GUI 走查 39 断言，含 FZ3B 实机 GUI 闭环）。
- T2 硬件：SSH 型目标（FZ3B/ZU3EG）实机闭环完成；STM32/probe-rs 路线暂缓（无板卡）。
- 发布物：NSIS 安装包（未签名——签名管线已接入，见 `docs/BUILD.md`；SmartScreen 可能告警属预期）。
- 工作规则：**不虚报、fixture 必须标注"模拟"、未知审批必答不静默**。所有"已验证"结论
  可在 `docs/ACCEPTANCE.md` 对应条目找到复现命令与证据位置。

## 开发

```powershell
npm ci            # 根（npm workspaces）
npm test          # contracts / runner / mcp / adapter 全量
# apps/desktop：npx vitest run（渲染层/主进程）
npm run build     # 全产物构建
npm run package   # NSIS 安装包（可选签名：FD_SIGN_* 环境变量，见 docs/BUILD.md）
```

环境与恢复细节（vendored codex 0.162.1、live 测试运行方式、安装目录）见 `docs/ENVIRONMENT.md`
与 `docs/BUILD.md`。

## License

私有项目（未附开源许可证）。
