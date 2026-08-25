import type { ReactNode } from "react";

/**
 * Shared spacing/type/radius scale and small UI primitives — extracted
 * because inline style={{}} objects (this app's only styling mechanism, no
 * CSS-in-JS library or Tailwind) had drifted in real, verified ways: two
 * independently-defined components both named `Row` for unrelated shapes
 * (SettingsPage.tsx vs ContextWindowPanel.tsx), the same "small uppercase
 * label" role at two different font sizes in the same file, and no shared
 * number behind any padding/border-radius value anywhere. Not a full
 * retrofit of every screen — applied where the drift was concretely found
 * (SettingsPage.tsx, ContextWindowPanel.tsx) plus new screens built after
 * this existed (Sidebar.tsx), so the drift stops accumulating going
 * forward without rewriting everything that predates it.
 */

export const SPACE = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 } as const;
export const TEXT = { xs: 11, sm: 12, base: 13, md: 14, lg: 15, xl: 18, xxl: 26 } as const;
export const RADIUS = { sm: 6, md: 8, lg: 10, xl: 12 } as const;

/** Small uppercase label — section titles, subsection headers ("SORT",
 * "DARK THEMES", "BREAKDOWN"). Previously hand-written at two different
 * sizes (13 and 11) for the same visual role in the same file. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: TEXT.xs,
        fontWeight: 700,
        letterSpacing: 0.5,
        color: "var(--color-text-muted)",
      }}
    >
      {typeof children === "string" ? children.toUpperCase() : children}
    </div>
  );
}

/** Titled card wrapper — a settings-style grouped section. */
export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: SPACE.xl + SPACE.xs }}>
      <div style={{ marginBottom: SPACE.sm + 2 }}>
        <Eyebrow>{title}</Eyebrow>
      </div>
      <div
        style={{
          border: "1px solid var(--color-border)",
          borderRadius: RADIUS.lg,
          background: "var(--color-bg-elevated)",
          overflow: "hidden",
        }}
      >
        {children}
      </div>
    </div>
  );
}

/** Label + description + an interactive control, right-aligned — one row
 * inside a Section (theme picker, font size stepper, agent install row). */
export function Row({ label, description, control }: { label: string; description?: string; control: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: `${SPACE.md}px ${SPACE.lg}px`,
        borderBottom: "1px solid var(--color-border)",
        gap: SPACE.lg,
      }}
    >
      <div>
        <div style={{ fontSize: TEXT.md }}>{label}</div>
        {description && (
          <div style={{ fontSize: TEXT.sm, color: "var(--color-text-secondary)", marginTop: 2 }}>{description}</div>
        )}
      </div>
      {control}
    </div>
  );
}

/** Label + static value on one line (optionally monospace) — a read-only
 * fact, not an interactive control. Distinct job from `Row` above: this
 * used to be a second, differently-shaped component that was ALSO named
 * `Row`, defined independently in ContextWindowPanel.tsx. */
export function ValueRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: TEXT.base - 0.5 }}>
      <span style={{ color: "var(--color-text-secondary)" }}>{label}</span>
      <span style={{ fontFamily: mono ? '"IBM Plex Mono", Menlo, Monaco, monospace' : undefined }}>{value}</span>
    </div>
  );
}

/** The flex-row-of-toggle-buttons pattern — theme mode, sort order,
 * default agent — each previously hand-rolled independently with the same
 * active/inactive styling retyped at each call site. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div style={{ display: "flex", border: "1px solid var(--color-border)", borderRadius: RADIUS.sm, overflow: "hidden" }}>
      {options.map((opt) => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          style={{
            padding: "5px 12px",
            border: "none",
            background: value === opt.value ? "var(--color-accent)" : "transparent",
            color: value === opt.value ? "#fff" : "var(--color-text)",
            cursor: "pointer",
            fontSize: TEXT.base,
          }}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

/** Small icon + text pair — session counts, timestamps, branch names.
 * Relocated here from ProjectsListPage.tsx (its original, slightly
 * arbitrary home) now that ProjectOverview.tsx also needs it — one
 * canonical import path instead of a cross-component-file import. */
export function MetaChip({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      <span style={{ display: "inline-flex", color: "var(--color-text-muted)" }}>{icon}</span>
      {children}
    </span>
  );
}
