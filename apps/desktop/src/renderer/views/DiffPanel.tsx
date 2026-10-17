/**
 * 代码差异侧滑面板：文件列表 + 增删行数 + 分块渲染的大差异。
 * >500 行只渲染首块，"继续加载"每次 +500 行；解析失败回退纯文本，不伪造结构。
 */
import { useMemo, useState } from 'react';
import { useAppStore } from '../store/context';
import { parseDiffText, type DiffFile } from '../lib/diff';
import { Badge } from '../components/common/Badge';
import { CHANGE_TYPE_LABELS_ZH } from '../lib/labels';

const CHUNK_LINES = 500;

export function DiffPanel() {
  const panel = useAppStore((s) => s.diffPanel);
  const closePatchDiff = useAppStore((s) => s.closePatchDiff);
  const [fileIndex, setFileIndex] = useState(0);
  const [lines, setLines] = useState(CHUNK_LINES);

  const files = useMemo<DiffFile[] | null>(() => parseDiffText(panel.content ?? undefined), [panel.content]);
  if (!panel.open) return null;
  const patch = panel.patch;

  const selected = files && files.length > 0 ? files[Math.min(fileIndex, files.length - 1)] : null;

  return (
    <div className="diffpanel-overlay" onMouseDown={(e) => e.target === e.currentTarget && closePatchDiff()}>
      <aside className="diffpanel" role="dialog" aria-label="代码差异" data-testid="diff-panel">
        <div className="diffpanel__head">
          <div>
            <div className="diffpanel__title">代码差异</div>
            {patch && (
              <div className="diffpanel__sub">
                {patch.files.length} 个文件 · <span className="add">+{patch.additions ?? '—'}</span>{' '}
                <span className="del">−{patch.deletions ?? '—'}</span> · <span className="fd-code">{patch.patchRef}</span>
              </div>
            )}
          </div>
          <button type="button" className="modal__close" aria-label="关闭差异面板" onClick={closePatchDiff}>
            ×
          </button>
        </div>
        <div className="diffpanel__body">
          {patch && patch.files.length > 0 && (
            <div className="diffpanel__files">
              {patch.files.map((f, i) => (
                <button
                  key={f.path}
                  type="button"
                  className={`diffpanel__file${files && i === fileIndex ? ' diffpanel__file--active' : ''}`}
                  onClick={() => {
                    setFileIndex(i);
                    setLines(CHUNK_LINES);
                  }}
                >
                  <Badge tone={f.changeType === 'deleted' ? 'danger' : f.changeType === 'added' ? 'ok' : 'info'}>
                    {CHANGE_TYPE_LABELS_ZH[f.changeType]}
                  </Badge>
                  <span className="fd-code">{f.path}</span>
                </button>
              ))}
            </div>
          )}
          <div className="diffpanel__content">
            {panel.loading && <div className="diffpanel__note">正在读取差异文本…</div>}
            {!panel.loading && !panel.content && (
              <div className="diffpanel__note">
                {panel.unavailableReason ?? '差异文本不可用'}
                <br />
                文件清单与增删统计来自引擎 patch/applied 事件，可先行审阅。
              </div>
            )}
            {panel.content && !files && (
              <pre className="fd-pre" style={{ maxHeight: '100%' }}>
                {panel.content}
              </pre>
            )}
            {files && selected && (
              <div className="diff-view" style={{ maxHeight: '100%' }}>
                <DiffFileView file={selected} maxLines={lines} onMore={() => setLines((n) => n + CHUNK_LINES)} />
              </div>
            )}
          </div>
        </div>
      </aside>
    </div>
  );
}

function DiffFileView({ file, maxLines, onMore }: { file: DiffFile; maxLines: number; onMore: () => void }) {
  const flat = useMemo(() => {
    const rows: Array<{ key: string; kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string }> = [];
    rows.push({ key: 'f', kind: 'hunk', text: file.fileName });
    for (let h = 0; h < file.hunks.length; h++) {
      const hunk = file.hunks[h];
      rows.push({ key: `h${h}`, kind: 'hunk', text: hunk.header });
      for (let i = 0; i < hunk.lines.length; i++) {
        const l = hunk.lines[i];
        rows.push({ key: `h${h}l${i}`, kind: l.type === 'add' ? 'add' : l.type === 'del' ? 'del' : 'ctx', text: l.text });
      }
    }
    return rows;
  }, [file]);

  const visible = flat.slice(0, maxLines);
  return (
    <>
      {visible.map((r) => (
        <div key={r.key} className={`diff-line diff-line--${r.kind === 'hunk' ? 'hunk' : r.kind === 'ctx' ? 'ctx' : r.kind}`}>
          {r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '} {r.text}
        </div>
      ))}
      {flat.length > maxLines && (
        <div style={{ padding: 8 }}>
          <button type="button" className="fd-btn fd-btn--small fd-btn--block" onClick={onMore} data-testid="diff-load-more">
            继续加载（剩余 {flat.length - maxLines} 行）
          </button>
        </div>
      )}
    </>
  );
}
