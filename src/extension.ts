import * as crypto from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { once } from "node:events";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);
const STATE_DB_NAME = "state_5.sqlite";
const SESSION_INDEX_NAME = "session_index.jsonl";
const CODEX_GLOBAL_STATE_NAME = ".codex-global-state.json";
const MUTATION_LOG_NAME = "mutations.jsonl";
const LIST_LAYOUT_KEY = "codexCwdRebind.listLayout";
const COLLAPSED_PROJECTS_KEY = "codexCwdRebind.collapsedProjects";
const MAX_THREAD_TITLES = 500;

interface SessionSummary {
  id: string;
  title: string;
  source: string;
  modelProvider: string;
  sqliteCwd: string;
  metaCwd: string | null;
  rolloutPath: string;
  updatedAt: string | null;
  archived: boolean;
  isSubagent: boolean;
}

interface CwdInspection {
  sqliteCwd: string;
  sessionMetaCwd: string | null;
  turnContextTotal: number;
  turnContextMatching: number;
  turnContextDifferent: number;
}

interface RebindPlan {
  sessionId: string;
  fromCwd: string;
  toCwd: string;
  rolloutPath: string;
  wouldUpdateSessionMeta: boolean;
  wouldUpdateTurnContexts: number;
}

interface RenamePlan {
  sessionId: string;
  fromTitle: string;
  toTitle: string;
  rolloutPath: string;
}

interface MutationRecord {
  id: string;
  createdAt: string;
  kind: "rebind" | "rename";
  sessionId: string;
  fromCwd?: string;
  toCwd?: string;
  fromTitle?: string;
  toTitle?: string;
  backupDir?: string;
  status: "completed" | "failed";
  updatedSessionMeta?: number;
  updatedTurnContexts?: number;
  notes?: string;
}

interface SessionGroup {
  cwd: string;
  sessions: SessionSummary[];
  collapsed: boolean;
}

interface ThreadRow {
  id: string;
  title: string | null;
  firstUserMessage: string | null;
  preview: string | null;
  source: string;
  modelProvider: string;
  sqliteCwd: string;
  rolloutPath: string;
  updatedAtMs: number | null;
  archived: number;
  isSubagent: number;
}

type ViewMessage =
  | { type: "refresh" }
  | { type: "search"; query: string }
  | { type: "rebind"; sessionId: string }
  | { type: "rename"; sessionId: string; title: string }
  | { type: "inspect"; sessionId: string }
  | { type: "mode"; mode: ViewMode }
  | { type: "layout"; layout: ListLayout }
  | { type: "toggleProject"; cwd: string };

type ViewMode = "active" | "archived";
type ListLayout = "recent" | "project";

export function activate(context: vscode.ExtensionContext): void {
  const service = new CodexCwdService(context);
  const provider = new SessionsViewProvider(context.extensionUri, service, context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "codexCwdRebind.sessionsView",
      provider
    ),
    vscode.commands.registerCommand("codexCwdRebind.refreshSessions", () =>
      provider.refresh()
    )
  );
}

export function deactivate(): void {
  // No background resources.
}

class SessionsViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;
  private sessions: SessionSummary[] = [];
  private searchQuery = "";
  private mode: ViewMode = "active";
  private layout: ListLayout;
  private collapsedProjects: Set<string>;
  private isLoading = false;
  private lastError: string | null = null;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: CodexCwdService,
    private readonly context: vscode.ExtensionContext
  ) {
    this.layout = normalizeListLayout(
      this.context.globalState.get<string>(LIST_LAYOUT_KEY)
    );
    this.collapsedProjects = new Set(
      this.context.globalState.get<string[]>(COLLAPSED_PROJECTS_KEY, [])
    );
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true
    };
    view.webview.onDidReceiveMessage((message: ViewMessage) => {
      void this.handleMessage(message);
    });
    this.render();
    void this.refresh();
  }

  public async refresh(): Promise<void> {
    this.isLoading = true;
    this.lastError = null;
    this.render();
    try {
      this.sessions = await this.service.scanSessions();
    } catch (error) {
      this.sessions = [];
      this.lastError = getErrorMessage(error);
    } finally {
      this.isLoading = false;
      this.render();
    }
  }

  private async handleMessage(message: ViewMessage): Promise<void> {
    switch (message.type) {
      case "refresh":
        await this.refresh();
        return;
      case "search":
        this.searchQuery = message.query.trim();
        this.render();
        return;
      case "rebind":
        await this.rebindSession(message.sessionId);
        return;
      case "rename":
        await this.renameSession(message.sessionId, message.title);
        return;
      case "inspect":
        await this.inspectSession(message.sessionId);
        return;
      case "mode":
        this.mode = message.mode;
        this.render();
        return;
      case "layout":
        this.layout = normalizeListLayout(message.layout);
        await this.context.globalState.update(LIST_LAYOUT_KEY, this.layout);
        this.render();
        return;
      case "toggleProject":
        await this.toggleProject(message.cwd);
        return;
    }
  }

  private async rebindSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      void vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
      return;
    }

    const selected = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: "Use as Codex cwd",
      title: `Choose new cwd for ${session.title || session.id}`,
      defaultUri: getDefaultFolderUri(session.sqliteCwd)
    });
    const target = selected?.[0]?.fsPath;
    if (!target) {
      return;
    }

    try {
      const plan = await this.service.buildRebindPlan(session, target);
      const detail = [
        `Session: ${session.title || session.id}`,
        `From: ${plan.fromCwd}`,
        `To: ${plan.toCwd}`,
        `Update session_meta: ${plan.wouldUpdateSessionMeta ? "yes" : "no"}`,
        `Update turn_context rows: ${plan.wouldUpdateTurnContexts}`,
        "",
        "Backups will be created before writing."
      ].join("\n");
      const choice = await vscode.window.showWarningMessage(
        "Apply Codex cwd rebind?",
        { modal: true, detail },
        "Apply Rebind"
      );
      if (choice !== "Apply Rebind") {
        return;
      }

      const mutation = await this.service.applyRebind(plan);
      await this.refresh();
      void vscode.window.showInformationMessage(
        `Rebound cwd for ${session.title || session.id}. Backup: ${mutation.backupDir}`
      );
    } catch (error) {
      void vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private async renameSession(sessionId: string, title: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      void vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
      return;
    }

    try {
      const plan = await this.service.buildRenamePlan(session, title);
      const mutation = await this.service.applyRename(plan);
      await this.refresh();
      void vscode.window.showInformationMessage(
        `Renamed ${mutation.fromTitle || session.title} to ${mutation.toTitle}.`
      );
    } catch (error) {
      void vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private async inspectSession(sessionId: string): Promise<void> {
    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      void vscode.window.showErrorMessage(`Session not found: ${sessionId}`);
      return;
    }

    try {
      const inspection = await this.service.inspectCwd(session);
      const detail = [
        `Session: ${session.title || session.id}`,
        `SQLite cwd: ${inspection.sqliteCwd}`,
        `session_meta cwd: ${inspection.sessionMetaCwd ?? "missing"}`,
        `turn_context cwd: ${inspection.turnContextMatching}/${inspection.turnContextTotal} match SQLite cwd, ${inspection.turnContextDifferent} different`,
        `Rollout: ${session.rolloutPath}`
      ].join("\n");
      void vscode.window.showInformationMessage(
        "Codex CWD inspection",
        { modal: true, detail },
        "OK"
      );
    } catch (error) {
      void vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private async toggleProject(cwd: string): Promise<void> {
    if (this.collapsedProjects.has(cwd)) {
      this.collapsedProjects.delete(cwd);
    } else {
      this.collapsedProjects.add(cwd);
    }
    await this.context.globalState.update(
      COLLAPSED_PROJECTS_KEY,
      Array.from(this.collapsedProjects)
    );
    this.render();
  }

  private getVisibleSessions(): SessionSummary[] {
    const modeMatches = this.sessions.filter((session) =>
      this.mode === "archived"
        ? session.archived
        : !session.archived && matchesOfficialActiveSession(session)
    );
    const query = this.searchQuery.toLowerCase();
    if (!query) {
      return modeMatches;
    }
    return modeMatches.filter((session) =>
      [
        session.id,
        session.title,
        session.sqliteCwd,
        session.metaCwd,
        session.rolloutPath
      ]
        .filter((value): value is string => Boolean(value))
        .some((value) => value.toLowerCase().includes(query))
    );
  }

  private render(): void {
    if (!this.view) {
      return;
    }
    this.view.webview.html = this.getHtml();
  }

  private getHtml(): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const visibleSessions = this.getVisibleSessions();

    const body = this.isLoading
      ? renderState("Loading sessions...", "Scanning local Codex metadata.")
      : this.lastError
        ? renderState("Failed to load sessions", this.lastError)
        : visibleSessions.length === 0
          ? renderState("No sessions found", "Try refreshing or clearing search.")
          : renderMain(
              visibleSessions,
              this.mode,
              this.layout,
              this.collapsedProjects
            );

    return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codex CWD Rebind</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: var(--vscode-sideBar-background);
        --fg: var(--vscode-foreground);
        --muted: var(--vscode-descriptionForeground);
        --panel: color-mix(in srgb, var(--vscode-sideBar-background) 82%, var(--vscode-foreground) 8%);
        --panel-hover: color-mix(in srgb, var(--vscode-sideBar-background) 72%, var(--vscode-foreground) 12%);
        --border: var(--vscode-sideBar-border, #3c3c3c);
        --accent: var(--vscode-button-background);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        padding: 12px;
        background: var(--bg);
        color: var(--fg);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }
      .toolbar {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
      }
      .tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-bottom: 10px;
      }
      .tab {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      .tab.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      .view-switcher {
        align-items: center;
        color: var(--muted);
        display: flex;
        gap: 8px;
        margin: 0 0 10px;
      }
      .view-label {
        font-size: 12px;
        white-space: nowrap;
      }
      .layout-tabs {
        border: 1px solid var(--border);
        border-radius: 6px;
        display: inline-flex;
        overflow: hidden;
      }
      .layout-tab {
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--muted);
        padding: 4px 9px;
      }
      .layout-tab.active {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      input {
        width: 100%;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
        padding: 7px 9px;
      }
      button {
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
        padding: 7px 9px;
      }
      button.secondary {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      .session-row {
        position: relative;
        margin: 0 0 6px;
      }
      .session {
        width: 100%;
        border: 1px solid transparent;
        border-radius: 8px;
        background: transparent;
        color: inherit;
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 8px;
        text-align: left;
      }
      .session:hover {
        background: var(--panel-hover);
        border-color: var(--border);
      }
      .session-main {
        min-width: 0;
        flex: 1;
      }
      .menu-trigger {
        flex: 0 0 auto;
        min-width: 28px;
        padding: 2px 7px;
        background: transparent;
        color: var(--muted);
      }
      .menu-trigger:hover {
        background: var(--vscode-toolbar-hoverBackground);
        color: var(--fg);
      }
      .session-menu {
        position: absolute;
        right: 4px;
        top: 34px;
        z-index: 5;
        min-width: 148px;
        border: 1px solid var(--border);
        border-radius: 8px;
        background: var(--vscode-menu-background, var(--panel));
        box-shadow: 0 8px 18px rgba(0, 0, 0, .22);
        padding: 4px;
      }
      .session-menu[hidden] {
        display: none;
      }
      .menu-item {
        width: 100%;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: var(--vscode-menu-foreground, var(--fg));
        display: block;
        padding: 7px 9px;
        text-align: left;
      }
      .menu-item:hover {
        background: var(--vscode-menu-selectionBackground, var(--panel-hover));
        color: var(--vscode-menu-selectionForeground, var(--fg));
      }
      .project-group {
        margin: 0 0 8px;
      }
      .project-header {
        width: 100%;
        border: 0;
        background: transparent;
        color: var(--muted);
        display: flex;
        gap: 6px;
        padding: 6px 2px;
        text-align: left;
      }
      .project-header:hover {
        color: var(--fg);
        background: transparent;
      }
      .project-title {
        min-width: 0;
        overflow-wrap: anywhere;
      }
      .title {
        font-weight: 650;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .meta, .detail {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .state {
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--panel);
        margin-top: 12px;
        padding: 10px;
      }
      .rename-overlay {
        position: fixed;
        inset: 0;
        z-index: 20;
        display: none;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, .25);
        padding: 16px;
      }
      .rename-overlay.open {
        display: flex;
      }
      .rename-panel {
        width: min(360px, 100%);
        border: 1px solid var(--border);
        border-radius: 12px;
        background: var(--vscode-editorWidget-background, var(--panel));
        color: var(--fg);
        padding: 14px;
        box-shadow: 0 12px 32px rgba(0, 0, 0, .28);
      }
      .rename-title {
        font-size: 14px;
        font-weight: 700;
        margin: 0 0 4px;
      }
      .rename-subtitle {
        color: var(--muted);
        font-size: 12px;
        margin: 0 0 10px;
      }
      .rename-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 10px;
      }
    </style>
  </head>
  <body>
    <div class="tabs">
      <button class="tab ${this.mode === "active" ? "active" : ""}" data-mode="active">Active</button>
      <button class="tab ${this.mode === "archived" ? "active" : ""}" data-mode="archived">Archived</button>
    </div>
    <div class="view-switcher">
      <span class="view-label">View</span>
      <div class="layout-tabs" role="group" aria-label="Session layout">
        <button class="layout-tab ${this.layout === "recent" ? "active" : ""}" data-layout="recent">Recent</button>
        <button class="layout-tab ${this.layout === "project" ? "active" : ""}" data-layout="project">By cwd</button>
      </div>
    </div>
    <div class="toolbar">
      <input id="search" value="${escapeHtml(this.searchQuery)}" placeholder="Search title, cwd, id, rollout" />
      <button class="secondary" id="refresh">Refresh</button>
    </div>
    ${body}
    <div id="renameOverlay" class="rename-overlay" aria-hidden="true">
      <div class="rename-panel" role="dialog" aria-modal="true" aria-label="Thread title">
        <h3 class="rename-title">Rename thread</h3>
        <p class="rename-subtitle">Make it short and recognizable.</p>
        <input id="renameInput" type="text" placeholder="Add title..." />
        <div class="rename-actions">
          <button class="secondary" id="renameCancel" type="button">Cancel</button>
          <button id="renameSave" type="button">Save</button>
        </div>
      </div>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      const search = document.getElementById("search");
      const renameOverlay = document.getElementById("renameOverlay");
      const renameInput = document.getElementById("renameInput");
      let renameSessionId = "";
      let searchTimer;
      search?.addEventListener("input", (event) => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => {
          vscode.postMessage({ type: "search", query: event.target.value });
        }, 120);
      });
      document.getElementById("refresh")?.addEventListener("click", () => {
        vscode.postMessage({ type: "refresh" });
      });
      document.querySelectorAll("[data-menu]").forEach((element) => {
        element.addEventListener("click", () => {
          const panel = document.querySelector('[data-menu-panel="' + element.dataset.menu + '"]');
          document.querySelectorAll("[data-menu-panel]").forEach((candidate) => {
            if (candidate !== panel) candidate.hidden = true;
          });
          if (panel) panel.hidden = !panel.hidden;
        });
      });
      document.querySelectorAll("[data-action]").forEach((element) => {
        element.addEventListener("click", () => {
          const sessionId = element.dataset.sessionId;
          document.querySelectorAll("[data-menu-panel]").forEach((panel) => { panel.hidden = true; });
          if (element.dataset.action === "rename") {
            openRenameDialog(sessionId, element.dataset.sessionTitle || "");
            return;
          }
          vscode.postMessage({ type: element.dataset.action, sessionId });
        });
      });
      document.querySelectorAll("[data-mode]").forEach((element) => {
        element.addEventListener("click", () => {
          vscode.postMessage({ type: "mode", mode: element.dataset.mode });
        });
      });
      document.querySelectorAll("[data-layout]").forEach((element) => {
        element.addEventListener("click", () => {
          vscode.postMessage({ type: "layout", layout: element.dataset.layout });
        });
      });
      document.querySelectorAll("[data-toggle-project]").forEach((element) => {
        element.addEventListener("click", () => {
          vscode.postMessage({ type: "toggleProject", cwd: element.dataset.toggleProject });
        });
      });
      document.addEventListener("click", (event) => {
        if (event.target.closest("[data-menu]") || event.target.closest("[data-menu-panel]")) {
          return;
        }
        document.querySelectorAll("[data-menu-panel]").forEach((panel) => { panel.hidden = true; });
      });
      document.getElementById("renameCancel")?.addEventListener("click", closeRenameDialog);
      document.getElementById("renameSave")?.addEventListener("click", submitRenameDialog);
      renameOverlay?.addEventListener("click", (event) => {
        if (event.target === renameOverlay) closeRenameDialog();
      });
      renameInput?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          submitRenameDialog();
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeRenameDialog();
        }
      });
      function openRenameDialog(sessionId, title) {
        renameSessionId = sessionId || "";
        renameInput.value = title || "";
        renameOverlay.classList.add("open");
        renameOverlay.setAttribute("aria-hidden", "false");
        setTimeout(() => {
          renameInput.focus();
          renameInput.select();
        }, 0);
      }
      function closeRenameDialog() {
        renameSessionId = "";
        renameInput.value = "";
        renameOverlay.classList.remove("open");
        renameOverlay.setAttribute("aria-hidden", "true");
      }
      function submitRenameDialog() {
        const title = renameInput.value.trim();
        if (!renameSessionId || !title) return;
        vscode.postMessage({ type: "rename", sessionId: renameSessionId, title });
        closeRenameDialog();
      }
    </script>
  </body>
