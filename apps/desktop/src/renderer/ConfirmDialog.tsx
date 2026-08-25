import type { ReactNode } from "react";

interface ConfirmDialogProps {
  message: string;
  /** Extra content between the message and the button row — e.g. a real
   * uncommitted-changes list before a destructive worktree removal, so the
   * decision is informed rather than a bare yes/no. */
  details?: ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({ message, details, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div
      onClick={onCancel}
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
          maxWidth: details ? 480 : 380,
          boxShadow: "0 8px 24px rgba(0, 0, 0, 0.25)",
        }}
      >
        <p style={{ margin: details ? "0 0 12px" : "0 0 16px", color: "var(--color-text)", fontSize: 14, lineHeight: 1.5 }}>
          {message}
        </p>
        {details && <div style={{ marginBottom: 16 }}>{details}</div>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              background: "transparent",
              color: "var(--color-text)",
              cursor: "pointer",
              padding: "6px 14px",
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              border: "none",
              borderRadius: 6,
              background: "var(--color-error)",
              color: "#fff",
              cursor: "pointer",
              padding: "6px 14px",
            }}
          >
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
