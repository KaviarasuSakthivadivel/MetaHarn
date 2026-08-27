import type { SessionTreeNode } from "./client.js";

const TYPE_ICON: Record<string, string> = {
  user: "🧑",
  assistant: "🤖",
  tool: "🔧",
  system: "⚙",
};

interface TreeNodeProps {
  node: SessionTreeNode;
  depth: number;
  currentSessionId: string;
  onBranch: (nodeId: string) => void;
}

function TreeNode({ node, depth, currentSessionId, onBranch }: TreeNodeProps) {
  const nodeSessionId = node.id.slice(0, node.id.lastIndexOf(":"));
  const isCurrent = nodeSessionId === currentSessionId;
  return (
    <div>
      <button
        className={`tree-node-btn${isCurrent ? " current" : ""}`}
        style={{ paddingLeft: 8 + depth * 16 }}
        title={new Date(node.timestamp).toLocaleString()}
        onClick={() => onBranch(node.id)}
      >
        <span className="tree-node-icon">{TYPE_ICON[node.type] ?? "•"}</span>
        {node.label && <strong style={{ marginRight: 6 }}>[{node.label}]</strong>}
        {node.preview}
      </button>
      {node.children.map((child) => (
        <TreeNode key={child.id} node={child} depth={depth + 1} currentSessionId={currentSessionId} onBranch={onBranch} />
      ))}
    </div>
  );
}

interface SessionTreeProps {
  nodes: SessionTreeNode[];
  currentSessionId: string;
  onBranch: (nodeId: string) => void;
  onClose: () => void;
}

/**
 * Plain indented outline of the branch tree a session belongs to — every ancestor and every
 * sibling branch, reconstructed server-side from parentId/branchPointIndex links (see
 * client.ts's getSessionTree). Clicking any node branches from that exact message, matching
 * Electron's SessionTreeView.tsx.
 */
export default function SessionTree({ nodes, currentSessionId, onBranch, onClose }: SessionTreeProps) {
  return (
    <div className="tree-panel">
      <div className="tree-panel-header">
        <span className="tree-panel-title">Session tree</span>
        <button className="tree-panel-close" aria-label="Close session tree" onClick={onClose}>
          ×
        </button>
      </div>
      {nodes.length === 0 ? (
        <p className="tree-panel-empty">No history yet.</p>
      ) : (
        nodes.map((node) => (
          <TreeNode key={node.id} node={node} depth={0} currentSessionId={currentSessionId} onBranch={onBranch} />
        ))
      )}
    </div>
  );
}
