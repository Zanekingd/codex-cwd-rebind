# Codex CWD Rebind

一个极简 VS Code 扩展，用来浏览本机 OpenAI Codex 会话，并安全修改某个会话绑定的 `cwd` 元信息。

这是非官方工具，第一版以 Linux 为主，已按 `~/.codex` 下的本地 Codex 数据结构测试。

## 解决的问题

Codex 会话的项目归属依赖本地元信息。如果旧会话的全局 `cwd` 记录错了，恢复长会话、压缩上下文或从管理界面打开时，可能会把文件操作落到错误项目里。

这个扩展只做一件事：让你在 VS Code 侧边栏里找到对应会话，然后把它的 `cwd` 安全重绑到正确目录。

## 功能

- 从 `state_5.sqlite` 和 rollout JSONL 读取本机 Codex 会话。
- Active / Archived 分开显示。
- 支持按最近使用排序，或按完整 `cwd` 项目路径分组。
- 每个会话行提供 `Inspect CWD`、`Rebind CWD...`、`Rename thread`。
- 重绑前展示预览，确认后才写入。
- 每次重绑都会备份将被修改的 SQLite 和 rollout 文件。
- 重命名会话时同步 CodexUI 使用的本地标题元信息。

## 安装

从 GitHub Releases 下载最新的 `.vsix` 文件，然后在 VS Code 中安装：

1. 打开 Extensions 侧边栏。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选择下载的 `codex-cwd-rebind-*.vsix`。

安装后，Activity Bar 里会出现 `Codex CWD` 图标。

## 安全模型

重绑 `cwd` 时只修改三类数据：

- `state_5.sqlite` 的 `threads.cwd`
- rollout 首行 `session_meta.payload.cwd`
- rollout 中所有 `turn_context.payload.cwd`

写入前会备份：

- `state_5.sqlite`
- 如果存在，备份 `state_5.sqlite-wal`
- 如果存在，备份 `state_5.sqlite-shm`
- 当前会话对应的 rollout JSONL

重命名会话不会创建备份。它会更新：

- `state_5.sqlite` 的 `threads.title`
- 追加 `session_index.jsonl` 的 `thread_name`
- 追加 rollout JSONL 的 `thread_name_updated` 事件
- 更新 `.codex-global-state.json` 的 `thread-titles`

## 不做什么

- 不和 Codex 聊天。
- 不启动或桥接 `codex app-server`。
- 不迁移 provider。
- 不删除、归档或恢复会话。
- 不依赖 CodexUI。
- 不是 OpenAI 官方工具。

## 开发

```bash
npm install
npm test
npm run package
```

本项目首版故意保持简单：不引入 native SQLite npm 依赖，读取 SQLite 依赖系统 `sqlite3` 命令。
