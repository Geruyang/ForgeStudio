/**
 * 失败详情呈现：FailureKind → 中文标签；
 * 引擎/工具原始（多为英文）错误保留在折叠区，附原始日志引用（logRef）。
 */
import { Collapse } from './Collapse';
import { Badge } from './Badge';
import { failureLabel } from '../../lib/labels';

export function ErrorDetail({
  kind,
  message,
  detail,
  logRef,
  compact = false,
}: {
  kind: string;
  message: string;
  detail?: string;
  logRef?: string;
  compact?: boolean;
}) {
  return (
    <div className="error-detail">
      <div className="error-card__head">
        <Badge tone="danger">{failureLabel(kind)}</Badge>
        {!compact && <span style={{ color: 'var(--text-dim)', fontSize: 11 }}>失败类型：{kind}</span>}
      </div>
      <div className="error-card__msg">{message}</div>
      {detail && (
        <Collapse summary="原始详情（工具/引擎输出）">
          <pre className="fd-pre">{detail}</pre>
        </Collapse>
      )}
      {logRef && (
        <div className="error-detail__logref">
          日志引用：<span className="fd-code">{logRef}</span>
        </div>
      )}
    </div>
  );
}
