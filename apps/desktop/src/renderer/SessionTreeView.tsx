import type { SessionTreeNode } from "../preload/preload.js";

const TYPE_ICON: Record<string, string> = {
  message: "💬",
  compaction: "📦",
  branch_summary: "⎇",
  model_change: "⚙",
  thinking_level_change: "⚙",
  session_info: "ℹ",
  label: "🏷",
  custom: "•",
  custom_message: "•",
};

interface TreeNodeProps {
  node: SessionTreeNode;
  depth: number;
  onBranch: (entryId: string) => void;
}

function TreeNode({ node, depth, onBranch }: TreeNodeProps) {
  return (
    <div>
      <button
        onClick={() => onBranch(node.id)}
        title={new Date(node.timestamp).toLocaleString()}
        style={{
          display: "block",
          width: "100%",
          textAlign: "left",
          border: "none",
          background: "transparent",
          color: "var(--color-text)",
          cursor: "pointer",
          padding: "4px 8px",
          paddingLeft: 8 + depth * 16,
          fontSize: 12,
          borderRadius: 4,
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.background = "var(--color-bg-hover)")}
        onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
      >
        <span style={{ marginRight: 6 }}>{TYPE_ICON[node.type] ?? "•"}</span>
        {node.label && <strong style={{ marginRight: 6 }}>[{node.label}]</strong>}
        {node.preview}
      </button>
      {node.children.map((child) => (
        <TreeNode key={child.id} node={child} depth={depth + 1} onBranch={onBranch} />
      ))}
    </div>
  );
}

interface SessionTreeViewProps {
  nodes: SessionTreeNode[];
  onBranch: (entryId: string) => void;
  onClose: () => void;
}

/**
 * Plain indented outline of the session's tree — not a graph. Pi's
 * SessionManager already models forks/branches internally; this is just the
 * first surface for it, so a real diagram layout is deferred.
 */
export default function SessionTreeView({ nodes, onBranch, onClose }: SessionTreeViewProps) {
  return (
    <div
      style={{
        position: "absolute",
        top: 44,
        right: 0,
        width: 340,
        maxHeight: 420,
        overflowY: "auto",
        background: "var(--color-bg-secondary)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        boxShadow: "0 8px 24px rgba(0,0,0,0.3)",
        zIndex: 20,
        padding: 8,
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 4,
          padding: "0 4px",
        }}
      >
        <strong style={{ fontSize: 12, color: "var(--color-text-secondary)", letterSpacing: 0.5 }}>
          SESSION TREE
        </strong>
        <button
          onClick={onClose}
          aria-label="Close session tree"
          className="metaharn-tooltip"
          style={{
            border: "none",
            background: "transparent",
            color: "var(--color-text-secondary)",
            cursor: "pointer",
            fontSize: 14,
            lineHeight: 1,
          }}
        >
          ×
        </button>
      </div>
      {nodes.length === 0 ? (
        <p style={{ fontSize: 12, color: "var(--color-text-muted)", padding: "4px 8px" }}>No history yet.</p>
      ) : (
        nodes.map((node) => <TreeNode key={node.id} node={node} depth={0} onBranch={onBranch} />)
      )}
    </div>
  );
}
