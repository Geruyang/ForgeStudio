/**
 * HTTP 控制面请求 schema：契约工具输入 + 可选 requestKey 透传（幂等去重键）。
 * MCP 桥按契约 schema 校验后转发；GUI 可附带 requestKey 防连点重复副作用。
 */
import { z } from 'zod';
import type { OperationType } from '@forgedesk/contracts/engineering';
import {
  InspectInputSchema,
  BuildInputSchema,
  TestInputSchema,
  DeviceBindInputSchema,
  DeviceFlashInputSchema,
  DeviceVerifyInputSchema,
  ExportInputSchema,
} from '@forgedesk/contracts/mcp';

/** 操作路由 → 操作类型（与 contracts RUNNER_ROUTES 的 op* 路由一一对应） */
export const OP_ROUTES: Record<string, { type: OperationType }> = {
  '/api/ops/inspect': { type: 'inspect' },
  '/api/ops/build': { type: 'build' },
  '/api/ops/test': { type: 'test' },
  '/api/ops/device-bind': { type: 'device_bind' },
  '/api/ops/device-flash': { type: 'device_flash' },
  '/api/ops/device-verify': { type: 'device_verify' },
  '/api/ops/export': { type: 'export' },
};

/** 操作输入校验：契约 schema + 可选 requestKey */
export function OperationInputSchema(type: OperationType): z.ZodTypeAny {
  const base = (() => {
    switch (type) {
      case 'inspect':
        return InspectInputSchema;
      case 'build':
        return BuildInputSchema;
      case 'test':
        return TestInputSchema;
      case 'device_bind':
        return DeviceBindInputSchema;
      case 'device_flash':
        return DeviceFlashInputSchema;
      case 'device_verify':
        return DeviceVerifyInputSchema;
      case 'export':
        return ExportInputSchema;
      case 'manual_review':
        // 人工验收不走 /api/ops/:type（专用路由已另行校验）；此处仅满足穷尽性
        throw new Error('manual_review 无操作输入 schema（走 /acceptance/:itemId/manual-review）');
    }
  })();
  return base.extend({ requestKey: z.string().min(8).max(200).optional() });
}

/** 创建任务请求（contracts CreateTaskRequest 的 zod 化） */
export const CreateTaskRequestSchema = z.object({
  projectRoot: z.string().min(1),
  profileId: z.string().min(1),
  title: z.string().min(1),
  threadId: z.string().optional(),
  acceptance: z
    .array(
      z.object({
        kind: z.enum(['executable', 'manual']),
        verifierId: z.string().optional(),
        title: z.string().min(1),
        expected: z.string(),
        manualRequired: z.boolean(),
        required: z.boolean(),
      }),
    )
    .optional(),
});

/** 验收单更新请求：全量替换（用户/模板写入；模型只能 proposed；passed 只能由执行器点亮） */
export const AcceptanceUpdateSchema = z.object({
  items: z.array(
    z.object({
      id: z.string().optional(),
      kind: z.enum(['executable', 'manual']),
      verifierId: z.string().optional(),
      title: z.string().min(1),
      expected: z.string().optional(),
      manualRequired: z.boolean().optional(),
      status: z.enum(['pending', 'proposed', 'not_runnable']).optional(),
      required: z.boolean().optional(),
    }),
  ),
});

/** 人工验收判定（仅 kind=manual 项可调用；executable 保持执行器独占） */
export const ManualReviewSchema = z.object({
  decision: z.enum(['passed', 'failed']),
  note: z.string().max(500).optional(),
});

/** 取消请求（contracts CancelRequest） */
export const CancelRequestSchema = z.object({
  reason: z.enum(['user_stop', 'timeout', 'shutdown']),
});

/** 授权请求（contracts AuthorizeRequest：confirmedScope 必须与 PendingAuthorization 一致） */
export const AuthorizeRequestSchema = z.object({
  operationId: z.string().min(1),
  decision: z.enum(['approved', 'declined']),
  confirmedScope: z.object({
    deviceBindingId: z.string().optional(),
    artifactSha256: z.string().optional(),
    taskId: z.string().min(1),
  }),
});
