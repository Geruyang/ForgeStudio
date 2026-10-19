/**
 * 设置页（分组信息架构）：
 * ① 模型与账号（核心）：提供方/key/默认模型/认证状态/官方登录——认证通过即可选择模型，
 *    不依赖选择项目目录或开启会话；
 * ② 界面：语言/退出确认；
 * ③ 诊断与关于：引擎与 runner 状态/导出诊断/版本。
 */
import { useEffect, useState } from 'react';
import { useAppStore } from '../store/context';
import { Modal } from '../components/common/Modal';
import { Badge, StatusChip } from '../components/common/Badge';
import { AUTH_MODE_LABELS_ZH, ENGINE_STATUS_LABELS_ZH, ENGINE_STATUS_TONE } from '../lib/labels';
import { formatDuration } from '../lib/format';

export function SettingsView() {
  const open = useAppStore((s) => s.settingsOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const settings = useAppStore((s) => s.settings);
  const models = useAppStore((s) => s.models);
  const selectedModel = useAppStore((s) => s.selectedModel);
  const selectModel = useAppStore((s) => s.selectModel);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const authStatus = useAppStore((s) => s.authStatus);
  const appInfo = useAppStore((s) => s.appInfo);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const engineStatus = useAppStore((s) => s.engineStatus);
  const exportDiagnostics = useAppStore((s) => s.exportDiagnostics);
  const refreshAuth = useAppStore((s) => s.refreshAuth);
  const refreshModels = useAppStore((s) => s.refreshModels);
  const openEngineLogin = useAppStore((s) => s.openEngineLogin);
  const modelProviders = useAppStore((s) => s.modelProviders);
  const configureModelProvider = useAppStore((s) => s.configureModelProvider);
  const clearModelProvider = useAppStore((s) => s.clearModelProvider);
  const openProviderConsoleAction = useAppStore((s) => s.openProviderConsole);
  const fetchProviderModels = useAppStore((s) => s.fetchProviderModels);
  const [providerChoice, setProviderChoice] = useState<string>(() => modelProviders.find((p) => p.active)?.id ?? 'openai');
  const [providerKey, setProviderKey] = useState('');
  const [providerModel, setProviderModel] = useState('');
  const [providerBusy, setProviderBusy] = useState(false);
  const [providerModels, setProviderModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const chosen = modelProviders.find((p) => p.id === providerChoice) ?? modelProviders[0];
  // 认证就绪口径与顶栏/横幅一致：官方账号已登录，或任一提供方 key 已配置
  const providerReady = modelProviders.some((p) => p.active && p.keyConfigured);
  const authReady = Boolean(authStatus?.ok) || providerReady;

  if (!open) return null;
  return (
    <Modal title="设置" onClose={() => setSettingsOpen(false)}>
      <div className="fd-form">
        {/* ① 模型与账号（核心组） */}
        <div className="fd-form__section">
          <div className="fd-form__section-title">模型与账号</div>

          <div className="fd-form__row">
            <span className="fd-form__label">模型提供方</span>
            {chosen && (
              <>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <select
                    aria-label="模型提供方"
                    value={providerChoice}
                    onChange={(e) => {
                      setProviderChoice(e.target.value);
                      setProviderKey('');
                      // 恢复该厂商上次使用的模型（providerModelMemory；无记忆则留空手填）
                      setProviderModel(settings?.providerModelMemory?.[e.target.value] ?? '');
                      setProviderModels([]);
                    }}
                    data-testid="settings-provider-select"
                  >
                    {modelProviders.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                        {p.active ? '（当前）' : ''}
                      </option>
                    ))}
                  </select>
                  {chosen.keyConfigured ? <Badge tone="ok">已配置 key</Badge> : <Badge tone="warn">未配置</Badge>}
                  {chosen.active && <Badge tone="accent">当前使用</Badge>}
                  <button
                    type="button"
                    className="fd-btn fd-btn--ghost fd-btn--small"
                    onClick={() => void openProviderConsoleAction(chosen.id)}
                    title={chosen.consoleUrl}
                  >
                    获取 API key
                  </button>
                  {chosen.keyConfigured && !chosen.officialLogin && (
                    <button
                      type="button"
                      className="fd-btn fd-btn--ghost fd-btn--small"
                      onClick={() => void clearModelProvider(chosen.id)}
                      data-testid="settings-provider-clear"
                    >
                      清除
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 4 }}>
                  <input
                    type="password"
                    placeholder={`${chosen.envKey}（粘贴 API key，保存后不再显示）`}
                    value={providerKey}
                    onChange={(e) => setProviderKey(e.target.value)}
                    style={{ flex: '1 1 220px', minWidth: 200 }}
                    data-testid="settings-provider-key"
                    autoComplete="off"
                  />
                  {providerModels.length > 0 ? (
                    <select
                      aria-label="提供方模型"
                      value={providerModel}
                      onChange={(e) => setProviderModel(e.target.value)}
                      style={{ flex: '1 1 180px', minWidth: 160 }}
                      data-testid="settings-provider-model-select"
                    >
                      {providerModel && !providerModels.includes(providerModel) && (
                        <option value={providerModel}>{providerModel}（手填）</option>
                      )}
                      {providerModels.map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="text"
                      placeholder={chosen.modelHint}
                      value={providerModel}
                      onChange={(e) => setProviderModel(e.target.value)}
                      style={{ flex: '1 1 180px', minWidth: 160 }}
                      data-testid="settings-provider-model"
                    />
                  )}
                  {chosen.keyConfigured && (
                    <button
                      type="button"
                      className="fd-btn fd-btn--ghost fd-btn--small"
                      disabled={modelsLoading}
                      onClick={() => {
                        setModelsLoading(true);
                        void fetchProviderModels(chosen.id)
                          .then((list) => {
                            if (list.length > 0) setProviderModels(list);
                          })
                          .catch(() => undefined) // 拉取失败保持手填（401/超时属正常路径）
                          .finally(() => setModelsLoading(false));
                      }}
                      data-testid="settings-provider-fetch-models"
                    >
                      {modelsLoading ? '拉取中…' : '拉取模型列表'}
                    </button>
                  )}
                  <button
                    type="button"
                    className="fd-btn fd-btn--primary fd-btn--small"
                    disabled={providerBusy || providerKey.trim().length === 0}
                    onClick={() => {
                      setProviderBusy(true);
                      void configureModelProvider({
                        providerId: chosen.id,
                        apiKey: providerKey,
                        defaultModel: providerModel || undefined,
                      }).finally(() => {
                        setProviderBusy(false);
                        setProviderKey('');
                      });
                    }}
                    data-testid="settings-provider-save"
                  >
                    {providerBusy ? '保存中…' : '保存并启用'}
                  </button>
                </div>
                {chosen.planNote && (
                  <span className="fd-form__hint" data-testid="settings-provider-plan">
                    订阅：{chosen.planNote}
                  </span>
                )}
                <span className="fd-form__hint">
                  {chosen.officialLogin
                    ? 'OpenAI 支持账号订阅式官方登录（见下方「官方登录」）；也可直接粘贴 API key（按量计费）。'
                    : '粘贴 API key 保存即启用；key 只写入 ForgeStudio 自己的引擎目录，界面不再回显。'}
                  {' '}保存后即可在上方「默认模型」与顶栏选择该提供方的模型。
                </span>
              </>
            )}
          </div>

          <div className="fd-form__row">
            <span className="fd-form__label">默认模型</span>
            <select
              aria-label="默认模型"
              value={selectedModel ?? ''}
              onChange={(e) => void selectModel(e.target.value)}
              disabled={models.length === 0}
              data-testid="settings-model-select"
              title={models.length === 0 ? '配置 API key 或官方登录后即可选择' : undefined}
            >
              {models.length === 0 && <option value="">（配置认证后可选）</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.displayName ?? m.id}
                </option>
              ))}
            </select>
            <span className="fd-form__hint">认证通过即可选择（来自引擎或已配置提供方的真实模型列表），无需先选目录或开会话。</span>
          </div>

          <div className="fd-form__row">
            <span className="fd-form__label">认证状态</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {authStatus ? (
                <Badge tone={authReady ? 'ok' : 'warn'}>{AUTH_MODE_LABELS_ZH[authStatus.mode]}</Badge>
              ) : (
                <Badge tone="warn">未知</Badge>
              )}
              {authReady ? (
                <span style={{ color: 'var(--ok, #6fd18c)', fontSize: 12 }}>已就绪，可发起模型会话</span>
              ) : (
                authStatus?.accountHint && <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>{authStatus.accountHint}</span>
              )}
              <button
                type="button"
                className="fd-btn fd-btn--primary fd-btn--small"
                onClick={() => void openEngineLogin()}
                data-testid="settings-open-login"
              >
                官方登录
              </button>
              <button
                type="button"
                className="fd-btn fd-btn--ghost fd-btn--small"
                onClick={() => {
                  void refreshAuth();
                  void refreshModels();
                }}
                data-testid="settings-refresh-auth"
              >
                刷新认证状态
              </button>
            </div>
            <span className="fd-form__hint">
              「官方登录」打开带中文指引的终端窗口（ChatGPT 授权或改用 API key）；其他厂商直接粘贴 API key
              即可。凭证只写入 ForgeStudio 自己的引擎目录，不影响电脑上其他 Codex 安装。
            </span>
          </div>
        </div>

        {/* ② 界面 */}
        <div className="fd-form__section">
          <div className="fd-form__section-title">界面</div>

          <div className="fd-form__row">
            <span className="fd-form__label">界面语言</span>
            <select
              aria-label="界面语言"
              value={settings?.uiLanguage ?? 'zh-CN'}
              onChange={(e) => void saveSettings({ uiLanguage: e.target.value as 'zh-CN' | 'en-US' })}
              data-testid="settings-language"
            >
              <option value="zh-CN">简体中文（默认）</option>
              <option value="en-US">English</option>
            </select>
            <span className="fd-form__hint">当前首发以中文为准；English 为预留选项，界面文案尚未完全翻译。</span>
          </div>

          <label className="fd-check">
            <input
              type="checkbox"
              checked={settings?.confirmExitOnDeviceOp ?? true}
              onChange={(e) => void saveSettings({ confirmExitOnDeviceOp: e.target.checked })}
              data-testid="settings-confirm-exit"
            />
            退出/关窗前提示进行中的设备操作（烧录等）
          </label>
        </div>

        {/* ③ 诊断与关于 */}
        <div className="fd-form__section">
          <div className="fd-form__section-title">诊断与关于</div>

          <div className="fd-form__row">
            <span className="fd-form__label">引擎与执行器</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <StatusChip tone={ENGINE_STATUS_TONE[engineStatus]}>{ENGINE_STATUS_LABELS_ZH[engineStatus]}</StatusChip>
              {diagnostics ? (
                <>
                  <Badge tone={diagnostics.storageOk ? 'ok' : 'danger'}>存储{diagnostics.storageOk ? '正常' : '异常'}</Badge>
                  <Badge tone={diagnostics.gitAvailable ? 'ok' : 'warn'}>git {diagnostics.gitAvailable ? '可用' : '不可用'}</Badge>
                  <Badge tone={diagnostics.probeRsAvailable ? 'ok' : 'warn'}>
                    probe-rs {diagnostics.probeRsAvailable ? '可用' : '不可用'}
                  </Badge>
                  <Badge tone={diagnostics.serialPortsAvailable ? 'ok' : 'warn'}>
                    串口 {diagnostics.serialPortsAvailable ? '可用' : '不可用'}
                  </Badge>
                  <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>runner 运行 {formatDuration(diagnostics.uptimeMs)}</span>
                </>
              ) : (
                <Badge tone="warn">runner 不可用</Badge>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button type="button" className="fd-btn fd-btn--small" onClick={() => void exportDiagnostics()}>
                导出诊断文件
              </button>
            </div>
          </div>

          {appInfo && (
            <div className="fd-form__row">
              <span className="fd-form__hint">
                {appInfo.name} {appInfo.version} · Electron {appInfo.electronVersion} · Node {appInfo.nodeVersion}
                <br />
                数据目录：<span className="fd-code">{appInfo.dataDir}</span>
              </span>
            </div>
          )}

          {/* Z2C 更新检查 scaffold：仅比对与告知，不自动下载安装 */}
          <div className="fd-form__row">
            <span className="fd-form__label">更新检查</span>
            <UpdateCheckRow />
          </div>
        </div>
      </div>
    </Modal>
  );
}

