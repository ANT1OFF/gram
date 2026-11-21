import type { ThreadId } from "@gram/contracts";
import * as Effect from "effect/Effect";
import type { SqlClient } from "../platform/unstable.ts";

/**
 * What a thread leaves behind in orchestration when it goes: the slot it held (column and
 * JSON), its workers' link to it, the reports it filed unless `keepReports` (a close, whose
 * reopen makes them its own again), and the link from a dream that ran as it. The dream's row
 * stays, since its output is still there to review or discard. Runs inside the caller's
 * transaction.
 */
export const unlinkOrchestrationIn = (
  sql: SqlClient.SqlClient,
  id: ThreadId,
  keepReports = false,
) =>
  Effect.gen(function* () {
    yield* sql`UPDATE workspaces SET orchestrator_thread_id = NULL,
        data = CASE WHEN json_valid(data)
          THEN json_remove(data, '$.workspace.orchestratorThreadId') ELSE data END
      WHERE orchestrator_thread_id = ${id}`;
    yield* sql`UPDATE threads SET data = json_remove(data, '$.spawnedBy')
      WHERE CASE WHEN json_valid(data)
        THEN json_extract(data, '$.spawnedBy.threadId') = ${id} ELSE 0 END`;
    if (!keepReports) yield* sql`DELETE FROM worker_reports WHERE thread_id = ${id}`;
    yield* sql`UPDATE dreams SET thread_id = NULL,
        data = CASE WHEN json_valid(data) THEN json_remove(data, '$.threadId') ELSE data END
      WHERE thread_id = ${id}`;
  });
