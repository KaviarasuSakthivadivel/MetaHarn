import { FolderIcon } from "./icons.js";

/** The accent-soft rounded-square folder glyph — previously hand-rolled independently in
 * ProjectsListPage.tsx (twice: the project row, and the empty-state) and absent entirely from
 * ProjectOverview.tsx's own header, which left the folder-you're-inside page with less visual
 * identity than the list you picked it from. One component so all three stay in sync. */
export default function FolderIconBadge({ size = 38 }: { size?: number }) {
  return (
    <div
      style={{
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.24),
        background: "var(--color-accent-soft)",
        color: "var(--color-accent)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <FolderIcon size={Math.round(size * 0.47)} />
    </div>
  );
}
