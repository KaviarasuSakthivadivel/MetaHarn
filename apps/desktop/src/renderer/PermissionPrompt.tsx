import type { ApprovalOutcome } from "../preload/preload.js";

export interface PendingPermission {
  toolCallId: string;
  toolName: string;
  args: unknown;
  reason: string;
}

interface PermissionPromptProps {
  request: PendingPermission;
  onResolve: (outcome: ApprovalOutcome) => void;
}

/** Same modal shell/backdrop convention as ConfirmDialog.tsx, purpose-built rather than
 * reused directly: a dismissed permission prompt must DENY (resolve the engine's pending
 * approval), not just close silently the way ConfirmDialog's onCancel does everywhere else
 * it's used — keeping this separate avoids changing that contract for every existing caller. */
export default function PermissionPrompt({ request, onResolve }: PermissionPromptProps) {
  let argsPreview = "";
  try {
    argsPreview = JSON.stringify(request.args, null, 2);
  } catch {
    argsPreview = String(request.args);
  }

  return (
    <div
      onClick={() => onResolve("deny")}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0, 0, 0, 0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--color-bg-elevated)",
          border: "1px solid var(--color-border)",
          borderRadius: 10,
          padding: 20,
          maxWidth: 520,
          width: "90%",
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
        }}
      >
        <p style={{ margin: "0 0 6px", color: "var(--color-text)", fontSize: 14, fontWeight: 600 }}>
          Allow <code>{request.toolName}</code>?
        </p>
        <p style={{ margin: "0 0 12px", color: "var(--color-text-muted)", fontSize: 13, lineHeight: 1.5 }}>
          {request.reason}
        </p>
        <pre
          style={{
            margin: "0 0 16px",
            padding: 10,
            background: "var(--color-bg)",
            border: "1px solid var(--color-border)",
            borderRadius: 6,
            fontSize: 12,
            fontFamily: "monospace",
            maxHeight: 200,
            overflow: "auto",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "var(--color-text)",
          }}
        >
          {argsPreview}
        </pre>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={() => onResolve("deny")}
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--color-text)",
              cursor: "pointer",
              padding: "6px 14px",
            }}
          >
            Deny
          </button>
          <button
            onClick={() => onResolve("once")}
            style={{
              border: "none",
              borderRadius: 6,
              background: "var(--color-accent)",
              color: "#fff",
              cursor: "pointer",
              padding: "6px 14px",
            }}
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
