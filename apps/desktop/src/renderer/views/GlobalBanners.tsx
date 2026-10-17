/**
 * 全局横幅（真实语义，不假造数据）：
 * 引擎未启动 / 模型认证缺失 / runner 不可用 / 设备不可用。
 */
import { useAppStore } from '../store/context';
import { AUTH_MODE_LABELS_ZH } from '../lib/labels';

export function GlobalBanners() {
  const engineStatus = useAppStore((s) => s.engineStatus);
  const engineDetail = useAppStore((s) => s.engineDetail);
  const authStatus = useAppStore((s) => s.authStatus);
  const appInfo = useAppStore((s) => s.appInfo);
  const runnerReachable = useAppStore((s) => s.runnerReachable);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const devices = useAppStore((s) => s.devices);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const pendingAuths = useAppStore((s) => s.pendingAuths);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const startNewConversation = useAppStore((s) => s.startNewConversation);
  const modelProviders = useAppStore((s) => s.modelProviders);

  const activeTask = tasks.find((t) => t.id === activeTaskId);
  const hasDeviceOps =
    activeTask?.operations.some((o) => o.type === 'device_bind' || o.type === 'device_flash' || o.type === 'device_verify') ??
    pendingAuths.length > 0;
  // 提供方 key 已配置即认证就绪（官方账号 authStatus.ok 同理）——不再展示"认证缺失"横幅
  const authReady = Boolean(authStatus?.ok) || modelProviders.some((p) => p.active && p.keyConfigured);

  return (
    <div data-testid="global-banners">
      {engineStatus === 'stopped' && (
        <div className="chat-banner" role="status" style={{ margin: '0 0 6px' }}>
          引擎未启动：尚未连接 Codex 引擎。发起或恢复一个会话后可用。
          <span className="chat-banner__spacer" />
          <button type="button" className="fd-btn fd-btn--small" onClick={() => void startNewConversation()}>
            发起会话
          </button>
        </div>
      )}
      {engineStatus === 'error' && (
        <div className="chat-banner chat-banner--incomplete" role="alert" style={{ margin: '0 0 6px' }}>
          引擎异常：{engineDetail ?? '未知错误（见诊断页）'}
        </div>
      )}
      {authStatus && !authReady && (
        <div className="auth-guide" role="alert" data-testid="auth-missing-banner" style={{ margin: '0 0 6px' }}>
          <div className="auth-guide__title">模型认证缺失（{AUTH_MODE_LABELS_ZH[authStatus.mode]}）</div>
          <div className="auth-guide__hint">
            还没有可用的模型凭证，无法发起模型会话。点击下方按钮打开设置：粘贴任一提供方（火山方舟/智谱/Kimi/千问/DeepSeek/OpenAI）的
            API key，或用「官方登录」完成 ChatGPT 授权；凭证只写入 ForgeStudio 自己的引擎目录，不影响其他 Codex 安装。
          </div>
          {appInfo?.engineHome && <div className="auth-guide__path">引擎目录 CODEX_HOME = {appInfo.engineHome}</div>}
          <div>
            <button type="button" className="fd-btn fd-btn--primary fd-btn--small" onClick={() => setSettingsOpen(true)}>
              去配置认证
            </button>
          </div>
        </div>
      )}
      {runnerReachable === false && (
        <div className="chat-banner chat-banner--incomplete" role="alert" style={{ margin: '0 0 6px' }}>
          工程执行器（runner）不可用：工程面板、设备与证据功能暂不可用，会话不受影响。可在诊断页查看详情。
        </div>
      )}
      {devices.length === 0 && hasDeviceOps && (
        <div className="chat-banner" role="status" style={{ margin: '0 0 6px' }}>
          设备不可用：未枚举到在线设备
          {diagnostics
            ? `（probe-rs：${diagnostics.probeRsAvailable ? '可用' : '不可用'}，串口：${diagnostics.serialPortsAvailable ? '可用' : '不可用'}）`
            : ''}
          ；已有证据保留显示，重新连接后需重新验证。
        </div>
      )}
    </div>
  );
}
