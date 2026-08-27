import { useEffect, useState } from "react";
import type { AgentStatus, AppInfo } from "../preload/preload.js";
import { useSettings, type ThemeMode } from "./SettingsContext.js";
import { THEMES, type ThemeDef } from "./themes.js";
import ConfirmDialog from "./ConfirmDialog.js";
import OwnedEngineSettings from "./OwnedEngineSettings.js";
import { Eyebrow, Row, Section, SegmentedControl, SPACE, TEXT } from "./ui.js";

const MODES: { mode: ThemeMode; label: string; icon: string }[] = [
  { mode: "system", label: "System", icon: "🖥" },
  { mode: "dark", label: "Dark", icon: "🌙" },
  { mode: "light", label: "Light", icon: "☀" },
];

function ThemeSwatchButton({ theme, selected, onSelect }: { theme: ThemeDef; selected: boolean; onSelect: () => void }) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        border: "none",
        borderRadius: 8,
        background: selected ? "var(--color-bg-hover)" : "transparent",
        color: "var(--color-text)",
        cursor: "pointer",
        fontSize: 13,
        fontWeight: selected ? 600 : 400,
        textAlign: "left",
      }}
    >
      <span style={{ display: "flex", flexShrink: 0 }}>
        {theme.swatch.map((color, i) => (
          <span
            key={i}
            style={{
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: color,
              marginLeft: i === 0 ? 0 : -4,
              border: "1.5px solid var(--color-bg-elevated)",
            }}
          />
        ))}
      </span>
      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{theme.label}</span>
      {selected && <span style={{ color: "var(--color-accent)" }}>●</span>}
    </button>
  );
}

