import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

describe("fork jj upgrade", () => {
  it.effect(
    "preserves jj metadata and installs upstream settlement after migration 33 collides",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* sql`ALTER TABLE projection_threads ADD COLUMN vcs_workspace_json TEXT`;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project-jj', 'jj', '/tmp/jj', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
        const metadata =
          '{"driverKind":"jj","name":"thread-jj","rootPath":"/tmp/jj-workspace","workspaceRevision":{"commitId":"abc","changeId":"abc"},"publishRef":null}';
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, vcs_workspace_json) VALUES ('thread-jj', 'project-jj', 'jj', '{"instanceId":"codex","model":"gpt-5.4"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ${metadata})`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (33, 'ProjectionThreadVcsWorkspace')`;
        yield* runMigrations();
        const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
        assert.isTrue(columns.some((column) => column.name === "settled_at"));
        const rows = yield* sql<{
          vcs_workspace_json: string;
        }>`SELECT vcs_workspace_json FROM projection_threads WHERE thread_id = 'thread-jj'`;
        assert.equal(rows[0]?.vcs_workspace_json, metadata);
        yield* runMigrations();
        const ledger = yield* sql<{
          name: string;
        }>`SELECT name FROM effect_sql_migrations WHERE migration_id = 33`;
        assert.equal(ledger[0]?.name, "ProjectionThreadsSettled");
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
  it.effect(
    "preserves fork workspaces and installs snapshot indexes when migration 60 collides",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 59 });
        yield* sql`ALTER TABLE projection_threads ADD COLUMN vcs_workspace_json TEXT`;
        yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at) VALUES ('project-jj-60', 'jj', '/tmp/jj', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
        const metadata = JSON.stringify({
          driverKind: "jj",
          name: "thread-jj-60",
          rootPath: "/tmp/jj-workspace",
          workspaceRevision: { commitId: "abc", changeId: "abc" },
          publishRef: null,
        });
        yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, vcs_workspace_json) VALUES ('thread-jj-60', 'project-jj-60', 'jj', '{"instanceId":"codex","model":"gpt-5.4"}', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', ${metadata})`;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (60, 'ForkThreadVcsWorkspace')`;

        yield* runMigrations();
        assert.deepStrictEqual(yield* runMigrations(), []);
        const rows = yield* sql<{
          vcs_workspace_json: string;
        }>`SELECT vcs_workspace_json FROM projection_threads WHERE thread_id = 'thread-jj-60'`;
        assert.equal(rows[0]?.vcs_workspace_json, metadata);
        const ledger = yield* sql<{
          migration_id: number;
          name: string;
        }>`SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (60, 70) ORDER BY migration_id`;
        assert.deepStrictEqual(ledger, [
          { migration_id: 60, name: "ThreadSnapshotWindowIndexes" },
          { migration_id: 70, name: "ForkThreadVcsWorkspace" },
        ]);
        const indexes = yield* sql<{
          name: string;
        }>`SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('orchestration_v2_projection_turn_items_user_message_idx', 'orchestration_v2_projection_nodes_live_idx') ORDER BY name`;
        assert.deepStrictEqual(
          indexes.map(({ name }) => name),
          [
            "orchestration_v2_projection_nodes_live_idx",
            "orchestration_v2_projection_turn_items_user_message_idx",
          ],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
