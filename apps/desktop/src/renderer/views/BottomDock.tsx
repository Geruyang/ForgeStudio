/**
 * 底部停靠：终端输出 / 测试结果 / 串口日志 / 产物 / 诊断 五页签。
 * 日志视图窗口化（默认只渲染最近 200 行，"加载更早"按批展开）——长流不整段渲染。
 */
import { useState, type ReactNode } from 'react';
import { useAppStore } from '../store/context';
import { Badge } from '../components/common/Badge';
import { formatClock, formatBytes, formatDuration, shortSha } from '../lib/format';
import { ARTIFACT_TYPE_LABELS_ZH, EVIDENCE_RESULT_LABELS_ZH, EVIDENCE_RESULT_TONE, failureLabel } from '../lib/labels';

const WINDOW_STEP = 200;

/** 窗口化渲染：从尾部往前展示 visible 条，"加载更早"扩窗 */
function LogWindow({ total, children }: { total: number; children: (start: number) => ReactNode }) {
  const [visible, setVisible] = useState(WINDOW_STEP);
  const start = Math.max(0, total - visible);
  return (
    <>
      {start > 0 && (
        <div style={{ paddingBottom: 6 }}>
          <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => setVisible((v) => v + WINDOW_STEP)}>
            ↑ 加载更早（还有 {start} 条）
          </button>
        </div>
      )}
      {children(start)}
    </>
  );
}

