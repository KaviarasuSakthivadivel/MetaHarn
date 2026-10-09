// Small inline outline icons (Feather/Lucide-style: 16x16 viewBox, currentColor
// stroke, no fill) — used in place of emoji glyphs, which render inconsistently
// across platforms/fonts and read as slightly out of place in a dev tool.

interface IconProps {
  size?: number;
}

const base = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

/** The app icon's own ring mark — used in the TopBar next to the wordmark. Amber ramp, matching
 * theme.css's current --color-accent family (#f0a020 on dark, #d97706 on light) rather than
 * apps/desktop/assets/icon.svg's real Dock icon, which is violet: direct feedback rejected the
 * violet in-app theme in favor of a true-black-chrome/amber-accent look (see theme.css's own
 * top-of-file comment), and this mark sits right in that now-amber TopBar — recoloring it to
 * match keeps the one thing people actually look at coherent, at the cost of reopening the
 * Dock-icon mismatch that recoloring THIS to violet had closed. Flag if the Dock icon itself
 * should move to amber too rather than leaving it violet. */
export function AppMark({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect width="16" height="16" rx="3.5" fill="#FDF3E4" />
      <circle cx="8" cy="8" r="6.23" fill="#FBD9A0" />
      <circle cx="8" cy="8" r="4.79" fill="#F6B55C" />
      <circle cx="8" cy="8" r="3.44" fill="#F0A020" />
      <circle cx="8" cy="8" r="2.16" fill="#C97A0A" />
      <circle cx="8" cy="8" r="0.95" fill="#7A4608" />
    </svg>
  );
}

export function FolderIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M1.5 3.5c0-.55.45-1 1-1h3.2l1.3 1.5H13.5c.55 0 1 .45 1 1v7c0 .55-.45 1-1 1h-11c-.55 0-1-.45-1-1v-8.5Z" />
    </svg>
  );
}

export function ClockIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 4.75V8l2.25 1.5" />
    </svg>
  );
}

export function BranchIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="7.5" r="1.5" />
      <path d="M4.5 5v6" />
      <path d="M4.5 6.5c0 2.5 2 3.5 4 3.5h1.4M11.5 6V9" />
    </svg>
  );
}

export function ChatIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M2 3.5c0-.55.45-1 1-1h10c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H6.5L3.5 13.5V11H3c-.55 0-1-.45-1-1V3.5Z" />
    </svg>
  );
}

export function ForkIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="4" cy="3.4" r="1.5" />
      <circle cx="12" cy="3.4" r="1.5" />
      <circle cx="8" cy="13" r="1.5" />
      <path d="M4 4.9c0 3.1 0 3.1 4 3.1s4 0 4-3.1" />
      <path d="M8 8V11.5" />
    </svg>
  );
}

export function DatabaseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <ellipse cx="8" cy="3.6" rx="5.5" ry="2.1" />
      <path d="M2.5 3.6V8c0 1.16 2.46 2.1 5.5 2.1S13.5 9.16 13.5 8V3.6" />
      <path d="M2.5 8v4.4c0 1.16 2.46 2.1 5.5 2.1s5.5-.94 5.5-2.1V8" />
    </svg>
  );
}

export function TerminalIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.2 7 8l-2.5 1.8" />
      <path d="M8.5 10.5h3" />
    </svg>
  );
}

export function TrashIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M2.5 4.5h11" />
      <path d="M5.5 4.5v-1c0-.55.45-1 1-1h3c.55 0 1 .45 1 1v1" />
      <path d="M3.5 4.5 4.1 13c.05.85.75 1.5 1.6 1.5h4.6c.85 0 1.55-.65 1.6-1.5l.6-8.5" />
      <path d="M6.5 7v4.5M9.5 7v4.5" />
    </svg>
  );
}

export function WorktreeIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="2" y="5" width="7.5" height="7.5" rx="1.2" />
      <path d="M5.2 5V3.7c0-.55.45-1 1-1H13c.55 0 1 .45 1 1V10c0 .55-.45 1-1 1h-1.5" />
    </svg>
  );
}

export function LinkIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M6.3 9.7 9.7 6.3" />
      <path d="M6.9 4.3 8 3.2c1-1 2.7-1 3.7 0 1.03 1.02 1.03 2.68 0 3.7L10.6 8" />
      <path d="M9.1 11.7 8 12.8c-1 1-2.7 1-3.7 0-1.03-1.02-1.03-2.68 0-3.7L5.4 8" />
    </svg>
  );
}

export function MapIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M5.5 3 2 4.3v8.7l3.5-1.3 5 1.3 3.5-1.3V3l-3.5 1.3-5-1.3Z" />
      <path d="M5.5 3v8.7M10.5 4.3V13" />
    </svg>
  );
}

export function DownloadIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 2v8" />
      <path d="M4.75 7 8 10.25 11.25 7" />
      <path d="M2.5 12.5h11" />
    </svg>
  );
}

export function PlusIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 2.5v11M2.5 8h11" />
    </svg>
  );
}

export function ArchiveIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="2" y="2.5" width="12" height="3" rx="1" />
      <path d="M3 5.5V12c0 .55.45 1 1 1h8c.55 0 1-.45 1-1V5.5" />
      <path d="M6.5 8.5h3" />
    </svg>
  );
}

