// The Vitest command line a check runs. `--allowOnly=false` because Vitest allows `.only`
// whenever `CI` isn't set: a focused test left in a commit would let the full check pass with the
// rest of its file never run.

/** Arguments after `node node_modules/vitest/vitest.mjs`; `shard` is Vitest's `<index>/<count>`. */
export const vitestArgs = ({ workers, projects = [], shard, reportFile }) => [
  "run",
  "--allowOnly=false",
  `--maxWorkers=${workers}`,
  ...projects.flatMap((project) => ["--project", project]),
  ...(shard === undefined ? [] : [`--shard=${shard}`]),
  "--reporter=dot",
  "--reporter=json",
  `--outputFile.json=${reportFile}`,
];