</html>`;
  }
}

export class CodexCwdService {
  private readonly codexHome = getCodexHome();
  private readonly stateDbPath = path.join(this.codexHome, STATE_DB_NAME);

  public constructor(private readonly context: vscode.ExtensionContext) {}

  public async scanSessions(): Promise<SessionSummary[]> {
    const indexedThreadNames = await readSessionIndexThreadNames(this.codexHome);
    const cachedThreadNames = await readGlobalStateThreadTitles(this.codexHome);
    const rows = await runSqliteJson<ThreadRow[]>(
      this.stateDbPath,
      `
select
  t.id as id,
  t.title as title,
  t.first_user_message as firstUserMessage,
  t.preview as preview,
  t.source as source,
  t.model_provider as modelProvider,
  t.cwd as sqliteCwd,
  t.rollout_path as rolloutPath,
  coalesce(t.updated_at_ms, t.updated_at * 1000) as updatedAtMs,
  t.archived as archived,
  case
    when t.agent_role is not null and trim(t.agent_role) != '' then 1
    when t.agent_path is not null and trim(t.agent_path) != '' then 1
    when exists (select 1 from thread_spawn_edges e where e.child_thread_id = t.id) then 1
    else 0
  end as isSubagent
from threads t
order by coalesce(t.updated_at_ms, t.updated_at * 1000) desc
      `.trim(),
      true
    );

    const sessions: SessionSummary[] = [];
    for (const row of rows) {
      if (!row.id || !row.rolloutPath || row.isSubagent) {
        continue;
      }
      const rolloutPath = resolveCodexPath(this.codexHome, row.rolloutPath);
      const metaCwd = await readSessionMetaCwd(rolloutPath).catch(() => null);
      sessions.push({
        id: row.id,
        title: getOfficialDisplayTitle(
          indexedThreadNames.get(row.id),
          cachedThreadNames.get(row.id),
          row.title,
          row.firstUserMessage,
          row.preview,
          row.id
        ),
        source: row.source,
        modelProvider: row.modelProvider,
        sqliteCwd: row.sqliteCwd,
        metaCwd,
        rolloutPath,
        updatedAt: row.updatedAtMs ? new Date(Number(row.updatedAtMs)).toISOString() : null,
        archived: Boolean(row.archived),
        isSubagent: Boolean(row.isSubagent)
      });
    }
    return sessions;
  }

  public async inspectCwd(session: SessionSummary): Promise<CwdInspection> {
    const rollout = await inspectRolloutCwd(
      session.rolloutPath,
      session.id,
      session.sqliteCwd
    );
    return {
      sqliteCwd: session.sqliteCwd,
      sessionMetaCwd: rollout.sessionMetaCwd,
      turnContextTotal: rollout.turnContextTotal,
      turnContextMatching: rollout.turnContextMatching,
      turnContextDifferent: rollout.turnContextDifferent
    };
  }

  public async buildRebindPlan(
    session: SessionSummary,
    targetCwd: string
  ): Promise<RebindPlan> {
    const targetStat = await fs.stat(targetCwd);
    if (!targetStat.isDirectory()) {
      throw new Error(`Target cwd is not a directory: ${targetCwd}`);
    }

    const inspection = await inspectRolloutCwd(
      session.rolloutPath,
      session.id,
      targetCwd
    );
    return {
      sessionId: session.id,
      fromCwd: session.sqliteCwd,
      toCwd: targetCwd,
      rolloutPath: session.rolloutPath,
      wouldUpdateSessionMeta: inspection.sessionMetaCwd !== targetCwd,
      wouldUpdateTurnContexts: inspection.turnContextDifferent
    };
  }

  public async buildRenamePlan(
    session: SessionSummary,
    title: string
  ): Promise<RenamePlan> {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      throw new Error("Thread title cannot be empty.");
    }
    return {
      sessionId: session.id,
      fromTitle: session.title,
      toTitle: normalizedTitle,
      rolloutPath: session.rolloutPath
    };
  }

  public async applyRebind(plan: RebindPlan): Promise<MutationRecord> {
    const backupDir = await this.createBackup(plan);
    try {
      await updateThreadCwd(this.stateDbPath, plan.sessionId, plan.toCwd);
      const rewrite = await rewriteRolloutCwd(
        plan.rolloutPath,
        plan.sessionId,
        plan.toCwd
      );

      const verified = await this.verifyRebind(plan);
      if (!verified) {
        throw new Error("Rebind verification failed after write.");
      }

      const mutation: MutationRecord = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        kind: "rebind",
        sessionId: plan.sessionId,
        fromCwd: plan.fromCwd,
        toCwd: plan.toCwd,
        backupDir,
        status: "completed",
        updatedSessionMeta: rewrite.updatedSessionMeta,
        updatedTurnContexts: rewrite.updatedTurnContexts
      };
      await this.appendMutation(mutation);
      return mutation;
    } catch (error) {
      const mutation: MutationRecord = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        kind: "rebind",
        sessionId: plan.sessionId,
        fromCwd: plan.fromCwd,
        toCwd: plan.toCwd,
        backupDir,
        status: "failed",
        updatedSessionMeta: 0,
        updatedTurnContexts: 0,
        notes: getErrorMessage(error)
      };
      await this.appendMutation(mutation);
      throw error;
    }
  }

  public async applyRename(plan: RenamePlan): Promise<MutationRecord> {
    try {
      await updateThreadTitle(this.stateDbPath, plan.sessionId, plan.toTitle);
      await appendSessionIndexThreadName(
        path.join(this.codexHome, SESSION_INDEX_NAME),
        plan.sessionId,
        plan.toTitle
      );
      await appendRolloutThreadName(
        plan.rolloutPath,
        plan.sessionId,
        plan.toTitle
      );
      await updateGlobalStateThreadTitle(
        path.join(this.codexHome, CODEX_GLOBAL_STATE_NAME),
        plan.sessionId,
        plan.toTitle
      );

      const mutation: MutationRecord = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        kind: "rename",
        sessionId: plan.sessionId,
        fromTitle: plan.fromTitle,
        toTitle: plan.toTitle,
        status: "completed"
      };
      await this.appendMutation(mutation);
      return mutation;
    } catch (error) {
      const mutation: MutationRecord = {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        kind: "rename",
        sessionId: plan.sessionId,
        fromTitle: plan.fromTitle,
        toTitle: plan.toTitle,
        status: "failed",
        notes: getErrorMessage(error)
      };
      await this.appendMutation(mutation);
      throw error;
    }
  }

  private async verifyRebind(plan: RebindPlan): Promise<boolean> {
    const rows = await runSqliteJson<Array<{ cwd: string }>>(
      this.stateDbPath,
      `select cwd from threads where id = ${quoteSqlString(plan.sessionId)} limit 1`,
      true
    );
    if (rows[0]?.cwd !== plan.toCwd) {
      return false;
    }

    const rollout = await inspectRolloutCwd(
      plan.rolloutPath,
      plan.sessionId,
      plan.toCwd
    );
    return rollout.sessionMetaCwd === plan.toCwd && rollout.turnContextDifferent === 0;
  }

  private async createBackup(plan: RebindPlan): Promise<string> {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = path.join(
      this.context.globalStorageUri.fsPath,
      "backups",
      `${stamp}-${plan.sessionId.slice(0, 8)}`
    );
    await fs.mkdir(backupDir, { recursive: true });

    const files = [
      this.stateDbPath,
      `${this.stateDbPath}-wal`,
      `${this.stateDbPath}-shm`,
      plan.rolloutPath
    ];
    const copied: Array<{ source: string; backup: string }> = [];
    for (const file of files) {
      const target = path.join(backupDir, path.basename(file));
      if (await copyIfExists(file, target)) {
        copied.push({ source: file, backup: target });
      }
    }

    const manifest = {
      createdAt: new Date().toISOString(),
      sessionId: plan.sessionId,
      fromCwd: plan.fromCwd,
      toCwd: plan.toCwd,
      files: copied
    };
    await fs.writeFile(
      path.join(backupDir, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8"
    );
    return backupDir;
  }

  private async appendMutation(record: MutationRecord): Promise<void> {
    const logPath = this.getMutationLogPath();
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  }

  private getMutationLogPath(): string {
    return path.join(this.context.globalStorageUri.fsPath, MUTATION_LOG_NAME);
  }
}

async function runSqliteJson<T>(
  dbPath: string,
  sql: string,
  readonly: boolean
): Promise<T> {
  const args = readonly
    ? ["-readonly", "-json", dbPath, sql]
    : ["-json", dbPath, sql];
  const { stdout, stderr } = await execFileAsync("sqlite3", args, {
    maxBuffer: 50 * 1024 * 1024
  });
  if (stderr.trim()) {
    throw new Error(stderr.trim());
  }
  const output = stdout.trim();
  return (output ? JSON.parse(output) : []) as T;
}

async function updateThreadCwd(
  stateDbPath: string,
  sessionId: string,
  nextCwd: string
): Promise<void> {
  const nowMs = Date.now();
  const sql = `