export default function SettingsPage() {
  const {
    theme,
    setTheme,
    darkThemeId,
    setDarkThemeId,
    lightThemeId,
    setLightThemeId,
    terminalFontSize,
    setTerminalFontSize,
    defaultAgentKind,
    setDefaultAgentKind,
  } = useSettings();
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [agentStatuses, setAgentStatuses] = useState<AgentStatus[] | null>(null);
  const [busyAgent, setBusyAgent] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<AgentStatus | null>(null);

  useEffect(() => {
    void window.metaharn.getAppInfo().then(setAppInfo);
  }, []);

  const refreshAgentStatuses = () => {
    void window.metaharn.getAgentStatuses().then(setAgentStatuses);
  };

  useEffect(refreshAgentStatuses, []);

  // The default-agent segmented control below only renders a button per
  // installed agent — if the one `defaultAgentKind` points at gets
  // uninstalled (from this same section), the filtered button list no
  // longer contains it, so nothing showed as selected and nothing
  // explained why. Falls back to another installed agent automatically,
  // the moment agentStatuses reflects the uninstall; if none are installed
  // at all, the empty-state row below explains that explicitly instead.
  useEffect(() => {
    if (!agentStatuses) return;
    const stillInstalled = agentStatuses.some((a) => a.installed && a.kind === defaultAgentKind);
    if (stillInstalled) return;
    const fallback = agentStatuses.find((a) => a.installed);
    if (fallback) setDefaultAgentKind(fallback.kind);
  }, [agentStatuses, defaultAgentKind, setDefaultAgentKind]);

  const runAgentCommand = (
    agent: AgentStatus,
    command: (kind: AgentStatus["kind"]) => Promise<{ ok: boolean; output: string }>,
  ) => {
    setBusyAgent(agent.kind);
    setAgentError(null);
    command(agent.kind)
      .then((result) => {
        if (!result.ok) setAgentError(`${agent.displayName}: ${result.output || "command failed"}`);
        refreshAgentStatuses();
      })
      .catch((err: Error) => setAgentError(`${agent.displayName}: ${err.message}`))
      .finally(() => setBusyAgent(null));
  };

  const darkThemes = THEMES.filter((t) => t.mode === "dark");
  const lightThemes = THEMES.filter((t) => t.mode === "light");

  return (
    <div style={{ maxWidth: 640, overflowY: "auto", height: "100%" }}>
      <h2 style={{ marginTop: 0 }}>Settings</h2>

      <Section title="Appearance">
        <Row
          label="Theme"
          description="Match your system, or force light/dark."
          control={
            <SegmentedControl
              options={MODES.map(({ mode: m, label, icon }) => ({ value: m, label: `${icon} ${label}` }))}
              value={theme}
              onChange={setTheme}
            />
          }
        />
        <Row
          label="Terminal font size"
          description="Applied the next time you open a terminal."
          control={
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <button
                onClick={() => setTerminalFontSize(Math.max(9, terminalFontSize - 1))}
                aria-label="Decrease font size"
                className="metaharn-tooltip"
                style={{ border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", cursor: "pointer", width: 28, height: 28 }}
              >
                −
              </button>
              <span style={{ fontSize: 13, width: 20, textAlign: "center" }}>{terminalFontSize}</span>
              <button
                onClick={() => setTerminalFontSize(Math.min(24, terminalFontSize + 1))}
                aria-label="Increase font size"
                className="metaharn-tooltip"
                style={{ border: "1px solid var(--color-border)", borderRadius: 6, background: "transparent", cursor: "pointer", width: 28, height: 28 }}
              >
                +
              </button>
            </div>
          }
        />
      </Section>

      <Section title="Color scheme">
        <div style={{ padding: 16 }}>
          <div style={{ marginBottom: SPACE.sm }}>
            <Eyebrow>Dark themes</Eyebrow>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2, marginBottom: SPACE.lg }}>
            {darkThemes.map((t) => (
              <ThemeSwatchButton key={t.id} theme={t} selected={darkThemeId === t.id} onSelect={() => setDarkThemeId(t.id)} />
            ))}
          </div>
          <div style={{ marginBottom: SPACE.sm }}>
            <Eyebrow>Light themes</Eyebrow>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 2 }}>
            {lightThemes.map((t) => (
              <ThemeSwatchButton
                key={t.id}
                theme={t}
                selected={lightThemeId === t.id}
                onSelect={() => setLightThemeId(t.id)}
              />
            ))}
          </div>
        </div>
      </Section>

      <Section title="Model">
        <Row
          label="Provider"
          description="Set via METAHARN_MODEL_PROVIDER in apps/desktop/.env — editing it here isn't wired up yet."
          control={<span style={{ fontSize: 13, fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>{appInfo?.provider ?? "…"}</span>}
        />
        <Row
          label="Model"
          description="Set via METAHARN_MODEL_ID."
          control={<span style={{ fontSize: 13, fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>{appInfo?.modelId ?? "…"}</span>}
        />
      </Section>

      <OwnedEngineSettings />

      <Section title="Agent CLIs">
        <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--color-text-secondary)" }}>
          Which real CLI coding agents are available for terminal sessions (see Overview → "+ New terminal session").
          Installed via npm, except Claude Code's own <code>update</code> command when upgrading it.
        </div>
        <Row
          label="Default for new terminal sessions"
          description={`Used without asking when it's installed. Override any single session with the ▾ next to "New terminal session."`}
          control={
            (agentStatuses ?? []).some((a) => a.installed) ? (
              <SegmentedControl
                options={(agentStatuses ?? [])
                  .filter((a) => a.installed)
                  .map((a) => ({ value: a.kind, label: a.displayName }))}
                value={defaultAgentKind}
                onChange={setDefaultAgentKind}
              />
            ) : (
              <span style={{ fontSize: TEXT.base, color: "var(--color-text-muted)" }}>Nothing installed yet</span>
            )
          }
        />
        {agentStatuses === null && (
          <div style={{ padding: "12px 16px", fontSize: 13, color: "var(--color-text-muted)" }}>Checking...</div>
        )}
        {agentStatuses?.map((agent) => (
          <div
            key={agent.kind}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              padding: "12px 16px",
              borderBottom: "1px solid var(--color-border)",
              gap: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 14 }}>{agent.displayName}</div>
              <div style={{ fontSize: 12, color: "var(--color-text-secondary)", marginTop: 2, fontFamily: '"IBM Plex Mono", Menlo, Monaco, monospace' }}>
                {agent.installed
                  ? `v${agent.version}${agent.updateAvailable ? ` · v${agent.latestVersion} available` : agent.latestVersion ? " · up to date" : ""}`
                  : "Not installed"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
              {!agent.installed && (
                <button
                  onClick={() => runAgentCommand(agent, (k) => window.metaharn.installAgent(k))}
                  disabled={busyAgent === agent.kind}
                  className="metaharn-btn-primary"
                  style={{ fontSize: 13, padding: "5px 12px" }}
                >
                  {busyAgent === agent.kind ? "Installing..." : "Install"}
                </button>
              )}
              {agent.installed && agent.updateAvailable && (
                <button
                  onClick={() => runAgentCommand(agent, (k) => window.metaharn.upgradeAgent(k))}
                  disabled={busyAgent === agent.kind}
                  className="metaharn-btn-primary"
                  style={{ fontSize: 13, padding: "5px 12px" }}
                >
                  {busyAgent === agent.kind ? "Upgrading..." : "Upgrade"}
                </button>
              )}
              {agent.installed && (
                <button
                  onClick={() => setPendingUninstall(agent)}
                  disabled={busyAgent === agent.kind}
                  style={{
                    border: "1px solid var(--color-border)",
                    borderRadius: 6,
                    background: "transparent",
                    color: "var(--color-text-secondary)",
                    cursor: busyAgent === agent.kind ? "default" : "pointer",
                    padding: "5px 12px",
                    fontSize: 13,
                  }}
                >
                  Uninstall
                </button>
              )}
            </div>
          </div>
        ))}
        {agentError && (
          <div style={{ padding: "10px 16px", fontSize: 12, color: "var(--color-error)", whiteSpace: "pre-wrap" }}>
            {agentError}
          </div>
        )}
      </Section>

      <Section title="About">
        <Row label="MetaHarn" description="A meta-harness for an agentic dev platform." control={<span style={{ fontSize: 13, color: "var(--color-text-secondary)" }}>v{appInfo?.version ?? "…"}</span>} />
      </Section>

      {pendingUninstall && (
        <ConfirmDialog
          message={`Uninstall ${pendingUninstall.displayName}? Any terminal sessions using it will stop working until it's reinstalled.`}
          onConfirm={() => {
            const agent = pendingUninstall;
            setPendingUninstall(null);
            runAgentCommand(agent, (k) => window.metaharn.uninstallAgent(k));
          }}
          onCancel={() => setPendingUninstall(null)}
        />
      )}
    </div>
  );
}
