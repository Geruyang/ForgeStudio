/**
 * 七工具注册表：名称与描述冻结（contracts ENGINEERING_TOOLS），
 * inputSchema 为手写 JSON Schema 字面量（与 zod 契约 schema 用测试双向对齐）。
 */
import { MCP_SERVER_INSTRUCTIONS, type EngineeringToolName } from '@forgedesk/contracts/mcp';

export interface JsonSchemaLiteral {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

export interface McpToolDefinition {
  name: EngineeringToolName;
  description: string;
  inputSchema: JsonSchemaLiteral;
}

/** ID 公共片段（与 contracts TaskIdSchema/OperationIdSchema 等正则一致） */
const taskIdField = {
  type: 'string',
  pattern: '^task-[0-9a-f-]{36}$',
  description: '任务 ID（task-<uuid>）',
};
const artifactIdField = {
  type: 'string',
  pattern: '^art-[0-9a-f-]{36}$',
  description: '产物 ID（art-<uuid>）',
};
const deviceBindingIdField = {
  type: 'string',
  pattern: '^dev-[0-9a-f-]{36}$',
  description: '设备绑定 ID（dev-<uuid>）',
};
const requestKeyField = {
  type: 'string',
  minLength: 8,
  maxLength: 200,
  description: '请求去重键：同键同参返回原操作，不重复副作用',
};
const verifierIdField = {
  type: 'string',
  minLength: 1,
  description: '验收定义 ID（必须来自用户认可的 profile；模型不可编造）',
};

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'engineering.inspect',
    description: '检查工程工具链状态、缺失项与当前源码快照（输入指纹）。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
        profileId: { type: 'string', minLength: 1, description: '工程 profile ID' },
      },
      required: ['taskId', 'profileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'engineering.build',
    description: '受控构建：执行 profile 固定构建命令，采集产物（sha256/归档副本），执行前后输入指纹复核。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
        profileRevision: {
          type: 'integer',
          minimum: 0,
          description: '可选：调用方持有的 profile 修订号（与当前不一致则拒绝构建）；省略时按当前修订执行',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'engineering.test',
    description: '固定验收执行：按 verifierId 运行冻结验收命令并判定（退出码/输出规则）；验收状态只能由执行器点亮。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
        verifierId: verifierIdField,
        artifactId: artifactIdField,
        requestKey: requestKeyField,
      },
      required: ['taskId', 'verifierId'],
      additionalProperties: false,
    },
  },
  {
    name: 'device.bind',
    description: '绑定设备身份（USB VID/PID + 探针序列号）；须用户确认（授权卡片）后生效。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
        profileId: { type: 'string', minLength: 1, description: '工程 profile ID' },
        identity: {
          type: 'object',
          properties: {
            usbVid: { type: 'integer', minimum: 0, description: 'USB 厂商 ID' },
            usbPid: { type: 'integer', minimum: 0, description: 'USB 产品 ID' },
            probeSerial: { type: 'string', description: '探针序列号（稳定身份）' },
            chipTarget: { type: 'string', description: '目标芯片（如 stm32f103cb）' },
            serialPort: { type: 'string', description: '当前串口位置（仅位置信息）' },
          },
          required: ['usbVid', 'usbPid'],
          additionalProperties: false,
        },
        identityEvidence: {
          type: 'string',
          minLength: 1,
          description: '身份证据：如何确认这块板就是目标板',
        },
      },
      required: ['taskId', 'profileId', 'identity', 'identityEvidence'],
      additionalProperties: false,
    },
  },
  {
    name: 'device.flash',
    description: '授权烧录：前置检查（产物哈希/设备连接/独占锁）+ 用户授权（指定设备+产物哈希+任务范围）后执行。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
        artifactId: artifactIdField,
        deviceBindingId: deviceBindingIdField,
        requestKey: requestKeyField,
      },
      required: ['taskId', 'artifactId', 'deviceBindingId', 'requestKey'],
      additionalProperties: false,
    },
  },
  {
    name: 'device.verify',
    description: '串口身份与行为验证：随机 nonce + buildId 回读校验，防旧日志/旧固件假通过。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
        verifierId: verifierIdField,
        deviceBindingId: deviceBindingIdField,
      },
      required: ['taskId', 'verifierId', 'deviceBindingId'],
      additionalProperties: false,
    },
  },
  {
    name: 'engineering.export',
    description: '导出交付包（目录）：manifest（任务/验收/快照/操作/证据/产物清单+哈希）+ 产物与证据日志副本；不含任何凭证。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: taskIdField,
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
] as const;

/** 工具名 → runner HTTP 操作路由 */
export const TOOL_ROUTE: Record<EngineeringToolName, string> = {
  'engineering.inspect': '/api/ops/inspect',
  'engineering.build': '/api/ops/build',
  'engineering.test': '/api/ops/test',
  'device.bind': '/api/ops/device-bind',
  'device.flash': '/api/ops/device-flash',
  'device.verify': '/api/ops/device-verify',
  'engineering.export': '/api/ops/export',
};

export { MCP_SERVER_INSTRUCTIONS };