update threads
set cwd = ${quoteSqlString(nextCwd)},
    updated_at = ${Math.floor(nowMs / 1000)},
    updated_at_ms = ${nowMs}
where id = ${quoteSqlString(sessionId)};
select changes() as changedRows;
  `.trim();
  const rows = await runSqliteJson<Array<{ changedRows: number }>>(
    stateDbPath,
    sql,
    false
  );
  if (Number(rows[0]?.changedRows) !== 1) {
    throw new Error(`Expected exactly one SQLite thread row update for ${sessionId}.`);
  }
}

async function updateThreadTitle(
  stateDbPath: string,
  sessionId: string,
  nextTitle: string
): Promise<void> {
  const sql = `
update threads
set title = ${quoteSqlString(nextTitle)}
where id = ${quoteSqlString(sessionId)};
select changes() as changedRows;
  `.trim();
  const rows = await runSqliteJson<Array<{ changedRows: number }>>(
    stateDbPath,
    sql,
    false
  );
  if (Number(rows[0]?.changedRows) !== 1) {
    throw new Error(`Expected exactly one SQLite thread title update for ${sessionId}.`);
  }
}

async function readSessionMetaCwd(rolloutPath: string): Promise<string | null> {
  const firstLine = await readFirstLine(rolloutPath);
  if (!firstLine) {
    return null;
  }
  const row = JSON.parse(firstLine) as {
    type?: string;
    payload?: { cwd?: string };
  };
  return row.type === "session_meta" ? row.payload?.cwd ?? null : null;
}

async function readSessionIndexThreadNames(codexHome: string): Promise<Map<string, string>> {
  const indexPath = path.join(codexHome, SESSION_INDEX_NAME);
  const names = new Map<string, string>();
  const reader = createInterface({
    input: createReadStream(indexPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        continue;
      }
      try {
        const row = JSON.parse(line) as {
          id?: unknown;
          thread_name?: unknown;
        };
        if (typeof row.id !== "string" || typeof row.thread_name !== "string") {
          continue;
        }
        const name = row.thread_name.trim();
        if (name) {
          names.set(row.id, name);
        }
      } catch {
        // Ignore malformed index rows; SQLite/rollout metadata remains the fallback.
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  return names;
}

async function readGlobalStateThreadTitles(codexHome: string): Promise<Map<string, string>> {
  const statePath = path.join(codexHome, CODEX_GLOBAL_STATE_NAME);
  const titles = new Map<string, string>();
  try {
    const payload = JSON.parse(await fs.readFile(statePath, "utf8")) as unknown;
    const record = asRecord(payload);
    const cache = asRecord(record?.["thread-titles"]);
    const rawTitles = asRecord(cache?.titles);
    if (!rawTitles) {
      return titles;
    }
    for (const [id, title] of Object.entries(rawTitles)) {
      if (typeof title === "string" && title.trim()) {
        titles.set(id, title.trim());
      }
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      return titles;
    }
  }
  return titles;
}

async function appendSessionIndexThreadName(
  indexPath: string,
  sessionId: string,
  title: string
): Promise<void> {
  await fs.mkdir(path.dirname(indexPath), { recursive: true });
  await fs.appendFile(
    indexPath,
    `${JSON.stringify({
      id: sessionId,
      thread_name: title,
      updated_at: new Date().toISOString()
    })}\n`,
    "utf8"
  );
}

async function appendRolloutThreadName(
  rolloutPath: string,
  sessionId: string,
  title: string
): Promise<void> {
  await fs.appendFile(
    rolloutPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      type: "event_msg",
      payload: {
        type: "thread_name_updated",
        thread_id: sessionId,
        thread_name: title
      }
    })}\n`,
    "utf8"
  );
}

