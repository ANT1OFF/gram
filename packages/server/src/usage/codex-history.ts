import {
  addCodexCounts,
  codexCounts,
  makeCodexUsageLedger,
  validCodexCounts,
} from "@gram/agents/codex";
import type { TokenUsage } from "@gram/contracts";
import { makeCodexHistoryCoverage } from "./codex-history-coverage.ts";
import {
  object,
  identity,
  modelOf,
  timeOf,
  type HistoryRecord,
  type HistoryReducer,
} from "./history-types.ts";

// Only bounded session/ancestry scalars participate in source ownership proof.
const sessionMetadata = (payload: Record<string, unknown>) => {
  const spawn = object(object(object(payload.source).subagent).thread_spawn);
  const values = [
    payload.id,
    payload.session_id,
    payload.forked_from_id,
    payload.parent_thread_id,
    spawn.parent_thread_id,
  ];
  if (
    values.some(
      (value, index) =>
        value !== undefined && (index < 2 || value !== null) && identity(value) === undefined,
    )
  )
    return undefined;
  const [id, alias, fork, directParent, spawnParent] = values.map(identity);
  if (
    (id !== undefined && alias !== undefined && id !== alias) ||
    (directParent !== undefined && spawnParent !== undefined && directParent !== spawnParent)
  )
    return undefined;
  const owner = id ?? alias;
  if (owner === undefined) return undefined;
  return { owner, fork: fork ?? null, nestedParent: directParent ?? spawnParent ?? null };
};

