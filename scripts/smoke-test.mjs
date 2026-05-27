import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import Module from "node:module";

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === "vscode") {
    return {};
  }
  return originalLoad.call(this, request, parent, isMain);
};

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "codex-cwd-rebind-"));

try {
  const codexHome = path.join(tempRoot, "codex-home");
  const globalStorage = path.join(tempRoot, "global-storage");
  const targetCwd = path.join(tempRoot, "target-workspace");
  const rolloutRel = "sessions/2026/05/27/rollout-test.jsonl";
  const rolloutPath = path.join(codexHome, rolloutRel);
  const archivedRolloutRel = "sessions/2026/05/28/rollout-archived.jsonl";
  const archivedRolloutPath = path.join(codexHome, archivedRolloutRel);

  await fs.mkdir(path.dirname(rolloutPath), { recursive: true });
  await fs.mkdir(path.dirname(archivedRolloutPath), { recursive: true });
  await fs.mkdir(targetCwd, { recursive: true });

  await fs.writeFile(
    rolloutPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-main", cwd: "/old/workspace" }
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { cwd: "/old/workspace", turn_id: "turn-1" }
      }),
      JSON.stringify({
        type: "turn_context",
        payload: { cwd: "/other/workspace", turn_id: "turn-2" }
      }),
      JSON.stringify({ type: "response_item", payload: { type: "message" } })
    ].join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(
    archivedRolloutPath,
    [
      JSON.stringify({
        type: "session_meta",
        payload: { id: "thread-archived", cwd: "/archived/workspace" }
      })
    ].join("\n") + "\n",
    "utf8"
  );

  await fs.writeFile(
    path.join(codexHome, "session_index.jsonl"),
    [
      JSON.stringify({
        id: "thread-main",
        thread_name: "Stale Indexed Thread",
        updated_at: "2026-05-27T00:00:00Z"
      }),
      JSON.stringify({
        id: "thread-main",
        thread_name: "Official Indexed Thread",
        updated_at: "2026-05-27T00:01:00Z"
      })
    ].join("\n") + "\n",
    "utf8"
  );
  await fs.writeFile(
    path.join(codexHome, ".codex-global-state.json"),
    JSON.stringify({
      "thread-titles": {
        titles: {
          "thread-second": "Cached Second Thread",
          "old-thread": "Old Thread"
        },
        order: ["thread-second", "old-thread"]
      },
      untouched: true
    }),
    "utf8"
  );

  const dbPath = path.join(codexHome, "state_5.sqlite");
  execFileSync("sqlite3", [
    dbPath,
    `
create table threads(
  id text primary key,
  title text,
  first_user_message text,
  preview text,
  source text,
  model_provider text,
  cwd text,
  rollout_path text,
  updated_at integer,
  updated_at_ms integer,
  archived integer,
  agent_role text,
  agent_path text
);
create table thread_spawn_edges(parent_thread_id text, child_thread_id text, status text);
insert into threads values('thread-main','**Main**
Thread','ignored first','ignored preview','vscode','aixj','/old/workspace','${rolloutRel}',1,1000,0,null,null);
insert into threads values('thread-second','','Second
Thread','ignored preview','vscode','aixj','/old/workspace','${rolloutRel}',1,950,0,null,null);
insert into threads values('thread-child','Child Thread','ignored first','ignored preview','vscode','aixj','/old/workspace','${rolloutRel}',1,900,0,null,null);
insert into threads values('thread-openai','OpenAI Thread','ignored first','ignored preview','vscode','openai','/old/workspace','${rolloutRel}',1,800,0,null,null);
insert into threads values('thread-remote','Remote Thread','ignored first','ignored preview','remote','aixj','/old/workspace','${rolloutRel}',1,700,0,null,null);
insert into threads values('thread-archived','Archived Thread','ignored first','ignored preview','vscode','aixj','/archived/workspace','${archivedRolloutRel}',1,1100,1,null,null);
insert into thread_spawn_edges values('thread-main','thread-child','completed');
    `.trim()
  ]);

  process.env.CODEX_HOME = codexHome;
  const {
    CodexCwdService,
    groupSessionsByCwd,
    matchesOfficialActiveSession,
    renderMain
  } = await import(pathToFileURL(path.join(root, "out", "extension.js")).href);
  const service = new CodexCwdService({
    globalStorageUri: { fsPath: globalStorage }
  });

  const sessions = await service.scanSessions();
  assert(sessions.length === 5, `expected five non-subagent sessions, got ${sessions.length}`);
  const main = findSession(sessions, "thread-main");
  const second = findSession(sessions, "thread-second");
  const archived = findSession(sessions, "thread-archived");
  assert(sessions[0].id === "thread-archived", "expected newest archived thread to sort first");
  assert(main.title === "Official Indexed Thread", "expected session index thread_name to win");
  assert(second.title === "Cached Second Thread", "expected global-state thread title before first message");
  assert(main.metaCwd === "/old/workspace", "expected session_meta cwd");
  assert(archived.archived === true, "expected archived flag to be preserved");
  assert(
    sessions.filter((session) => !session.archived && matchesOfficialActiveSession(session)).length === 2,
    "expected only official-active sessions to match the official UI filter"
  );

  const groups = groupSessionsByCwd(sessions, new Set(["/archived/workspace"]));
  assert(groups[0].cwd === "/archived/workspace", "expected newest cwd group first");
  assert(groups[0].collapsed === true, "expected collapsed project state");
  assert(
    groups.find((group) => group.cwd === "/old/workspace")?.sessions.map((session) => session.id).join(",") ===
      "thread-main,thread-second,thread-openai,thread-remote",
    "expected sessions within cwd group to sort by recent update"
  );

  const archivedHtml = renderMain([archived], "archived", "recent", new Set());
  assert(archivedHtml.includes("Archived Thread"), "expected archived title to render");
  assert(!archivedHtml.includes("[Archived]"), "expected archived title without prefix");
  const groupedHtml = renderMain(sessions, "active", "project", new Set());
  assert(groupedHtml.includes("/old/workspace"), "expected project layout to show full cwd");

  await assertRejects(
    () => service.buildRenamePlan(main, "   "),
    "Thread title cannot be empty.",
    "expected empty rename title rejection"
  );
  const renamePlan = await service.buildRenamePlan(main, "Renamed Thread");
  const renameMutation = await service.applyRename(renamePlan);
  assert(renameMutation.kind === "rename", "expected rename mutation");
  assert(renameMutation.status === "completed", "expected completed rename");
  assert(!("backupDir" in renameMutation), "expected rename not to create backup");

  const sqliteTitle = execFileSync("sqlite3", [
    dbPath,
    "select title from threads where id='thread-main';"
  ]).toString().trim();
  assert(sqliteTitle === "Renamed Thread", "expected SQLite title to be renamed");

  const indexRows = (await fs.readFile(path.join(codexHome, "session_index.jsonl"), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(
    indexRows.at(-1).id === "thread-main" &&
      indexRows.at(-1).thread_name === "Renamed Thread",
    "expected session_index thread_name append"
  );

  const renamedRolloutLines = (await fs.readFile(rolloutPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(
    renamedRolloutLines.at(-1).type === "event_msg" &&
      renamedRolloutLines.at(-1).payload.type === "thread_name_updated" &&
      renamedRolloutLines.at(-1).payload.thread_name === "Renamed Thread",
    "expected rollout thread_name_updated event append"
  );

  const globalState = JSON.parse(
    await fs.readFile(path.join(codexHome, ".codex-global-state.json"), "utf8")
  );
  assert(
    globalState["thread-titles"].titles["thread-main"] === "Renamed Thread",
    "expected global-state thread title update"
  );
  assert(
    globalState["thread-titles"].order[0] === "thread-main",
    "expected global-state title order update"
  );
  assert(globalState.untouched === true, "expected global-state unrelated data to survive");

  const plan = await service.buildRebindPlan(main, targetCwd);
  assert(plan.wouldUpdateSessionMeta === true, "expected session_meta update");
  assert(plan.wouldUpdateTurnContexts === 2, "expected both turn_context rows to update");

  const mutation = await service.applyRebind(plan);
  assert(mutation.status === "completed", "expected completed mutation");
  assert(mutation.updatedSessionMeta === 1, "expected one session_meta rewrite");
  assert(mutation.updatedTurnContexts === 2, "expected two turn_context rewrites");

  const sqliteCwd = execFileSync("sqlite3", [
    dbPath,
    "select cwd from threads where id='thread-main';"
  ]).toString().trim();
  assert(sqliteCwd === targetCwd, "expected SQLite cwd to be rebound");

  const lines = (await fs.readFile(rolloutPath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert(lines[0].payload.cwd === targetCwd, "expected session_meta cwd to be rebound");
  assert(
    lines.filter((line) => line.type === "turn_context").every((line) => line.payload.cwd === targetCwd),
    "expected all turn_context cwd values to be rebound"
  );

  await fs.access(path.join(mutation.backupDir, "manifest.json"));
  await fs.access(path.join(mutation.backupDir, "state_5.sqlite"));
  await fs.access(path.join(mutation.backupDir, path.basename(rolloutPath)));

  console.log("smoke fixture passed");
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}

function findSession(sessions, id) {
  const session = sessions.find((candidate) => candidate.id === id);
  if (!session) {
    throw new Error(`expected session ${id}`);
  }
  return session;
}

async function assertRejects(callback, expectedMessage, message) {
  try {
    await callback();
  } catch (error) {
    assert(error.message === expectedMessage, `${message}: ${error.message}`);
    return;
  }
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
