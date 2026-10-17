﻿﻿﻿/**
 * 任务向导：
 * - create：选项目目录（app.ensureProject）→ 选 profile（来自既有任务的 profile 信息 + 手动输入）
 *   → 勾选验收模板项 → 可增删手动项 → runner.createTask；
 * - acceptance：为当前任务追加验收项（模板勾选 + 手动项）。
 */
import { useMemo, useState } from 'react';
import type { CreateTaskRequest } from '../contracts/runner';
import { useAppStore, useStoreApi } from '../store/context';
import { Modal } from '../components/common/Modal';
import { Badge } from '../components/common/Badge';
import { ACCEPTANCE_KIND_LABELS_ZH } from '../lib/labels';
import { BUILTIN_TASK_TEMPLATES, type TemplateAcceptanceItem } from '../lib/templates';

const MANUAL_PROFILE = '__manual__';

interface DraftItem {
  kind: 'executable' | 'manual';
  verifierId: string;
  title: string;
  expected: string;
  manualRequired: boolean;
  required: boolean;
}

function fromTemplate(t: TemplateAcceptanceItem): DraftItem {
  return {
    kind: t.kind,
    verifierId: t.verifierId ?? '',
    title: t.title,
    expected: t.expected,
    manualRequired: t.manualRequired,
    required: t.required,
  };
}

function emptyManual(): DraftItem {
  return { kind: 'manual', verifierId: '', title: '', expected: '', manualRequired: true, required: true };
}

