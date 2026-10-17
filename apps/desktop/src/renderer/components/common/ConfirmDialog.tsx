/**
 * 可复用确认弹窗：窗口关闭/退出（进行中烧录任务）由主进程负责发起，
 * renderer 只提供此组件供任意确认场景复用（取消操作/移除验收项等）。
 */
import { Modal } from './Modal';

export function ConfirmDialog({
  title,
  body,
  danger = false,
  confirmText = '确认',
  cancelText = '取消',
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  danger?: boolean;
  confirmText?: string;
  cancelText?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <div className="fd-form__row">
        <div style={{ whiteSpace: 'pre-wrap', color: 'var(--text-dim)' }}>{body}</div>
      </div>
      <div className="modal__foot" style={{ marginTop: 8 }}>
        <button type="button" className="fd-btn fd-btn--ghost" onClick={onCancel}>
          {cancelText}
        </button>
        <button
          type="button"
          className={`fd-btn ${danger ? 'fd-btn--danger' : 'fd-btn--primary'}`}
          onClick={onConfirm}
        >
          {confirmText}
        </button>
      </div>
    </Modal>
  );
}