export function makeCodexHistory(initialFrom = -Infinity, initialTo = Infinity): HistoryReducer {
  const records = new Map<string, HistoryRecord>(),
    nativeTurnIds = new Set<string>();
  const responses = new Map<string, Set<string>>(),
    rejected = new Set<string>();
  // Original response evidence survives window projection/context quarantine.
  // Null retains a refused unknown origin: replay cannot invent its execution time.
  const responseProofs = new Map<string, HistoryRecord | null>(),
    responseRequirements = new Map<string, TokenUsage>(),
    requirementConflicts = new Set<string>();
  let responseProofBytes = 0,
    responseRequirementBytes = 0,
    requirementConflictBytes = 0;
  const updateResponse = (id: string, change: (record: HistoryRecord) => void) => {
    const record = responseProofs.get(id);
    if (record == null) return;
    const before = Buffer.byteLength(JSON.stringify(record));
    change(record);
    responseProofBytes += Buffer.byteLength(JSON.stringify(record)) - before;
  };
  const expectedKeys = [
    "inputTokens",
    "outputTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "reasoningTokens",
  ] as const;
  const observeRequirement = (
    id: string,
    raw: unknown,
    expected: TokenUsage | undefined,
    counts: TokenUsage,
  ) => {
    const conflict = () => {
      ledger.invalidateBaseline();
      if (!requirementConflicts.has(id)) {
        requirementConflicts.add(id);
        requirementConflictBytes += Buffer.byteLength(id);
        reducer.invalid++;
      }
    };
    if (expected === undefined) {
      ledger.invalidateBaseline();
      if (raw !== undefined) conflict();
      return false;
    }
    // Requirement contradictions are scoped response evidence even when the
    // original execution date was refused and no amount projection can exist.
    const prior = responseRequirements.get(id);
    if (
      expectedKeys.some(
        (key) =>
          expected[key] !== undefined && counts[key] !== undefined && expected[key]! < counts[key]!,
      )
    )
      conflict();
    if (
      prior !== undefined &&
      expectedKeys.some(
        (key) =>
          prior[key] !== undefined && expected[key] !== undefined && expected[key]! < prior[key]!,
      )
    )
      conflict();
    const required = Object.fromEntries(
      expectedKeys.flatMap((key) =>
        prior?.[key] === undefined && expected[key] === undefined
          ? []
          : [[key, Math.max(prior?.[key] ?? 0, expected[key] ?? 0)]],
      ),
    ) as unknown as TokenUsage;
    if (!validCodexCounts(required)) conflict();
    else {
      responseRequirements.set(id, required);
      responseRequirementBytes +=
        (prior === undefined ? Buffer.byteLength(id) : 0) +
        Buffer.byteLength(JSON.stringify(required)) -
        (prior === undefined ? 0 : Buffer.byteLength(JSON.stringify(prior)));
    }
    return !requirementConflicts.has(id);
  };
  // Codex rollouts report usage as cumulative `token_count` events, and newer ones also write a
  // `token_usage_record` per response. These are the contributions read from the counters.
  const counterContributions = new Map<
    string,
    {
      tokens: TokenUsage;
      basis: "delta" | "last-request";
      before: TokenUsage | undefined;
      last: TokenUsage | undefined;
      prefix: TokenUsage;
      admittedSum: TokenUsage | undefined;
      admittedBasis: "delta" | "last-request";
    }[]
  >();
  const uncertainDetails = new Set<string>();
  let counterContributionCount = 0;
  // null means only scope completeness changed; a number is the first affected receipt.
  const dirty = new Map<string, number | null>();
  const markDirty = (id: string, index: number | null) => {
    const prior = dirty.get(id);
    dirty.set(id, index === null ? (prior ?? null) : Math.min(index, prior ?? index));
  };
  const reconcile = () => {
    for (const [id, allocations] of coverage.changes()) markDirty(id, allocations ? 0 : null);
    for (const [id, firstReceipt] of dirty) {
      const contributions = counterContributions.get(id),
        record = records.get(id);
      if (record === undefined || contributions === undefined) continue;
      // Reserve complete selected-receipt traversal, not just helper recomputation.
      const start = firstReceipt ?? contributions.length;
      const repair = coverage.repairBudget(1 + contributions.length - start);
      const prefix = start === 0 ? undefined : contributions[start - 1];
      let tokens = prefix?.admittedSum,
        partial = record.partial,
        basis: "delta" | "last-request" = prefix?.admittedBasis ?? "delta";
      if (!repair || !coverage.scopeCovered(id)) {
        if (!partial) reducer.ambiguous++;
        partial = true;
      }
      if (firstReceipt === null) {
        record.partial = partial;
        continue;
      }
      for (let index = start; index < contributions.length; index++) {
        const contribution = contributions[index]!;
        let amount: TokenUsage | undefined = contribution.tokens;
        let partBasis = contribution.basis;
        if (
          partBasis === "delta" &&
          (!repair || !coverage.allocationCovered(id, contribution.before, contribution.prefix))
        ) {
          if (!partial) reducer.ambiguous++;
          partial = true;
          // Only the first independently known request can be retained without a delta;
          // later last snapshots may overlap an already known request in this native scope.
          const priorKnown = tokens !== undefined && tokens.inputTokens + tokens.outputTokens > 0;
          const normalized = makeCodexUsageLedger().observe(
            undefined,
            priorKnown ? undefined : contribution.last,
          );
          amount = normalized.tokens;
          if (normalized.basis !== undefined) partBasis = normalized.basis;
        }
        if (amount !== undefined) {
          const combined = tokens === undefined ? amount : addCodexCounts(tokens, amount);
          if (!validCodexCounts(combined)) {
            reducer.invalid++;
            partial = true;
          } else {
            tokens = combined;
            if (partBasis === "last-request") basis = "last-request";
          }
        }
        contribution.admittedSum = tokens;
        contribution.admittedBasis = basis;
      }
      // Refused repair conservatively retires these receipts after one bounded cleanup.
      // They cannot be revisited on every access after the shared work budget is exhausted.
      if (!repair) counterContributions.delete(id);
      if (tokens === undefined) records.delete(id);
      else {
        record.tokens = uncertainDetails.has(id)
          ? { inputTokens: tokens.inputTokens, outputTokens: tokens.outputTokens }
          : tokens;
        record.partial = partial;
        record.basis = basis;
      }
    }
    dirty.clear();
    reducer.nativeOverflow ||= coverage.overflow();
  };
  const ledger = makeCodexUsageLedger(),
    coverage = makeCodexHistoryCoverage();
  let firstMeta = true,
    precedingMetadataGap = false;
  let metadata: ReturnType<typeof sessionMetadata>,
    metadataConflict = false;
  let owner: string | undefined,
    parent: string | null = null,
    nested = false;
  let turnId: string | undefined,
    model: string | null = null,
    at: number | undefined;
  let turnPartial = false,
    turnModel: string | undefined,
    turnModelMissing = false,
    turnModelConflict = false,
    replaying = false,
    turnEnded = false;
  const resetEvidence = () => {
    turnPartial = false;
    turnModel = undefined;
    turnModelMissing = false;
    turnModelConflict = false;
  };
  const observeModel = () => {
    if (model === null) turnModelMissing = true;
    else if (turnModel === undefined) turnModel = model;
    else if (turnModel !== model) turnModelConflict = true;
  };
  let ordinal = 0,
    awaitingContext = false,
    hasContext = false;
  let from = initialFrom,
    to = initialTo;
  const remember = (id: string | undefined) => {
    if (id === undefined) return;
    if (nativeTurnIds.has(id)) return;
    if (nativeTurnIds.size < 50_000) nativeTurnIds.add(id);
    else reducer.nativeOverflow = true;
  };
  const reducer: HistoryReducer = {
    get records() {
      reconcile();
      return records;
    },
    nativeTurnIds,
    owner: undefined,
    nativeOverflow: false,
    identityComplete: true,
    invalid: 0,
    ambiguous: 0,
    retainedBytes() {
      return (
        Buffer.byteLength(JSON.stringify([...dirty])) +
        Buffer.byteLength(JSON.stringify([...uncertainDetails])) +
        ledger.retainedBytes() +
        coverage.retainedBytes() +
        responseProofBytes +
        responseRequirementBytes +
        requirementConflictBytes +
        (metadata === undefined ? 0 : Buffer.byteLength(JSON.stringify(metadata))) +
        [...counterContributions].reduce(
          (bytes, [id, items]) =>
            bytes + Buffer.byteLength(id) + Buffer.byteLength(JSON.stringify(items)),
          0,
        ) +
        (turnModel === undefined ? 0 : Buffer.byteLength(turnModel)) +
        [...rejected].reduce((bytes, id) => bytes + Buffer.byteLength(id), 0) +
        [...responses].reduce(
          (bytes, [turn, ids]) =>
            bytes +
            Buffer.byteLength(turn) +
            [...ids].reduce((n, id) => n + Buffer.byteLength(id), 0),
          0,
        )
      );
    },
    breakContext() {
      // A discarded report may contain a whole intervening request/session increment.
      // Later cumulative differences cannot attribute that missing usage to a new turn.
      ledger.invalidateBaseline();
      hasContext = false;
      awaitingContext = false;
      turnEnded = false;
      turnId = undefined;
      model = null;
      at = undefined;
    },
    window(start, end) {
      from = start;
      to = end;
      for (const [id, record] of records)
        if (record.at < from || record.at >= to) records.delete(id);
    },
    consume(value) {
      const raw = object(value),
        payload = object(raw.payload);
      if (raw.type === "session_meta") {
        const next = sessionMetadata(payload);
        if (firstMeta) {
          firstMeta = false;
          metadata = next;
          owner = next?.owner;
          reducer.owner = owner;
          parent = next?.fork ?? null;
          nested = next?.nestedParent != null;
          // Telemetry/context preceding the first header did not prove this session.
          ledger.endTurn();
          reducer.breakContext();
        }
        if (
          next === undefined ||
          metadata === undefined ||
          next.owner !== metadata.owner ||
          next.fork !== metadata.fork ||
          next.nestedParent !== metadata.nestedParent
        ) {
          // Contradiction is permanent for this physical source, including a later
          // return to the original header. Neither contexts nor terminals can repair
          // unscoped counter attribution or prove the absence of copied native IDs.
          metadataConflict = true;
          reducer.identityComplete = false;
          reducer.invalid++;
          ledger.endTurn();
          reducer.breakContext();
        }
        return;
      }
      if (firstMeta) {
        // Unowned context/counters cannot become the first header's ancestry/baseline.
        if (!precedingMetadataGap) {
          precedingMetadataGap = true;
          reducer.invalid++;
          reducer.identityComplete = false;
        }
        return;
      }
      // Per-response records carry their own actual owner/turn/response IDs.
      // A mixed header cannot lend them counter model context or terminal proof.
      if (metadataConflict && raw.type !== "token_usage_record") return;
      if (raw.type === "turn_context") {
        const next = identity(payload.turn_id) ?? (awaitingContext ? turnId : undefined);
        if (next !== turnId || !hasContext || (next === undefined && !awaitingContext)) {
          replaying = next !== undefined && nativeTurnIds.has(next);
          if (replaying) reducer.invalid++;
          if (replaying) ledger.endTurn();
          else {
            ledger.startTurn();
            if (next !== undefined) coverage.start(next, ledger.baseline());
          }
          turnEnded = false;
          resetEvidence();
        }
        hasContext = true;
        model = modelOf(payload.model);
        turnId = next;
        remember(turnId);
        awaitingContext = false;
        at = timeOf(raw.timestamp);
        return;
      }
      if (
        raw.type === "event_msg" &&
        (payload.type === "task_started" || payload.type === "turn_started")
      ) {
        const next = identity(payload.turn_id);
        // A repeated start for the current native turn is not a new accounting baseline.
        if (hasContext && next !== undefined && next === turnId) return;
        replaying = next !== turnId && next !== undefined && nativeTurnIds.has(next);
        if (replaying) reducer.invalid++;
        if (replaying) ledger.endTurn();
        else {
          ledger.startTurn();
          if (next !== undefined) coverage.start(next, ledger.baseline());
        }
        turnEnded = false;
        resetEvidence();
        hasContext = true;
        turnId = identity(payload.turn_id);
        remember(turnId);
        awaitingContext = true;
        at = timeOf(raw.timestamp);
        model = null;
        return;
      }
      if (raw.type === "event_msg" && payload.type === "model_reroute") {
        model = modelOf(payload.to_model);
        return;
      }
      if (
        raw.type === "event_msg" &&
        (payload.type === "task_complete" || payload.type === "turn_complete")
      ) {
        const id = identity(payload.turn_id);
        if (id === undefined) {
          // Close counter admission without fabricating native completion or losing replay proof.
          // An older identified replay is not a new cumulative accounting scope.
          if (!replaying) {
            ledger.invalidateBaseline();
            ledger.endTurn();
            turnEnded = true;
            turnPartial = true;
            const summary = turnId === undefined ? undefined : records.get(turnId);
            if (summary !== undefined) summary.partial = true;
            reducer.ambiguous++;
          }
          return;
        }
        if (id === turnId && hasContext && !replaying) {
          ledger.endTurn();
          turnEnded = true;
        }
        const summary = records.get(id);
        if (summary !== undefined) summary.complete = true;
        for (const response of responses.get(id) ?? []) {
          updateResponse(response, (record) => {
            record.turnComplete = true;
          });
        }
        // Each admitted response needs terminal proof once, including outside the window.
        // Repeated terminals must not rescan already completed response identities.
        responses.delete(id);
        return;
      }
      if (raw.type === "token_usage_record") {
        const scope = identity(payload.thread_id),
          turn = identity(payload.turn_id),
          response = identity(payload.response_id);
        if (nested || (owner !== undefined && scope !== owner)) return; // copied parent/subagent request
        const counts = codexCounts(payload.usage, true),
          expected = codexCounts(payload.turn_token_usage, true);
        if (
          owner === undefined ||
          scope !== owner ||
          turn === undefined ||
          response === undefined ||
          counts === undefined
        ) {
          ledger.invalidateBaseline();
          reducer.invalid++;
          return;
        }
        if (turn === turnId) {
          observeModel();
          const alternative = records.get(turn);
          if (alternative !== undefined) {
            const conflict =
              turnModelConflict ||
              (alternative.model !== null && model !== null && alternative.model !== model);
            if (turnModelMissing || conflict) alternative.model = null;
            if (conflict) alternative.modelConflict = true;
            if (alternative.modelWitness === undefined && turnModel !== undefined)
              alternative.modelWitness = turnModel;
          }
        }
        const evidence = coverage.request(turn, response, counts, ledger.baseline());
        if (evidence === "conflict" || evidence === "refused") {
          ledger.invalidateBaseline();
          reducer.invalid++;
          reducer.nativeOverflow ||= coverage.overflow();
          if (evidence === "conflict") {
            const id = `response:${response}`;
            updateResponse(id, (record) => {
              record.trusted = false;
            });
            rejected.add(id);
          }
          return;
        }
        const id = `response:${response}`;
        const requirementComplete = observeRequirement(
          id,
          payload.turn_token_usage,
          expected,
          counts,
        );
        // A larger native requirement proves missing coverage, not a new amount or
        // session counter. Apply it before window/replay returns and future deltas.
        if (expected !== undefined) coverage.requirement(turn, expected);
        else ledger.invalidateBaseline();
        if (!coverage.covers(ledger.baseline())) {
          ledger.invalidateBaseline();
          const summary = records.get(turn);
          if (summary !== undefined) summary.partial = true;
          if (turn === turnId) turnPartial = true;
        }
        remember(turn);
        if (rejected.has(id)) return;
        if (evidence === "duplicate") {
          // Amount identity is not a new date/model/requirement observation.
          updateResponse(id, (record) => {
            const witness = turn === turnId ? turnModel : undefined;
            if (
              (turn === turnId && turnModelConflict) ||
              (witness !== undefined &&
                record.modelWitness !== undefined &&
                witness !== record.modelWitness)
            ) {
              record.trusted = false;
              record.modelConflict = true;
              record.model = null;
              rejected.add(id);
              reducer.ambiguous++;
            } else if (record.modelWitness === undefined && witness !== undefined) {
              // Preserve original Unknown; a later reception does not rewrite execution.
              record.modelWitness = witness;
            }
            if (record.complete && !requirementComplete) reducer.ambiguous++;
            record.complete = requirementComplete;
            const required = responseRequirements.get(id);
            if (required === undefined) delete record.expectedTurnTokens;
            else record.expectedTurnTokens = required;
          });
          const original = responseProofs.get(id);
          if (original != null && original.at >= from && original.at < to)
            records.set(id, original);
          return;
        }
        if (responseProofs.size >= 50_000) {
          ledger.invalidateBaseline();
          reducer.nativeOverflow = true;
          return;
        }
        if (!requirementComplete) reducer.ambiguous++;
        const timestamp = turn === turnId ? (at ?? timeOf(raw.timestamp)) : timeOf(raw.timestamp);
        if (timestamp === undefined) {
          responseProofs.set(id, null);
          responseProofBytes += Buffer.byteLength(id) + 4;
          reducer.invalid++;
          return;
        }
        // A completed response has its own stable identity and a proven zero request baseline.
        const report = makeCodexUsageLedger(true).observe(counts, counts);
        if (report.tokens === undefined || report.basis === undefined) {
          reducer.invalid++;
          return;
        }
        const required = responseRequirements.get(id);
        const next: HistoryRecord = {
          provider: "codex",
          session: scope,
          id,
          turn,
          nativeIds: [turn],
          model: turn === turnId && !turnModelMissing && !turnModelConflict ? model : null,
          ...(turn === turnId && turnModelConflict ? { modelConflict: true } : {}),
          ...(turn === turnId && turnModel !== undefined ? { modelWitness: turnModel } : {}),
          at: timestamp,
          tokens: report.tokens,
          basis: report.basis,
          partial: false,
          complete: requirementComplete,
          trusted: true,
          parent: null,
          ...(required === undefined ? {} : { expectedTurnTokens: required }),
        };
        responseProofs.set(id, next);
        responseProofBytes += Buffer.byteLength(id) + Buffer.byteLength(JSON.stringify(next));
        const ids = responses.get(turn) ?? new Set<string>();
        ids.add(id);
        responses.set(turn, ids);
        if (timestamp >= from && timestamp < to) records.set(id, next);
        return;
      }
      if (raw.type !== "event_msg" || payload.type !== "token_count" || nested) return;
      if (replaying || turnEnded) return;
      const info = object(payload.info);
      // A syntactically valid null report is still an accounting continuity gap.
      const total = codexCounts(info.total_token_usage, true),
        last = codexCounts(info.last_token_usage, true);
      if (!coverage.covers(ledger.baseline())) ledger.invalidateBaseline();
      const before = ledger.baseline(),
        report = ledger.observe(total, last);
      if (hasContext && turnId !== undefined)
        coverage.counted(turnId, ledger.baseline(), report.tokens);
      if (!coverage.covers(ledger.baseline())) ledger.invalidateBaseline();
      reducer.nativeOverflow ||= coverage.overflow();
      if (!hasContext) {
        if (total !== undefined && total.inputTokens + total.outputTokens > 0)
          reducer.identityComplete = false;
        return; // idle/resume telemetry only seeds a baseline
      }
      if (total === undefined && last === undefined) reducer.invalid++;
      if (report.partial) reducer.ambiguous++;
      turnPartial ||= report.partial;
      if (total !== undefined || last !== undefined) observeModel();
      const existing = turnId === undefined ? undefined : records.get(turnId);
      if (ledger.detailConflict() && turnId !== undefined && existing !== undefined) {
        uncertainDetails.add(turnId);
        existing.tokens = {
          inputTokens: existing.tokens.inputTokens,
          outputTokens: existing.tokens.outputTokens,
        };
      }
      if (existing !== undefined) {
        existing.partial ||= turnPartial;
        if (turnModelMissing || turnModelConflict) existing.model = null;
        if (turnModelConflict) existing.modelConflict = true;
        if (existing.modelWitness === undefined && turnModel !== undefined)
          existing.modelWitness = turnModel;
      }
      if (report.tokens === undefined) return;
      const timestamp = at ?? timeOf(raw.timestamp);
      if (owner === undefined || timestamp === undefined) {
        reducer.invalid++;
        return;
      }
      if (turnId === undefined) reducer.identityComplete = false;
      if (timestamp < from || timestamp >= to) return;
      // Settle earlier dirty evidence before admitting another contribution to its sum.
      reconcile();
      const id = turnId ?? `request-${++ordinal}`,
        previous = turnId === undefined ? undefined : records.get(id);
      const counted =
        previous === undefined ? report.tokens : addCodexCounts(previous.tokens, report.tokens);
      const tokens = uncertainDetails.has(id)
        ? { inputTokens: counted.inputTokens, outputTokens: counted.outputTokens }
        : counted;
      if (!validCodexCounts(tokens)) {
        reducer.invalid++;
        ledger.invalidateBaseline();
        if (previous !== undefined) {
          previous.complete = false;
          previous.partial = true;
        }
        return;
      }
      if (turnId !== undefined && report.basis !== undefined) {
        if (counterContributionCount >= 50_000) {
          ledger.invalidateBaseline();
          reducer.nativeOverflow = true;
          reducer.ambiguous++;
          return;
        }
        const items = counterContributions.get(id) ?? [];
        items.push({
          tokens: report.tokens,
          basis: report.basis,
          before,
          last,
          prefix: coverage.prefix(turnId),
          admittedSum: undefined,
          admittedBasis: report.basis,
        });
        counterContributions.set(id, items);
        counterContributionCount++;
        markDirty(id, items.length - 1);
      }
      records.set(id, {
        provider: "codex",
        session: owner,
        id,
        nativeIds: turnId === undefined ? [] : [turnId],
        model:
          turnModelMissing ||
          turnModelConflict ||
          (previous !== undefined && previous.model !== model)
            ? null
            : model,
        ...(previous?.modelConflict || turnModelConflict ? { modelConflict: true } : {}),
        ...(turnModel === undefined ? {} : { modelWitness: turnModel }),
        at: previous?.at ?? timestamp,
        tokens,
        partial: turnPartial || previous?.partial === true,
        complete: false,
        trusted: true,
        parent,
        ...(report.basis === undefined
          ? {}
          : {
              basis:
                previous?.basis === "last-request" || report.basis === "last-request"
                  ? "last-request"
                  : "delta",
            }),
      });
      // Certify the new allocation now; a future metadata refusal cannot erase its proof
      // merely because a caller deferred reading the records getter.
      reconcile();
    },
  };
  return reducer;
}
