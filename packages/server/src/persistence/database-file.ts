import * as Effect from "effect/Effect";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The server's database in its data directory. Gram 1.0 starts a new one from the baseline under its
 * own name, beside whatever a 0.x build left as `gram.db`: there is no upgrade from 0.x, and those
 * files are never opened, moved, locked or deleted.
 */
export const DATABASE_FILE = "gram-v1.db";

/** What 0.x builds named their database. Only ever checked for; never opened. */
const PRE_1_0_DATABASE_FILE = "gram.db";

/** The database path in `dataDir`, saying once when a 0.x database stays beside it untouched. */
export const serverDatabaseFile = (dataDir: string) =>
  Effect.gen(function* () {
    const database = join(dataDir, DATABASE_FILE);
    const untouched = join(dataDir, PRE_1_0_DATABASE_FILE);
    if (existsSync(untouched)) {
      yield* Effect.logInfo(
        "Gram 1.0 starts with a new database; the 0.x one beside it is left untouched",
      ).pipe(Effect.annotateLogs({ database, untouched }));
    }
    return database;
  });
