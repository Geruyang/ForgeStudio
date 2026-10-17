/**
 * 补丁卡：变更文件清单 + 增删统计 + "查看差异"入口（打开侧滑差异面板）。
 */
import type { PatchView } from '../../lib/events';
import { CHANGE_TYPE_LABELS_ZH, CHANGE_TYPE_TONE } from '../../lib/labels';
import { Badge } from '../common/Badge';
import { useAppStore } from '../../store/context';

export function PatchCard({ patch }: { patch: PatchView }) {
  const openPatchDiff = useAppStore((s) => s.openPatchDiff);
  const additions = patch.additions ?? patch.files.filter((f) => f.changeType === 'added').length;
  const deletions = patch.deletions ?? patch.files.filter((f) => f.changeType === 'deleted').length;
  return (
    <div className="patch-card">
      <div className="patch-card__head">
        代码修改 · {patch.files.length} 个文件
        <span className="patch-card__stats">
          <span className="add">+{additions}</span> <span className="del">−{deletions}</span>
        </span>
        <button
          type="button"
          className="fd-btn fd-btn--small"
          onClick={() => openPatchDiff(patch.patchRef)}
          title={patch.patchRef}
        >
          查看差异
        </button>
      </div>
      {patch.files.map((f) => (
        <div className="patch-file" key={f.path}>
          <Badge tone={CHANGE_TYPE_TONE[f.changeType]}>{CHANGE_TYPE_LABELS_ZH[f.changeType]}</Badge>
          <span>{f.path}</span>
        </div>
      ))}
      {patch.files.length === 0 && <div className="patch-card__ref">（文件清单不可用：{patch.patchRef}）</div>}
    </div>
  );
}
