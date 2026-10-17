/**
 * ForgeDesk 品牌标识（内联 SVG 手绘）：铁砧 + 火花，工程锻造意象。
 * 不依赖任何图标库；颜色取自设计系统 CSS 变量之外的固定品牌色。
 */
export function ForgeMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={{ display: 'block', flex: 'none' }}
    >
      {/* 砧座主体 */}
      <path
        d="M3 14.5h7.2c.6 1.9 2 3.2 3.8 3.6V20H8v-1.2c1.4-.3 2-1.1 2-2H3.8L3 14.5Z"
        fill="#f2a93b"
        opacity="0.92"
      />
      <path
        d="M3 14.5 3.8 16.8H10c0 .9-.6 1.7-2 2V20h6v-1.9c1.1-.3 2-.9 2.6-1.7"
        stroke="#c9882a"
        strokeWidth="0.7"
        fill="none"
      />
      {/* 砧角（尖塔尾） */}
      <path d="M3 14.5h7.2L9.4 12H4.6L3 14.5Z" fill="#37c5d8" opacity="0.9" />
      {/* 被锻造的工件 */}
      <rect x="12.4" y="12.6" width="8" height="1.8" rx="0.9" fill="#dbe5f1" opacity="0.95" />
      {/* 火花 */}
      <path d="M15.6 8.2 16.4 6m1.7 3.9 1.6-1.2m-4.9-.3-1-1.9" stroke="#f2a93b" strokeWidth="1.1" strokeLinecap="round" />
      {/* 底座 */}
      <rect x="10.2" y="20" width="5.6" height="1.6" rx="0.6" fill="#5d6f8a" opacity="0.9" />
    </svg>
  );
}

export function BrandLockup() {
  return (
    <span className="topbar__brand">
      <ForgeMark />
      <span>
        <span className="topbar__brand-name">
          Forge<em>Studio</em>
        </span>
        <span className="topbar__brand-sub" style={{ display: 'block' }}>
          工程 Agent 工作台
        </span>
      </span>
    </span>
  );
}