export function TaskWizard() {
  const mode = useAppStore((s) => s.taskSetupOpen);
  const setTaskSetupOpen = useAppStore((s) => s.setTaskSetupOpen);
  const project = useAppStore((s) => s.project);
  const ensureProjectSelected = useAppStore((s) => s.ensureProjectSelected);
  const tasks = useAppStore((s) => s.tasks);
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const createTask = useAppStore((s) => s.createTask);
  const addAcceptanceItems = useAppStore((s) => s.addAcceptanceItems);
  const storeApi = useStoreApi();

  const profiles = useMemo(() => {
    const map = new Map<string, string>();
    for (const t of tasks) map.set(t.profileId, `rev${t.profileRevision} · ${t.title}`);
    return [...map.entries()];
  }, [tasks]);
  const activeTask = tasks.find((t) => t.id === activeTaskId);

  const [templateId, setTemplateId] = useState<string>('software-bugfix');
  const [selected, setSelected] = useState<Record<number, boolean>>({ 0: true, 1: true, 2: true });
  const [title, setTitle] = useState('');
  const [profileChoice, setProfileChoice] = useState<string>(profiles[0]?.[0] ?? MANUAL_PROFILE);
  const [manualProfileId, setManualProfileId] = useState('');
  const [manualItems, setManualItems] = useState<DraftItem[]>([]);
  const [busy, setBusy] = useState(false);

  if (!mode) return null;
  const template = BUILTIN_TASK_TEMPLATES.find((t) => t.templateId === templateId) ?? BUILTIN_TASK_TEMPLATES[0];

  const chosen: DraftItem[] = [
    ...template.acceptance.filter((_, i) => selected[i]).map(fromTemplate),
    ...manualItems,
  ];

  const submit = async () => {
    setBusy(true);
    try {
      if (mode === 'create') {
        let root = project?.root;
        if (!root) {
          const ok = await ensureProjectSelected();
          if (!ok) return;
          root = storeApi.getState().project?.root;
          if (!root) return;
        }
        const profileId = profileChoice === MANUAL_PROFILE ? manualProfileId.trim() : profileChoice;
        if (!profileId) return;
        const req: CreateTaskRequest = {
          projectRoot: root,
          profileId,
          title: title.trim() || template.title,
          ...(activeTask?.threadId ? { threadId: activeTask.threadId } : {}),
          acceptance: chosen.map((i) => ({
            kind: i.kind,
            ...(i.verifierId ? { verifierId: i.verifierId } : {}),
            title: i.title.trim(),
            expected: i.expected.trim(),
            manualRequired: i.manualRequired,
            required: i.required,
          })),
        };
        await createTask(req);
      } else if (activeTask) {
        await addAcceptanceItems(
          activeTask.id,
          chosen.map((i) => ({
            kind: i.kind,
            ...(i.verifierId ? { verifierId: i.verifierId } : {}),
            title: i.title.trim(),
            expected: i.expected.trim(),
            manualRequired: i.manualRequired,
            required: i.required,
          })),
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const canSubmit =
    !busy &&
    chosen.length > 0 &&
    chosen.every((i) => i.title.trim().length > 0) &&
    (mode === 'acceptance' || (project?.root ?? false) || profileChoice !== MANUAL_PROFILE || manualProfileId.trim().length > 0);

  return (
    <Modal
      title={mode === 'create' ? '创建工程任务（验收单向导）' : `调整验收单 · ${activeTask?.title ?? ''}`}
      onClose={() => setTaskSetupOpen(false)}
      wide
    >
      {mode === 'create' && (
        <div className="fd-form">
          <div className="fd-form__row">
            <span className="fd-form__label">① 项目目录</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="fd-code">{project ? `${project.name} · ${project.root}` : '未选择'}</span>
              <button type="button" className="fd-btn fd-btn--small" onClick={() => void ensureProjectSelected()} data-testid="wizard-pick-project">
                {project ? '重选目录' : '选择项目目录'}
              </button>
            </div>
          </div>
          <div className="fd-form__row">
            <span className="fd-form__label">② 工程配置（profile）</span>
            <select
              aria-label="工程配置"
              value={profileChoice}
              onChange={(e) => setProfileChoice(e.target.value)}
              data-testid="wizard-profile-select"
            >
              {profiles.map(([id, label]) => (
                <option key={id} value={id}>
                  {id}（{label}）
                </option>
              ))}
              <option value={MANUAL_PROFILE}>手动输入 profileId…</option>
            </select>
            <span className="fd-form__hint">列表来自既有任务的 profile 信息；首次使用请手动输入 engineering/profiles 内的 profile id。</span>
            {profileChoice === MANUAL_PROFILE && (
              <input
                type="text"
                placeholder="如 sample-tool / forgedesk-self"
                value={manualProfileId}
                onChange={(e) => setManualProfileId(e.target.value)}
                data-testid="wizard-manual-profile"
              />
            )}
          </div>
          <div className="fd-form__row">
            <span className="fd-form__label">任务标题</span>
            <input
              type="text"
              value={title}
              placeholder={template.title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="wizard-title"
            />
          </div>
        </div>
      )}

      <div className="fd-form">
        <div className="fd-form__row">
          <span className="fd-form__label">③ 验收模板</span>
          <select aria-label="验收模板" value={templateId} onChange={(e) => { setTemplateId(e.target.value); setSelected({}); }} data-testid="wizard-template">
            {BUILTIN_TASK_TEMPLATES.map((t) => (
              <option key={t.templateId} value={t.templateId}>
                {t.title}（{t.profileKind === 'software' ? '软件' : '嵌入式'}）
              </option>
            ))}
          </select>
          <span className="fd-form__hint">{template.summary}</span>
        </div>

        <div className="fd-form__row">
          <span className="fd-form__label">勾选验收项</span>
          <div className="template-list">
            {template.acceptance.map((item, i) => (
              <label key={i} className={`template-item${selected[i] ? ' template-item--selected' : ''}`}>
                <input
                  type="checkbox"
                  checked={selected[i] === true}
                  onChange={(e) => setSelected((s) => ({ ...s, [i]: e.target.checked }))}
                />
                <span className="template-item__body">
                  <span className="template-item__row">
                    <Badge tone="info">{ACCEPTANCE_KIND_LABELS_ZH[item.kind]}</Badge>
                    <strong style={{ fontSize: 12.5 }}>{item.title}</strong>
                    {item.required && <Badge tone="accent">必需</Badge>}
                  </span>
                  <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{item.expected}</span>
                </span>
              </label>
            ))}
          </div>
        </div>

        <div className="fd-form__row">
          <span className="fd-form__label">手动验收项（可增删）</span>
          {manualItems.map((item, i) => (
            <div key={i} className="template-item">
              <span className="template-item__body">
                <span className="template-item__row">
                  <select
                    aria-label="类型"
                    value={item.kind}
                    onChange={(e) =>
                      setManualItems((arr) =>
                        arr.map((it, j) =>
                          j === i
                            ? { ...it, kind: e.target.value as DraftItem['kind'], manualRequired: e.target.value === 'manual' }
                            : it,
                        ),
                      )
                    }
                  >
                    <option value="manual">人工确认</option>
                    <option value="executable">可执行</option>
                  </select>
                  <input
                    type="text"
                    placeholder="标题（必填）"
                    value={item.title}
                    onChange={(e) => setManualItems((arr) => arr.map((it, j) => (j === i ? { ...it, title: e.target.value } : it)))}
                  />
                  {item.kind === 'executable' && (
                    <input
                      type="text"
                      placeholder="verifierId（可执行项必填）"
                      value={item.verifierId}
                      onChange={(e) => setManualItems((arr) => arr.map((it, j) => (j === i ? { ...it, verifierId: e.target.value } : it)))}
                    />
                  )}
                  <button type="button" className="fd-btn fd-btn--ghost fd-btn--small" onClick={() => setManualItems((arr) => arr.filter((_, j) => j !== i))}>
                    删除
                  </button>
                </span>
                <input
                  type="text"
                  placeholder="通过标准"
                  value={item.expected}
                  onChange={(e) => setManualItems((arr) => arr.map((it, j) => (j === i ? { ...it, expected: e.target.value } : it)))}
                />
              </span>
            </div>
          ))}
          <div>
            <button type="button" className="fd-btn fd-btn--small" onClick={() => setManualItems((arr) => [...arr, emptyManual()])} data-testid="wizard-add-manual">
              ＋ 添加手动项
            </button>
          </div>
        </div>
      </div>

      <div className="modal__foot" style={{ marginTop: 4 }}>
        <span style={{ marginRight: 'auto', fontSize: 11.5, color: 'var(--text-faint)' }}>
          共 {chosen.length} 项{mode === 'create' ? '，创建后仍可在工程面板调整' : ''}
        </span>
        <button type="button" className="fd-btn fd-btn--ghost" onClick={() => setTaskSetupOpen(false)}>
          取消
        </button>
        <button
          type="button"
          className="fd-btn fd-btn--primary"
          disabled={!canSubmit}
          onClick={() => void submit()}
          data-testid="wizard-submit"
        >
          {busy ? '提交中…' : mode === 'create' ? '创建任务' : '更新验收单'}
        </button>
      </div>
    </Modal>
  );
}
