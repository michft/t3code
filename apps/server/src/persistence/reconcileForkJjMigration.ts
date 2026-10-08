import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import Settled from "./Migrations/033_ProjectionThreadsSettled.ts";

/** The fork shipped jj metadata at id 33 before upstream assigned settlement to it. */
export const reconcileForkJjMigration = Effect.fn("reconcileForkJjMigration")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const tables =
        yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'`;
      if (tables.length === 0) return;
      const rows =
        yield* sql`SELECT name FROM effect_sql_migrations WHERE migration_id = 33 AND name = 'ProjectionThreadVcsWorkspace'`;
      if (rows.length === 0) return;
      // Retain vcs_workspace_json and install the upstream schema even when later ids exist.
      yield* Settled;
      yield* sql`UPDATE effect_sql_migrations SET name = 'ProjectionThreadsSettled' WHERE migration_id = 33 AND name = 'ProjectionThreadVcsWorkspace'`;
    }),
  );
});