async function updateGlobalStateThreadTitle(
  statePath: string,
  sessionId: string,
  title: string
): Promise<void> {
  let payload: Record<string, unknown> = {};
  try {
    payload = asRecord(JSON.parse(await fs.readFile(statePath, "utf8"))) ?? {};
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const currentCache = asRecord(payload["thread-titles"]) ?? {};
  const currentTitles = asRecord(currentCache.titles) ?? {};
  const nextTitles: Record<string, string> = {};
  for (const [id, value] of Object.entries(currentTitles)) {
    if (typeof value === "string" && value.length > 0) {
      nextTitles[id] = value;
    }
  }
  nextTitles[sessionId] = title;

  const currentOrder = Array.isArray(currentCache.order)
    ? currentCache.order.filter((value): value is string => typeof value === "string")
    : [];
  const nextOrder = [
    sessionId,
    ...currentOrder.filter((id) => id !== sessionId),
    ...Object.keys(nextTitles).filter(
      (id) => id !== sessionId && !currentOrder.includes(id)
    )
  ].slice(0, MAX_THREAD_TITLES);
  for (const id of Object.keys(nextTitles)) {
    if (!nextOrder.includes(id)) {
      delete nextTitles[id];
    }
  }

  payload["thread-titles"] = {
    titles: nextTitles,
    order: nextOrder
  };
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(payload), "utf8");
}

