/**
 * @forgedesk/contracts —— ForgeDesk 冻结契约入口。
 * 集成负责人（主 Agent）维护；并行 Agent 只读引用，禁止修改。
 */
export * from './common.ts';
export * from './engineering.ts';
export * from './device.ts';
export * from './device-adapter.ts';
export * from './profile.ts';
export * from './mcp-tools.ts';
export * from './runner-api.ts';
export * from './engine.ts';
export * from './ipc.ts';
export * from './protocol/index.ts';
