﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿﻿/**
 * 顶栏：品牌 | 项目切换 | 当前任务 | 模型 | 运行状态 | 设置/终端入口。
 */
import { useAppStore } from '../store/context';
import { BrandLockup } from '../components/brand/Logo';
import { StatusChip } from '../components/common/Badge';
import { ENGINE_STATUS_LABELS_ZH, ENGINE_STATUS_TONE, TASK_STATUS_LABELS_ZH, TASK_STATUS_TONE } from '../lib/labels';
import { truncate } from '../lib/format';
import { computeTaskAcceptance } from '../contracts/engineering';

export function TopBar() {
  const project = useAppStore((s) => s.project);
  const ensureProjectSelected = useAppStore((s) => s.ensureProjectSelected);
  const openExternalTerminal = useAppStore((s) => s.openExternalTerminal);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const setActiveTask = useAppStore((s) => s.setActiveTask);
  const models = useAppStore((s) => s.models);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const selectModel = useAppStore((s) => s.selectModel);
  const engineStatus = useAppStore((s) => s.engineStatus);
  const engineDetail = useAppStore((s) => s.engineDetail);
  const authStatus = useAppStore((s) => s.authStatus);
  const modelProviders = useAppStore((s) => s.modelProviders);
  const startNewConversation = useAppStore((s) => s.startNewConversation);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);

  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? null;
  const acceptance = activeTask
    ? computeTaskAcceptance({ acceptance: activeTask.acceptance, stale: activeTask.hasStaleEvidence })
    : null;
  // 提供方 key 已配置（或官方账号已登录）即视为认证就绪——不再提示"未登录"
  const providerReady = modelProviders.some((p) => p.active && p.keyConfigured);
  const authReady = Boolean(authStatus?.ok) || providerReady;

  return (
    <header className="topbar">
      <BrandLockup />
      <div className="topbar__sep" />
      <div className="topbar__field">
        <span className="topbar__field-label">项目</span>
        {project ? (
          <span className="topbar__field" title={project.root}>
            {project.name}
          </span>
        ) : (
          <span style={{ color: 'var(--text-faint)' }}>未选择</span>
        )}
        <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => void ensureProjectSelected()}>
          {project ? '切换' : '选择目录'}
        </button>
        {project && (
          <button
            type="button"
            className="fd-btn fd-btn--ghost fd-btn--small"
            title="打开系统外部终端（产品受控执行边界之外）"
            onClick={() => void openExternalTerminal()}
          >
            外部终端
          </button>
        )}
      </div>
      <div className="topbar__sep" />
      <div className="topbar__field topbar__task">
        <span className="topbar__field-label">任务</span>
        {tasks.length === 0 ? (
          <>
            <span style={{ color: 'var(--text-faint)' }}>无工程任务</span>
            <button type="button" className="fd-btn fd-btn--small" onClick={() => setTaskSetupOpen('create')}>
              新建
            </button>
          </>
        ) : (
          <>
            <select
              aria-label="当前任务"
              value={activeTaskId ?? ''}
              onChange={(e) => setActiveTask(e.target.value)}
              style={{ maxWidth: 210 }}
            >
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {truncate(t.title, 24)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="fd-btn fd-btn--ghost fd-btn--small"
              onClick={() => setTaskSetupOpen('create')}
              title="新建工程任务（验收单向导）"
            >
              新建
            </button>
            {activeTask && acceptance && (
              <StatusChip tone={TASK_STATUS_TONE[activeTask.status]} title={activeTask.id}>
                {TASK_STATUS_LABELS_ZH[activeTask.status]} · 验收 {acceptance.passedCount}/{acceptance.requiredTotal}
              </StatusChip>
            )}
          </>
        )}
      </div>
      <div className="topbar__sep" />
      <div className="topbar__field">
        <span className="topbar__field-label">模型</span>
        <select
          aria-label="模型"
          value={selectedModel ?? ''}
          onChange={(e) => void selectModel(e.target.value)}
          disabled={models.length === 0}
          style={{ maxWidth: 180 }}
          title={models.length === 0 ? '先在设置中配置 API key 或官方登录，即可选择模型' : undefined}
        >
          {models.length === 0 && <option value="">（配置认证后可选）</option>}
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName ?? m.id}
            </option>
          ))}
        </select>
      </div>
      <div className="topbar__spacer" />
      {/* 高频核心动作与常亮认证提醒：未登录时一键直达设置页的官方登录 */}
      <button
        type="button"
        className="fd-btn fd-btn--primary fd-btn--small"
        onClick={() => void startNewConversation()}
        title="发起新的模型会话"
        data-testid="topbar-new-session"
      >
        新会话
      </button>
      <div className="topbar__field" data-testid="engine-status">
        <span className="topbar__field-label">引擎</span>
        <StatusChip
          tone={ENGINE_STATUS_TONE[engineStatus]}
          pulse={engineStatus === 'starting' || engineStatus === 'stopping'}
          title={engineDetail ?? undefined}
        >
          {ENGINE_STATUS_LABELS_ZH[engineStatus]}
        </StatusChip>
      </div>
      {authStatus && !authReady && (
        <button
          type="button"
          className="fd-btn fd-btn--ghost fd-btn--small"
          style={{ color: 'var(--warn, #e0b040)' }}
          onClick={() => setSettingsOpen(true)}
          title="模型未登录——点击打开设置，配置 API key 或官方登录"
          data-testid="topbar-auth-warning"
        >
          模型未登录
        </button>
      )}
      <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => setSettingsOpen(true)}>
        设置
      </button>
    </header>
  );
}
