import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const projectionThreadColumnNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  return columns.map((column) => column.name);
});

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "035_ProjectionThreadVcsWorkspaceCompatibility fresh database",
  (it) => {
    it.effect("installs official and JJ columns on a fresh database", () =>
      Effect.gen(function* () {
        yield* runMigrations({ toMigrationInclusive: 35 });

        const columnNames = yield* projectionThreadColumnNames;
        assert.includeMembers(columnNames, [
          "settled_override",
          "settled_at",
          "snoozed_until",
          "snoozed_at",
          "vcs_workspace_json",
        ]);
      }),
    );
  },
);

it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()))(
  "035_ProjectionThreadVcsWorkspaceCompatibility legacy database",
  (it) => {
    it.effect("repairs a legacy JJ database that occupied migration ID 33", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 32 });
        yield* sql`
        ALTER TABLE projection_threads
        ADD COLUMN vcs_workspace_json TEXT
      `;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (33, 'ProjectionThreadVcsWorkspace')
      `;

        yield* runMigrations({ toMigrationInclusive: 35 });
        yield* runMigrations({ toMigrationInclusive: 35 });

        const columnNames = yield* projectionThreadColumnNames;
        assert.includeMembers(columnNames, [
          "settled_override",
          "settled_at",
          "snoozed_until",
          "snoozed_at",
          "vcs_workspace_json",
        ]);

        const migrations = yield* sql<{ readonly migrationId: number; readonly name: string }>`
        SELECT migration_id AS "migrationId", name
        FROM effect_sql_migrations
        WHERE migration_id >= 33
        ORDER BY migration_id
      `;
        assert.deepStrictEqual(migrations, [
          { migrationId: 33, name: "ProjectionThreadVcsWorkspace" },
          { migrationId: 34, name: "ProjectionThreadsSnoozed" },
          { migrationId: 35, name: "ProjectionThreadVcsWorkspaceCompatibility" },
        ]);
      }),
    );
  },
);
