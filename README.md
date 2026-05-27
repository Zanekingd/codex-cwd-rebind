# Codex CWD Rebind

Inspect and safely rebind local OpenAI Codex session `cwd` metadata from VS Code.

中文文档: [README.zh-CN.md](README.zh-CN.md)

This is an unofficial local metadata editor. It is Linux-first and tested against the local Codex data layout under `~/.codex`.

## Install

Download the latest `.vsix` from GitHub Releases, then install it in VS Code:

1. Open Extensions.
2. Choose `Install from VSIX...`.
3. Select `codex-cwd-rebind-*.vsix`.

## What It Does

- Lists local Codex sessions from `state_5.sqlite` and rollout JSONL files.
- Separates active and archived sessions into two tabs.
- Switches each tab between recent ordering and full-cwd project grouping.
- Provides per-session row actions for CWD inspection, CWD rebind, and thread rename.
- Rebinds one session to a new working directory after preview and confirmation.
- Backs up touched files before each CWD rebind.
- Renames threads in the same local metadata sources used by CodexUI.

## What It Does Not Do

- It does not chat with Codex.
- It does not start or bridge `codex app-server`.
- It does not migrate providers, delete sessions, archive sessions, or integrate with CodexUI.
- It is not an official OpenAI tool.

## Development

```bash
npm install
npm test
npm run package
```

Launch the extension with VS Code's Extension Development Host, then open the `Codex CWD` activity bar view.

## Safety Model

Before each write, the extension copies `state_5.sqlite`, existing WAL/SHM files, and the selected rollout JSONL into a timestamped backup folder. Writes update exactly:

- `state_5.sqlite` `threads.cwd`
- rollout `session_meta.payload.cwd`
- rollout `turn_context.payload.cwd`

The extension never applies changes automatically. Every rebind requires preview and user confirmation.

Thread rename does not create a backup. It updates `threads.title`, appends to `session_index.jsonl`, appends a `thread_name_updated` event to the rollout JSONL, and updates `.codex-global-state.json`.