function UpdateCheckRow() {
  const settings = useAppStore((s) => s.settings);
  const saveSettings = useAppStore((s) => s.saveSettings);
  const [feedUrl, setFeedUrl] = useState(settings?.updateFeedUrl ?? '');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [updater, setUpdater] = useState<{ status: string; version?: string; progress?: { percent: number } } | null>(null);

  useEffect(() => {
    const off = window.forgedesk.app.onUpdaterEvent?.((s: unknown) => setUpdater(s as { status: string; version?: string; progress?: { percent: number } }));
    void window.forgedesk.app.updaterState().then((r) => {
      if (r.ok) setUpdater(r.value as { status: string });
    }).catch(() => undefined); // 更新状态不可用不阻塞设置页
    return () => off?.();
  }, []);

  const check = async () => {
    setBusy(true);
    setResult(null);
    try {
      const url = feedUrl.trim();
      if (url !== (settings?.updateFeedUrl ?? '')) await saveSettings({ updateFeedUrl: url || undefined });
      if (!url) {
        setResult('请先填写更新源 URL');
        return;
      }
      const r = await window.forgedesk.app.checkUpdate();
      if (!r.ok) {
        setResult(`检查失败：${r.failure?.message ?? '未知错误'}`);
        return;
      }
      setResult(
        r.value.updateAvailable
          ? `发现新版本 ${r.value.latestVersion}（当前 ${r.value.currentVersion}）${r.value.notes ? `：${r.value.notes}` : ''}`
          : `已是最新版本（${r.value.currentVersion}）`,
      );
    } finally {
      setBusy(false);
    }
  };

  const download = async () => {
    setResult(null);
    const r = await window.forgedesk.app.updaterDownload();
    if (!r.ok) setResult(`下载失败：${r.failure?.message ?? '未知错误'}`);
  };

  const install = async () => {
    if (!window.confirm('安装更新将退出应用并运行安装器，确认继续？')) return;
    const r = await window.forgedesk.app.updaterInstall();
    if (!r.ok) setResult(`安装失败：${r.failure?.message ?? '未知错误'}`);
  };

  return (
    <div data-testid="update-check-row" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <input
        type="url"
        value={feedUrl}
        onChange={(e) => setFeedUrl(e.target.value)}
        placeholder="https://…/latest.yml（electron-updater 更新源）"
        aria-label="更新源 URL"
        data-testid="update-feed-url"
        style={{ flex: '1 1 260px', fontSize: 12, padding: '4px 8px' }}
      />
      <button type="button" className="fd-btn fd-btn--small" disabled={busy} onClick={() => void check()} data-testid="update-check-btn">
        {busy ? '检查中…' : '检查更新'}
      </button>
      {updater?.status === 'available' && (
        <button type="button" className="fd-btn fd-btn--small" onClick={() => void download()} data-testid="updater-download-btn">
          下载 {updater.version ?? ''}
        </button>
      )}
      {updater?.status === 'downloading' && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }} data-testid="updater-progress">
          下载中 {Math.round(updater.progress?.percent ?? 0)}%
        </span>
      )}
      {updater?.status === 'downloaded' && (
        <button type="button" className="fd-btn fd-btn--small fd-btn--primary" onClick={() => void install()} data-testid="updater-install-btn">
          重启并安装 {updater.version ?? ''}
        </button>
      )}
      {result && (
        <span style={{ fontSize: 11, color: 'var(--text-faint)', flexBasis: '100%' }} data-testid="update-check-result">
          {result}
        </span>
      )}
    </div>
  );
}