async function inspectRolloutCwd(
  rolloutPath: string,
  sessionId: string,
  targetCwd: string
): Promise<{
  sessionMetaCwd: string | null;
  turnContextTotal: number;
  turnContextMatching: number;
  turnContextDifferent: number;
}> {
  const reader = createInterface({
    input: createReadStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  let sessionMetaCwd: string | null = null;
  let turnContextTotal = 0;
  let turnContextMatching = 0;
  let turnContextDifferent = 0;

  for await (const line of reader) {
    if (!line.trim()) {
      continue;
    }
    let row: {
      type?: string;
      payload?: { id?: string; cwd?: string };
    };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const payload = row.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }
    if (row.type === "session_meta" && payload.id === sessionId) {
      sessionMetaCwd = payload.cwd ?? null;
      continue;
    }
    if (row.type === "turn_context" && Object.hasOwn(payload, "cwd")) {
      turnContextTotal += 1;
      if (payload.cwd === targetCwd) {
        turnContextMatching += 1;
      } else {
        turnContextDifferent += 1;
      }
    }
  }

  return {
    sessionMetaCwd,
    turnContextTotal,
    turnContextMatching,
    turnContextDifferent
  };
}

async function rewriteRolloutCwd(
  rolloutPath: string,
  sessionId: string,
  nextCwd: string
): Promise<{ updatedSessionMeta: number; updatedTurnContexts: number }> {
  const info = await fs.stat(rolloutPath);
  const tempPath = path.join(
    path.dirname(rolloutPath),
    `.${path.basename(rolloutPath)}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  const reader = createInterface({
    input: createReadStream(rolloutPath, { encoding: "utf8" }),
    crlfDelay: Infinity
  });
  const writer = createWriteStream(tempPath, {
    encoding: "utf8",
    mode: info.mode
  });
  let updatedSessionMeta = 0;
  let updatedTurnContexts = 0;

  try {
    for await (const line of reader) {
      if (!line.trim()) {
        await writeLine(writer, "");
        continue;
      }

      let nextLine = line;
      try {
        const row = JSON.parse(line) as {
          type?: string;
          payload?: { id?: string; cwd?: string };
        };
        const payload = row.payload;
        if (payload && typeof payload === "object") {
          if (row.type === "session_meta" && payload.id === sessionId) {
            if (payload.cwd !== nextCwd) {
              payload.cwd = nextCwd;
              updatedSessionMeta += 1;
              nextLine = JSON.stringify(row);
            }
          } else if (
            row.type === "turn_context" &&
            Object.hasOwn(payload, "cwd") &&
            payload.cwd !== nextCwd
          ) {
            payload.cwd = nextCwd;
            updatedTurnContexts += 1;
            nextLine = JSON.stringify(row);
          }
        }
      } catch {
        // Preserve malformed lines exactly instead of risking data loss.
      }

      await writeLine(writer, nextLine);
    }

    writer.end();
    await once(writer, "finish");
    await fs.rename(tempPath, rolloutPath);
  } catch (error) {
    reader.close();
    writer.destroy();
    await fs.rm(tempPath, { force: true });
    throw error;
  }

  return { updatedSessionMeta, updatedTurnContexts };
}

async function writeLine(
  writer: NodeJS.WritableStream,
  line: string
): Promise<void> {
  if (!writer.write(`${line}\n`)) {
    await once(writer, "drain");
  }
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await fs.open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let position = 0;
    while (true) {
      const buffer = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(buffer.subarray(0, bytesRead));
      const text = Buffer.concat(chunks).toString("utf8");
      const newline = text.indexOf("\n");
      if (newline >= 0) {
        return text.slice(0, newline).replace(/\r$/, "");
      }
      position += bytesRead;
    }
    return chunks.length ? Buffer.concat(chunks).toString("utf8") : null;
  } finally {
    await handle.close();
  }
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  try {
    await fs.copyFile(source, target);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function renderMain(
  sessions: SessionSummary[],
  mode: ViewMode,
  layout: ListLayout,
  collapsedProjects: Set<string>
): string {
  const list =
    layout === "project"
      ? renderProjectGroups(groupSessionsByCwd(sessions, collapsedProjects))
      : sessions.map((session) => renderSession(session)).join("");
  return `
    <div class="meta">${sessions.length} ${mode === "archived" ? "archived" : "active"} sessions shown.</div>
    <div>${list}</div>
  `;
}

function renderProjectGroups(groups: SessionGroup[]): string {
  return groups
    .map((group) => {
      const sessions = group.collapsed
        ? ""
        : group.sessions.map((session) => renderSession(session)).join("");
      return `
        <section class="project-group">
          <button class="project-header" data-toggle-project="${escapeHtml(group.cwd)}" title="${escapeHtml(group.cwd)}">
            <span>${group.collapsed ? ">" : "v"}</span>
            <span class="project-title">${escapeHtml(group.cwd)}</span>
            <span>(${group.sessions.length})</span>
          </button>
          ${sessions}
        </section>
      `;
    })
    .join("");
}

function renderSession(session: SessionSummary): string {
  const cwdLabel = session.sqliteCwd;
  return `
    <div class="session-row">
      <div class="session">
        <div class="session-main">
          <div class="title">${escapeHtml(session.title)}</div>
          <div class="meta">${escapeHtml(formatDate(session.updatedAt))} · ${escapeHtml(cwdLabel)}</div>
        </div>
        <button class="menu-trigger" data-menu="${escapeHtml(session.id)}" aria-label="Session actions">...</button>
      </div>
      <div class="session-menu" data-menu-panel="${escapeHtml(session.id)}" hidden>
        <button class="menu-item" data-action="inspect" data-session-id="${escapeHtml(session.id)}">Inspect CWD</button>
        <button class="menu-item" data-action="rebind" data-session-id="${escapeHtml(session.id)}">Rebind CWD...</button>
        <button class="menu-item" data-action="rename" data-session-id="${escapeHtml(session.id)}" data-session-title="${escapeHtml(session.title)}">Rename thread</button>
      </div>
    </div>
  `;
}

function renderState(title: string, detail: string): string {
  return `<div class="state"><div class="title">${escapeHtml(title)}</div><div class="detail">${escapeHtml(detail)}</div></div>`;
}

function getCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? configured : path.join(os.homedir(), ".codex");
}

function resolveCodexPath(codexHome: string, value: string): string {
  return path.isAbsolute(value) ? value : path.join(codexHome, value);
}

function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getDefaultFolderUri(sessionCwd: string): vscode.Uri | undefined {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (workspace) {
    return workspace;
  }
  return sessionCwd ? vscode.Uri.file(sessionCwd) : undefined;
}

function normalizeListLayout(value: string | undefined): ListLayout {
  return value === "project" ? "project" : "recent";
}

export function groupSessionsByCwd(
  sessions: SessionSummary[],
  collapsedProjects = new Set<string>()
): SessionGroup[] {
  const groups = new Map<string, SessionSummary[]>();
  for (const session of sessions) {
    const cwd = session.sqliteCwd || "Projectless";
    const group = groups.get(cwd);
    if (group) {
      group.push(session);
    } else {
      groups.set(cwd, [session]);
    }
  }

  return Array.from(groups.entries())
    .map(([cwd, groupSessions]) => ({
      cwd,
      sessions: groupSessions
        .slice()
        .sort((first, second) => sessionTimeMs(second) - sessionTimeMs(first)),
      collapsed: collapsedProjects.has(cwd)
    }))
    .sort(
      (first, second) =>
        sessionTimeMs(second.sessions[0]) - sessionTimeMs(first.sessions[0])
    );
}

function sessionTimeMs(session: SessionSummary | undefined): number {
  if (!session?.updatedAt) {
    return 0;
  }
  const time = new Date(session.updatedAt).getTime();
  return Number.isNaN(time) ? 0 : time;
}

export function matchesOfficialActiveSession(session: SessionSummary): boolean {
  return session.source === "vscode" && session.modelProvider === "aixj";
}

export function getOfficialDisplayTitle(
  indexedThreadName: string | null | undefined,
  cachedThreadName: string | null | undefined,
  title: string | null | undefined,
  firstUserMessage: string | null | undefined,
  preview: string | null | undefined,
  fallbackId: string
): string {
  return (
    cleanOfficialTitle(indexedThreadName) ||
    cleanOfficialTitle(cachedThreadName) ||
    cleanOfficialTitle(title) ||
    cleanOfficialTitle(firstUserMessage) ||
    cleanOfficialTitle(preview) ||
    fallbackId
  );
}

function cleanOfficialTitle(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return "";
  }
  return stripMarkdownForTitle(trimmed).replace(/\s+/g, " ").trim();
}

function stripMarkdownForTitle(value: string): string {
  return value
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^[\s-]*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "");
}

function formatDate(value: string | null): string {
  if (!value) {
    return "unknown time";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString();
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
