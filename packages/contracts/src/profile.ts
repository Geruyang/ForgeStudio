/**
 * ForgeDesk 工程 Profile：用户认可的构建/测试/设备配置（任务书 §9）。
 * 文件位于 engineering/profiles/*.profile.json；runner 加载后按 revision 冻结。
 * 冻结契约 v1 —— 集成负责人维护。
 */
import { z } from 'zod';

/** 命令定义：可执行路径 + 参数数组，禁止模型拼接任意 shell 字符串 */
export const ProfileCommandSchema = z.object({
  /** 可执行文件绝对或相对 profile 的路径 */
  exe: z.string().min(1),
  args: z.array(z.string()),
  /** 相对项目根的工作目录，缺省为项目根 */
  cwd: z.string().optional(),
  /** 环境白名单（键=值），不做通配透传 */
  env: z.record(z.string()).optional(),
  /** 单命令预算毫秒；runner 汇总为 profile 预算 */
  timeoutMs: z.number().int().positive().max(30 * 60 * 1000),
});

/** 软件验收定义：固定命令 + 判定规则（评分规则不可由模型改写） */
export const SoftwareVerifierSchema = z.object({
  verifierId: z.string().min(1),
  title: z.string().min(1),
  command: ProfileCommandSchema,
  /** 判定：exit code 必须 == passExitCode；stdout/stderr 可选匹配 */
  passExitCode: z.number().int().default(0),
  stdoutMustContain: z.array(z.string()).default([]),
  stdoutMustNotContain: z.array(z.string()).default([]),
  /** 输出上限（字节）防止刷屏入库 */
  outputLimitBytes: z.number().int().positive().max(10 * 1024 * 1024).default(2 * 1024 * 1024),
});

/** 固件身份命令：构建产物通过它回报 buildId（无法回报时运行版本标注"未独立确认"） */
export const FirmwareIdentitySchema = z.object({
  /** 串口验证时发送的身份请求命令（行） */
  requestLine: z.string().optional(),
  /** 期望响应包含 buildId 的前缀 */
  buildIdEchoPrefix: z.string().optional(),
});

/** 嵌入式设备配置 */
export const DeviceProfileSchema = z.object({
  chipTarget: z.string().min(1),
  /** USB 身份（探测枚举匹配） */
  identity: z.object({
    usbVid: z.number().int().nonnegative(),
    usbPid: z.number().int().nonnegative(),
    /** 无可靠序列号时绑定需要人工确认 */
    expectProbeSerial: z.boolean().default(false),
  }),
  serial: z.object({
    baudRate: z.number().int().positive().default(115200),
    /** nonce/buildId 验证协议行 */
    verifyProtocol: FirmwareIdentitySchema,
    responseTimeoutMs: z.number().int().positive().default(10000),
  }).optional(),
  /** 烧录命令：exe+args；占位符 ${artifact} 由 runner 替换为产物路径 */
  flashCommand: ProfileCommandSchema,
  /** 烧录预算毫秒（默认 300s，任务书 §6.2） */
  flashBudgetMs: z.number().int().positive().max(10 * 60 * 1000).default(300_000),
  /** 验证预算毫秒（默认 120s） */
  verifyBudgetMs: z.number().int().positive().max(10 * 60 * 1000).default(120_000),
  /** 烧录后读回校验命令（可选） */
  readbackCommand: ProfileCommandSchema.optional(),
});
export type DeviceProfile = z.infer<typeof DeviceProfileSchema>;

/** 完整工程 Profile */
export const EngineeringProfileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  revision: z.number().int().nonnegative(),
  title: z.string().min(1),
  kind: z.enum(['software', 'embedded']),
  /** 构建：产物 glob 相对项目根 */
  build: ProfileCommandSchema,
  artifactsGlob: z.array(z.string()).min(1),
  /** 验收定义集合（可执行项） */
  verifiers: z.array(SoftwareVerifierSchema),
  /** 嵌入式设备配置（kind=embedded 必填） */
  device: DeviceProfileSchema.optional(),
  /** 输入清单补充：显式参与的配置/锁文件（相对项目根） */
  inputIncludes: z.array(z.string()).default([]),
  /** 显式排除：仅限确认不参与构建的派生文件 */
  inputExcludes: z.array(z.string()).default([]),
});
export type EngineeringProfile = z.infer<typeof EngineeringProfileSchema>;

/** Profile 目录加载结果 */
export interface LoadedProfile {
  profile: EngineeringProfile;
  filePath: string;
  /** 文件内容摘要：绑定证据 */
  fileSha256: string;
}
