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

/** The app icon's own ring mark (see apps/desktop/assets/icon.svg) — used
 * in the TopBar next to the wordmark so the in-app brand matches the real
 * app/dock icon instead of a generic emoji. Same colors, same proportions,
 * just a 16x16 viewBox instead of the source's 1024x1024. */
export function AppMark({ size = 16 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16">
      <rect width="16" height="16" rx="3.5" fill="#FCEEE0" />
      <circle cx="8" cy="8" r="6.23" fill="#FFD9A8" />
      <circle cx="8" cy="8" r="4.79" fill="#FFB35C" />
      <circle cx="8" cy="8" r="3.44" fill="#F2823F" />
      <circle cx="8" cy="8" r="2.16" fill="#E0630F" />
      <circle cx="8" cy="8" r="0.95" fill="#A83D0C" />
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
