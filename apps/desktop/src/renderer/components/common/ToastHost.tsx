import { useEffect } from 'react';
import { useAppStore } from '../../store/context';

const TOAST_LABEL: Record<'info' | 'success' | 'error', string> = {
  info: '提示',
  success: '成功',
  error: '错误',
};

export function ToastHost() {
  const toast = useAppStore((s) => s.toast);
  const clearToast = useAppStore((s) => s.clearToast);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => clearToast(), 6500);
    return () => clearTimeout(id);
  }, [toast, clearToast]);

  if (!toast) return null;
  return (
    <div className="toast-host" role="status">
      <div className={`toast toast--${toast.kind}`}>
        <span className="toast__kind">{TOAST_LABEL[toast.kind]}</span>
        <div>
          <div className="toast__text">{toast.text}</div>
          {toast.detail && <div className="toast__detail">{toast.detail}</div>}
        </div>
      </div>
    </div>
  );
}
