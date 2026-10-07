import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "./Migrations.ts";

it.layer(NodeSqliteClient.layer({ filename: ":memory:" }))("fork jj upgrade", (it) => {
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
      }),
  );
});