export function BottomDock() {
  const tab = useAppStore((s) => s.bottomTab);
  const setBottomTab = useAppStore((s) => s.setBottomTab);
  const terminal = useAppStore((s) => s.terminal);
  const testResults = useAppStore((s) => s.testResults);
  const serialLogs = useAppStore((s) => s.serialLogs);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const diagnostics = useAppStore((s) => s.diagnostics);
  const appInfo = useAppStore((s) => s.appInfo);
  const droppedEvents = useAppStore((s) => s.droppedEvents);
  const exportDiagnostics = useAppStore((s) => s.exportDiagnostics);
  const openArtifact = useAppStore((s) => s.openArtifact);
  const activeTask = tasks.find((t) => t.id === activeTaskId) ?? null;

  const tabs: Array<{ id: typeof tab; label: string; count?: number }> = [
    { id: 'terminal', label: '终端输出', count: terminal.length },
    { id: 'test', label: '测试结果', count: testResults.length },
    { id: 'serial', label: '串口日志', count: serialLogs.length },
    { id: 'artifacts', label: '产物', count: activeTask?.artifacts.length ?? 0 },
    { id: 'diagnostics', label: '诊断' },
  ];

  return (
    <section className="bottom">
      <div className="bottom__tabs" role="tablist">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`bottom__tab${tab === t.id ? ' bottom__tab--active' : ''}`}
            onClick={() => setBottomTab(t.id)}
          >
            {t.label}
            {t.count !== undefined && t.count > 0 && <span className="bottom__tab-count">{t.count}</span>}
          </button>
        ))}
      </div>
      <div className="bottom__pane">
        {tab === 'terminal' && (
          <LogWindow total={terminal.length}>
            {(start) =>
              terminal.length === 0 ? (
                <div style={{ color: 'var(--text-faint)' }}>暂无工具输出。会话中的命令与工程操作输出会聚合在这里。</div>
              ) : (
                terminal.slice(start).map((l, i) => (
                  <div className={`term-line${l.isError ? ' term-line--error' : ''}`} key={`${start + i}-${l.at}`}>
                    <span className="term-line__time">{formatClock(l.at)}</span>
                    <span className="term-line__source">{l.source}</span>
                    <span className="term-line__text">{l.text}</span>
                  </div>
                ))
              )
            }
          </LogWindow>
        )}
        {tab === 'test' &&
          (testResults.length === 0 ? (
            <div style={{ color: 'var(--text-faint)' }}>暂无验证结果。在验收单点"运行验证"后出现。</div>
          ) : (
            [...testResults].reverse().map((t, i) => (
              <div className="test-entry" key={i}>
                <Badge tone={EVIDENCE_RESULT_TONE[t.result]}>{EVIDENCE_RESULT_LABELS_ZH[t.result]}</Badge>
                <div style={{ flex: 1 }}>
                  <div className="test-entry__title">{t.title}</div>
                  {t.detail && (
                    <pre className="fd-pre" style={{ marginTop: 4, maxHeight: 140 }}>
                      {t.detail}
                    </pre>
                  )}
                  {t.logRef && (
                    <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                      日志：<span className="fd-code">{t.logRef}</span>
                    </div>
                  )}
                </div>
                <span className="test-entry__time">{formatClock(t.at)}</span>
              </div>
            ))
          ))}
        {tab === 'serial' && (
          <LogWindow total={serialLogs.length}>
            {(start) =>
              serialLogs.length === 0 ? (
                <div style={{ color: 'var(--text-faint)' }}>暂无串口数据。串口验证按轮次增量追加（nonce+buildId 校验）。</div>
              ) : (
                serialLogs.slice(start).map((l, i) => (
                  <div key={`${start + i}`} className={`serial-line${l.ok ? ' serial-line--ok' : ' serial-line--err'}`}>
                    <div className="serial-line__time">{formatClock(l.at)}</div>
                    <div style={{ whiteSpace: 'pre-wrap' }}>{l.text}</div>
                  </div>
                ))
              )
            }
          </LogWindow>
        )}
        {tab === 'artifacts' &&
          (!activeTask || activeTask.artifacts.length === 0 ? (
            <div style={{ color: 'var(--text-faint)' }}>暂无产物。</div>
          ) : (
            <table className="fd-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>路径</th>
                  <th>SHA-256</th>
                  <th>大小</th>
                  <th>buildId</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {activeTask.artifacts.map((a) => (
                  <tr key={a.id}>
                    <td>{ARTIFACT_TYPE_LABELS_ZH[a.type]}</td>
                    <td className="fd-table--text" title={a.path}>
                      {a.path}
                    </td>
                    <td>{shortSha(a.sha256)}</td>
                    <td>{formatBytes(a.sizeBytes)}</td>
                    <td>{a.buildId ?? '—'}</td>
                    <td>
                      <button type="button" className="fd-btn fd-btn--small" onClick={() => void openArtifact(a.path)}>
                        打开
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
        {tab === 'diagnostics' && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
              <button type="button" className="fd-btn fd-btn--small" onClick={() => void exportDiagnostics()}>
                导出诊断文件
              </button>
              {droppedEvents > 0 && (
                <Badge tone="warn">事件洪峰：已丢弃可替代中间投影 {droppedEvents} 条（审批/终态/证据未丢弃）</Badge>
              )}
            </div>
            <div className="diag-grid">
              <div className="diag-card">
                <div className="diag-card__title">应用</div>
                {appInfo ? (
                  <>
                    <DiagRow k="版本" v={`${appInfo.name} ${appInfo.version}`} />
                    <DiagRow k="Electron / Node" v={`${appInfo.electronVersion} / ${appInfo.nodeVersion}`} />
                    <DiagRow k="平台" v={appInfo.platform} />
                    <DiagRow k="数据目录" v={appInfo.dataDir} />
                    <DiagRow k="引擎目录" v={appInfo.engineHome} />
                    <DiagRow k="引擎 CLI" v={appInfo.engineCliPath} />
                  </>
                ) : (
                  <DiagRow k="状态" v="应用信息不可用" />
                )}
              </div>
              <div className="diag-card">
                <div className="diag-card__title">工程执行器（Runner）</div>
                {diagnostics ? (
                  <>
                    <DiagRow k="版本" v={diagnostics.runnerVersion} />
                    <DiagRow k="运行时长" v={formatDuration(diagnostics.uptimeMs)} />
                    <DiagRow k="存储" v={`${diagnostics.storagePath}${diagnostics.storageOk ? '' : '（异常）'}`} />
                    <DiagRow k="git" v={diagnostics.gitAvailable ? '可用' : '不可用'} />
                    <DiagRow k="probe-rs" v={diagnostics.probeRsAvailable ? diagnostics.probeRsPath ?? '可用' : '不可用'} />
                    <DiagRow k="串口" v={diagnostics.serialPortsAvailable ? '可用' : '不可用'} />
                    <DiagRow k="设备独占锁" v={diagnostics.activeDeviceLock ?? '（空闲）'} />
                    <DiagRow k="待授权操作" v={String(diagnostics.pendingAuthorizations)} />
                    {diagnostics.lastError && <DiagRow k="最近错误" v={failureLabel('internal_error') + '：' + diagnostics.lastError} />}
                  </>
                ) : (
                  <DiagRow k="状态" v="runner 不可用（未连接或未启动）" />
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function DiagRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="diag-row">
      <span className="diag-row__k">{k}</span>
      <span className="diag-row__v">{v}</span>
    </div>
  );
}