export function PlayIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base} fill="currentColor" stroke="none">
      <path d="M4.5 2.8c0-.7.75-1.15 1.35-.8l7 4.2c.6.36.6 1.24 0 1.6l-7 4.2c-.6.35-1.35-.1-1.35-.8V2.8Z" />
    </svg>
  );
}

export function GridIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1" />
    </svg>
  );
}

/** Drag-to-reorder handle (Sidebar.tsx's session cards) — dots, not the
 * usual stroke outline, since a grip glyph reads as "grabbable" through
 * filled weight, not a line drawing. */
export function GripIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none">
      <circle cx="6" cy="4" r="1.1" />
      <circle cx="10" cy="4" r="1.1" />
      <circle cx="6" cy="8" r="1.1" />
      <circle cx="10" cy="8" r="1.1" />
      <circle cx="6" cy="12" r="1.1" />
      <circle cx="10" cy="12" r="1.1" />
    </svg>
  );
}

export function SendIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 12.5V3.5" />
      <path d="M4 7.5 8 3.5l4 4" />
    </svg>
  );
}

/** Settings nav — "General" (Owned Engine). */
export function GearIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="8" cy="8" r="2.1" />
      <path d="M8 2.6v1.5M8 11.9v1.5M13.4 8h-1.5M4.1 8H2.6M11.6 4.4l-1.06 1.06M5.46 10.54 4.4 11.6M11.6 11.6l-1.06-1.06M5.46 5.46 4.4 4.4" />
    </svg>
  );
}

/** Settings nav — "Appearance". */
export function PaletteIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 2C4.69 2 2 4.69 2 8s2.69 6 6 6c.76 0 1.25-.62 1.25-1.25 0-.32-.13-.6-.33-.82a1.1 1.1 0 0 1-.3-.76c0-.63.5-1.17 1.17-1.17H11c1.66 0 3-1.34 3-3C14 4.13 11.31 2 8 2Z" />
      <circle cx="5" cy="7.2" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="7.3" cy="4.9" r="0.85" fill="currentColor" stroke="none" />
      <circle cx="10.2" cy="5.6" r="0.85" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Settings nav — "Model(s)". */
export function CpuIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
      <rect x="6.5" y="6.5" width="3" height="3" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4" />
    </svg>
  );
}

/** Settings nav — "About". */
export function InfoIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.3v3.6" />
      <circle cx="8" cy="5.1" r="0.15" fill="currentColor" />
    </svg>
  );
}

/** Settings nav — "Connectors" (MCP servers). */
export function PlugIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M6.3 2.5v3M9.7 2.5v3" />
      <path d="M4.3 5.5h7.4v2.3c0 2.1-1.65 3.8-3.7 3.8s-3.7-1.7-3.7-3.8V5.5Z" />
      <path d="M8 11.6V14" />
    </svg>
  );
}

/** TopBar — Inbox. Replaces the 🔔 emoji glyph, same reasoning as every other icon in this file
 * (see the top-of-file comment): emoji render inconsistently across platforms and read as out of
 * place next to a drawn icon set. */
export function BellIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M4 6.3c0-2.2 1.8-4 4-4s4 1.8 4 4v2.3l1.2 2.1H2.8L4 8.6V6.3Z" />
      <path d="M6.3 12.7c.2.85.9 1.3 1.7 1.3s1.5-.45 1.7-1.3" />
    </svg>
  );
}

/** A dismiss/close action — replaces a literal "×" character glyph (App.tsx's terminal-tab
 * toolbar), same reasoning as every other icon in this file: a typed character renders with
 * whatever weight/baseline the surrounding font happens to have, inconsistent with a drawn
 * stroke-width icon sitting right next to it in the same button row. */
export function CloseIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
    </svg>
  );
}

/** Rename — Sidebar.tsx's SessionCard and ProjectOverview.tsx's OverviewSessionCard. */
export function EditIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M10.2 2.8a1.3 1.3 0 0 1 1.84 0l1.16 1.16a1.3 1.3 0 0 1 0 1.84L5.4 13.6l-3.1.7.7-3.1 7.2-7.2Z" />
      <path d="M9 4l3 3" />
    </svg>
  );
}

/** Usage & Estimated Costs — cost figures. */
export function DollarIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8 1.5v13" />
      <path d="M11 4.2c0-1-1.2-1.7-3-1.7-2.1 0-3.3.9-3.3 2.2 0 3.1 6.3 1.5 6.3 4.5 0 1.4-1.4 2.3-3.3 2.3-1.9 0-3.2-.8-3.3-1.9" />
    </svg>
  );
}

/** Weekly Rewind — peak usage window. */
export function ZapIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M8.5 1.5 3 9h4l-1 5.5L13 7H9l1.5-5.5Z" strokeLinejoin="round" />
    </svg>
  );
}

/** Weekly Rewind — busiest day. */
export function CalendarIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <rect x="2" y="3" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12" />
      <path d="M5.5 1.5v3M10.5 1.5v3" />
    </svg>
  );
}

/** Weekly Rewind's "Sessions" stat tile — session activity at a glance. */
export function ActivityIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M1.5 8.5h3l1.5-4.5 3 9 1.5-4.5h3.5" strokeLinejoin="round" />
    </svg>
  );
}

/** TopBar — Weekly Rewind's own entry point. */
export function BarChartIcon({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" {...base}>
      <path d="M3 13.5v-4M8 13.5v-9M13 13.5v-6.5" />
    </svg>
  );
}
