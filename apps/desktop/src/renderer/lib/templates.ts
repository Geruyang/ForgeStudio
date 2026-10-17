/**
 * 内置验收模板（与 engineering/acceptance/task-templates.json 保持一致的 UI 端约定）。
 * 权威定义在 runner 侧；此处仅用于向导勾选，创建/更新由 runner 校验 verifierId。
 */
export interface TemplateAcceptanceItem {
  kind: 'executable' | 'manual';
  verifierId?: string;
  title: string;
  expected: string;
  manualRequired: boolean;
  required: boolean;
}

export interface TaskTemplate {
  templateId: string;
  title: string;
  profileKind: 'software' | 'embedded';
  summary: string;
  acceptance: TemplateAcceptanceItem[];
}

export const BUILTIN_TASK_TEMPLATES: TaskTemplate[] = [
  {
    templateId: 'software-bugfix',
    title: '软件缺陷修复任务',
    profileKind: 'software',
    summary: '定位→修改→受控验证→交付差异与证据。',
    acceptance: [
      {
        kind: 'executable',
        verifierId: 'software.build-pass',
        title: '构建通过',
        expected: '工程 profile 的 build 命令以退出码 0 结束，且 artifactsGlob 命中产物；产物 sha256 记入 Artifact 与证据。',
        manualRequired: false,
        required: true,
      },
      {
        kind: 'executable',
        verifierId: 'software.fixed-acceptance',
        title: '固定验收测试通过',
        expected: 'profile verifiers 指定的固定验收命令按规则判定通过；证据绑定当前输入指纹（A 级），输入变化后证据过期需重新验证。',
        manualRequired: false,
        required: true,
      },
      {
        kind: 'manual',
        title: '人工复核代码差异',
        expected: '用户在代码差异面板逐文件审阅修改，确认修复正确且无未说明的越权改动后手动确认。',
        manualRequired: true,
        required: true,
      },
    ],
  },
  {
    templateId: 'embedded-firmware-verify',
    title: '嵌入式固件验证任务',
    profileKind: 'embedded',
    summary: '固件构建→授权烧录→串口身份与行为验证→人工确认。',
    acceptance: [
      {
        kind: 'executable',
        verifierId: 'embedded.build-artifact-digest',
        title: '构建产物哈希记录',
        expected: '构建产物（ELF/BIN）的 sha256 写入 Artifact 并出现在任务证据中；烧录授权与回执绑定同一哈希。',
        manualRequired: false,
        required: true,
      },
      {
        kind: 'executable',
        verifierId: 'embedded.flash-receipt',
        title: '烧录回执',
        expected: '烧录工具回执已保存且操作状态为 succeeded；unknown/failed 时本项不通过，需先核验设备。',
        manualRequired: false,
        required: true,
      },
      {
        kind: 'executable',
        verifierId: 'embedded.serial-identity-behavior',
        title: '串口身份与行为验证',
        expected: '串口验证 nonce 匹配且 buildId 命中当前构建；身份不符/旧日志不算本轮证据。',
        manualRequired: false,
        required: true,
      },
      {
        kind: 'manual',
        title: '人工确认设备行为',
        expected: '用户目视确认板上行为（LED/串口输出等）与任务目标一致后手动确认。',
        manualRequired: true,
        required: true,
      },
    ],
  },
];
