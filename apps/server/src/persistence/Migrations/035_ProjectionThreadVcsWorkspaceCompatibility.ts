import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  const columnNames = new Set(columns.map((column) => column.name));

  // Legacy JJ builds used migration ID 33 for vcs_workspace_json. Official
  // Nightly later reused ID 33 for the settled columns, so those databases
  // skipped the official migration. Repair both schema variants here.
  if (!columnNames.has("settled_override")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_override TEXT
    `;
  }

  if (!columnNames.has("settled_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN settled_at TEXT
    `;
  }

  if (!columnNames.has("vcs_workspace_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN vcs_workspace_json TEXT
    `;
  }
});
