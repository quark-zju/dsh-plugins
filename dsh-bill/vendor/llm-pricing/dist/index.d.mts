import { n as memoryCache, t as PricingCache } from "./cache-Cko_DKwP.mjs";
import { B as PricePeriod, G as RateKey, H as PriceSource, I as ModelPrice, K as Rates, L as NormalizedSchedule, M as ContextTier, N as CostEstimate, R as PeakWindows, U as RATE_KEYS, V as PriceSchedule, W as RateCard, b as RequestFacts, c as SNAPSHOT_SYNCED_AT, d as DEFAULT_PROVIDER_PRIORITY, h as ParseModelsDevOptions, l as SNAPSHOT_SYNCED_AT_MS, n as pricingCandidates, q as TimeInput, z as PriceBasis } from "./resolve-CZuloOeh.mjs";
//#region src/estimate.d.ts
/**
 * Anthropic prices a 1-hour ephemeral cache write at 2x input, vs the
 * default 5-minute write at 1.25x input (the latter is what
 * `cacheCreationInputCostPerToken` already encodes).
 */
declare const CACHE_CREATE_1H_INPUT_MULTIPLIER = 2;
interface TokenCounts {
  inputTokens: number;
  /**
   * Whether `inputTokens` already contains `cacheCreationInputTokens` and
   * `cacheReadInputTokens`. Defaults to `true`.
   *
   * This is a property of whoever WROTE the row, not of the vendor. The
   * same turn is reported both ways: Anthropic's API — and Claude Code's
   * own log — put `input_tokens` beside the cache counts as the fresh
   * tokens alone, while a collector that normalises everything into one
   * schema (codetime's, for one, measured across 46,960 rows) stores the
   * total. It cannot be inferred: a sibling row with large fresh input and
   * a small cache write is indistinguishable from a superset row.
   *
   * Defaults to `true` because the failure directions are not symmetric.
   * Reading a superset as siblings bills cache reads at the full input rate
   * — on a cache-heavy workload a ~10x overcharge. Reading siblings as a
   * superset only drops the fresh component, which for the same workload is
   * a fraction of a percent.
   */
  inputIncludesCache?: boolean;
  /**
   * Tokens served from cache as reported by providers that do NOT split
   * cache read from cache creation (OpenAI / Codex). A subset of
   * `inputTokens`.
   */
  cachedInputTokens: number;
  cacheCreationInputTokens?: number;
  /**
   * TTL split subsets of `cacheCreationInputTokens`. Optional; absent on
   * legacy clients. When both are 0 the cost is identical to the pre-split
   * behaviour (everything charged at `cacheCreationInputCostPerToken`).
   */
  cacheCreation5mInputTokens?: number;
  cacheCreation1hInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens?: number;
  /**
   * Whether `reasoningOutputTokens` is already part of `outputTokens`.
   * Defaults to `true`.
   *
   * The output-side twin of `inputIncludesCache`, and producer-dependent
   * for the same reason. OpenAI and Anthropic fold reasoning into
   * `output_tokens`, so billing it again double-charges. Gemini does not:
   * `thoughtsTokenCount` sits beside `candidatesTokenCount` and inside
   * `totalTokenCount`, and Google charges for it at the output rate — so
   * ignoring it there drops real spend.
   *
   * Defaults to `true` because double-charging is the worse error, and
   * because it is what the two largest producers do.
   */
  reasoningIncludedInOutput?: boolean;
}
/**
 * Apply a resolved rate card to a set of token counts.
 *
 * Pure and stateless — every catalogue/schedule decision has already been
 * made by the time this runs, which is what makes it exhaustively testable.
 */
declare function costFromRates(rates: Rates, tokens: TokenCounts): number;
/**
 * The prompt length a long-context tier is selected against: everything on
 * the input side of the bill, and nothing from the output side.
 *
 * The same quantity `costFromRates` bills at the three input rates, which
 * is what makes it the right measure — the vendors' threshold is on the
 * prompt, and the prompt is exactly fresh input plus whatever part of it
 * was read from or written to cache. Output tokens are billed at the tier's
 * rate once it is crossed but never count toward crossing it.
 *
 * Only meaningful for a single request. Summed over a day it says nothing
 * about whether any individual request cleared a threshold, which is why
 * `estimate` consults it only under `perRequest`.
 */
declare function promptTokensBilled(tokens: TokenCounts): number;
/**
 * Whether these counts describe a request that used thinking.
 *
 * Any reasoning tokens at all is the signal, whichever side of
 * `reasoningIncludedInOutput` the producer reports them on — the question is
 * whether the request reasoned, not how many tokens it spent doing so.
 *
 * A producer that does not report reasoning tokens leaves this false, so such
 * a request pays the base card. That undercharges rather than overcharges, and
 * it is the same trade `perRequest` makes: no counts, no claim.
 */
declare function usedReasoning(tokens: TokenCounts): boolean;
/**
 * How many tokens `costFromRates` would bill for the same counts.
 *
 * Not the row's `total_tokens`: cache reads and fresh input are counted
 * once each rather than twice, and reasoning is included only when it sits
 * outside `outputTokens`. It answers "how much usage does this cost cover",
 * which is what makes an unpriced row's $0 legible as a gap.
 */
declare function tokensBilled(tokens: TokenCounts): number;
//#endregion
//#region src/row.d.ts
/**
 * How the producer of these rows nests its counts. Both default to the
 * majority convention; see `TokenCounts` for why guessing is not safe.
 *
 * A store that merges several agents into one schema will need this per
 * source rather than per query — the nesting travels with whoever wrote the
 * row, not with the model.
 *
 * Per source is the right granularity for `inputIncludesCache`, which no
 * amount of data can recover. It is not enough for
 * `reasoningIncludedInOutput`: measured on a real multi-agent store, two
 * sources report both ways within a single day and a single model id. Set
 * `inferShape` on `RowOptions` so each row's own total decides that half.
 */
type TokenShape = Pick<TokenCounts, 'inputIncludesCache' | 'reasoningIncludedInOutput'>;
/**
 * Column name carrying a row's pricing time anchor: the start of the UTC
 * hour its tokens were spent in, as epoch **seconds**, or NULL when the
 * model's price does not vary with time.
 *
 * This is one half of a contract. The other half lives in the query layer,
 * which must select this column (and group by it) for rows to price
 * exactly instead of being blended across the request window. Rows without
 * it still price, just less precisely.
 *
 * A reference Postgres expression:
 *
 * ```sql
 * case when lower(coalesce(model, '')) like '%deepseek%'
 *      then (floor(extract(epoch from ts) / 3600) * 3600)::bigint
 * end as price_hour_epoch
 * ```
 *
 * Build the LIKE list from `catalog.timeSensitiveSqlPatterns()` rather than
 * hard-coding it, and prefer `extract(epoch from ...)` over `date_trunc`:
 * the latter depends on the session TimeZone, which is the wrong frame for
 * a billing window.
 */
declare const PRICE_ANCHOR_COLUMN = "price_hour_epoch";
/**
 * Column names read by `estimateCostFromRow`. Override individually when
 * your table spells them differently.
 */
interface RowColumns {
  model: string;
  inputTokens: string;
  cachedInputTokens: string;
  cacheCreationInputTokens: string;
  cacheCreation5mInputTokens: string;
  cacheCreation1hInputTokens: string;
  cacheReadInputTokens: string;
  outputTokens: string;
  reasoningOutputTokens: string;
  /**
   * Read only by `inferTokenShape`, never for billing — the components are
   * what get priced, and a total that disagrees with them is a collector
   * bug rather than a cost.
   */
  totalTokens: string;
  priceAnchor: string;
  /**
   * Optional column carrying the request's prompt length, used only to
   * select a long-context tier. Read only under `perRequest`; when the
   * column is absent or non-positive the length is derived from the counts.
   */
  promptTokens: string;
}
declare const DEFAULT_ROW_COLUMNS: RowColumns;
/**
 * Recover `reasoningIncludedInOutput` from a row that carries a total.
 *
 * `TokenShape` is documented as a property of whoever wrote the row, which
 * invites passing it per source. Measured against a real multi-agent store,
 * that is not safe: `gemini` reports both ways — 857 of its 1,157
 * reasoning-bearing rows fold thinking into `output_tokens` and 300 sit it
 * alongside — and `opencode` splits 2,967/1,588. The two shapes overlap in
 * time and in model id (`gemini-3-flash-preview` and `big-pickle` each
 * produce both, from the same day), so no per-source, per-model, or
 * per-version rule separates them. Applying one source-wide overcharges the
 * majority by 4.2% on that store's `gemini` rows.
 *
 * The total settles it. Whenever reasoning is non-zero the two conventions
 * predict different totals, so exactly one can match:
 *
 * - `total == input + output + reasoning` — reasoning sits beside the
 *   output count. Gemini's `thoughtsTokenCount` does this, and Google bills
 *   it at the output rate, so it has to be added.
 * - `total == input + output` — reasoning is already inside `output_tokens`
 *   (OpenAI, Anthropic). Adding it again double-charges.
 *
 * Anything else — no total, zero reasoning, or a total matching neither —
 * returns `{}`, leaving the caller's own shape or the library default in
 * place. That is the honest answer: a row whose total disagrees with its
 * own components has a collector bug, and guessing which component is wrong
 * would be worse than billing the majority convention.
 *
 * Note this infers only the output side. `inputIncludesCache` genuinely
 * cannot be recovered — a sibling row with large fresh input and a small
 * cache write is arithmetically identical to a superset row, and the total
 * does not distinguish them either.
 *
 * Usually reached through `inferShape`, which applies it per row and merges
 * the result over whatever `shape` the caller passed:
 *
 * ```ts
 * const { cost } = estimateCostFromRow(row, {
 *   window,
 *   shape: shapeForSource(row.source),
 *   inferShape: true,
 * })
 * ```
 */
declare function inferTokenShape(row: Record<string, unknown>, columns?: RowColumns): TokenShape;
/**
 * Everything a row needs beyond the row itself.
 *
 * An options object rather than positional parameters because the useful
 * combinations are not nested: a caller wanting `shape` almost never wants
 * to restate `columns`, and one wanting `columns` rarely has a `window`.
 * Positionally, each of those meant passing `DEFAULT_ROW_COLUMNS` or
 * `undefined` as filler at every call site — six of them in the store this
 * was designed against.
 */
interface RowOptions {
  /**
   * The request's `[since, until]`. Rows carrying a `priceAnchor` price
   * exactly and ignore this; the rest blend across it.
   */
  window?: readonly [TimeInput, TimeInput];
  /** Override when the table spells its columns differently. */
  columns?: RowColumns;
  /**
   * How the producer nests its counts. Pass the per-source value; anything
   * `inferShape` recovers from the row is merged over it.
   */
  shape?: TokenShape;
  /**
   * Let each row's own `total_tokens` settle `reasoningIncludedInOutput`,
   * overriding `shape` where it can. Off by default: it reads a column
   * nothing else in this package reads, and a store that does not carry a
   * usable total gains nothing from the lookup.
   *
   * See `inferTokenShape` for why per-source alone is not safe here.
   */
  inferShape?: boolean;
  /**
   * Whether each row describes a single request rather than a sum. Off by
   * default; see `EstimateArgs.perRequest` for why this cannot be inferred.
   *
   * Set it for a table whose grain is one row per request, and long-context
   * tiers apply. Leave it off for anything grouped by day, model, or user —
   * the tier threshold is per request, and a sum no longer knows.
   */
  perRequest?: boolean;
}
//#endregion
//#region src/sources.d.ts
/**
 * A remote price catalogue: where to fetch it and how to read it.
 *
 * Adapters exist so the choice of upstream is a caller decision rather than
 * a hard-coded dependency. Every adapter must return per-token USD rates
 * keyed by lowercase model id, ideally indexed by both `vendor/model` and
 * the bare model name.
 */
interface PricingSource {
  name: string;
  url: string;
  parse: (json: any) => Map<string, PriceSchedule>;
}
/**
 * OpenRouter's `/models`. One quote per model, reflecting whichever
 * endpoint OpenRouter would route to by default — which is NOT always the
 * first-party price (see `catalog/overrides.ts`).
 */
declare function openRouterSource(url?: string): PricingSource;
/**
 * models.dev's `api.json` — the dataset behind llmpricing.dev. Quotes every
 * provider separately, so first-party rates are actually reachable, at the
 * cost of a ~4 MB payload and a provider-priority decision.
 */
declare function modelsDevSource(options?: ParseModelsDevOptions & {
  url?: string;
}): PricingSource;
//#endregion
//#region src/catalog.d.ts
interface PricingCatalogOptions {
  /**
   * Remote catalogues to consult, best first. A model resolves against the
   * first source that lists it. Defaults to `[modelsDevSource()]`, which
   * quotes each provider separately so first-party rates are reachable.
   *
   * Add `openRouterSource()` after it to fill in models models.dev does not
   * list, or put it first to price everything the way OpenRouter would
   * route it.
   *
   * Pass `[]` for a fully offline catalogue that only ever uses the bundled
   * snapshot and the overrides.
   */
  sources?: PricingSource[];
  /** How long a successful load stays fresh. Default: 24h. */
  refreshMs?: number;
  /**
   * How long to wait before retrying after every source failed. Default:
   * 5 minutes.
   *
   * Without this, `ensureLoaded()` on a per-request path re-attempts the
   * full download on every request for as long as the upstream is down,
   * adding its latency and bandwidth to each one. The bundled archive is
   * answering those requests correctly in the meantime, so there is no
   * urgency.
   */
  retryMs?: number;
  /**
   * Where to keep fetched catalogues between process lifetimes. Without
   * one, every restart re-downloads — and models.dev is ~4 MB, so a PM2
   * cluster pays that per worker per boot.
   *
   * `fileCache()` from `llm-pricing/node` is the usual choice; any string
   * store (Redis, KV, a `Map`) satisfies the interface.
   */
  cache?: PricingCache;
  /**
   * How long a cached copy may be used without re-fetching. Defaults to
   * `refreshMs`. A copy older than this is still kept as a last resort
   * when the network is down.
   */
  cacheTtlMs?: number;
  /** Injected for tests and for runtimes with a non-global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * How long to wait for a source before giving up on it. Default: 30s.
   *
   * `ensureLoaded()` is meant to be safe on a per-request path, and an
   * upstream that accepts the connection and then never answers would
   * otherwise hang every caller indefinitely.
   */
  timeoutMs?: number;
  /**
   * Extra schedules that outrank every remote source, merged over the
   * built-in overrides. Keys are lowercase model ids.
   */
  overrides?: Record<string, PriceSchedule>;
  /**
   * Extra schedules consulted after every remote source, merged over the
   * built-in fallback table. Keys are lowercase model ids.
   */
  fallback?: Record<string, PriceSchedule>;
  /** Called when a source fails to load. Defaults to `console.warn`. */
  onWarn?: (message: string, error: unknown) => void;
  /**
   * The moment the bundled archive was last known to be accurate, as epoch
   * ms. A live quote is grafted on as the period starting here, so history
   * before it keeps the rates the archive recorded. Defaults to the bundled
   * archive's sync date; override it when you supply your own `fallback`.
   */
  archiveObservedAt?: number;
}
interface PricingCatalogState {
  status: 'ready' | 'stale' | 'missing';
  loadedAt: number;
  source: string;
  size: number;
}
type EstimateArgs = TokenCounts & {
  model: string;
  /**
   * When these tokens were spent. Pass `at` whenever the row is anchored to
   * a real instant; pass `window` — the request's [since, until] — when it
   * is a sum over a range. Both are ignored for models with a flat
   * schedule, which is nearly all of them.
   */
  at?: TimeInput;
  window?: readonly [TimeInput, TimeInput];
  /**
   * Whether these counts describe **one request**. Defaults to false.
   *
   * This is the gate on long-context tiers (see `ContextTier`), and it has
   * to be stated rather than inferred, because the threshold is per request
   * and a sum destroys exactly that: ten 30k requests plus one 500k request
   * add up to the same input as eleven 70k requests, and only the first has
   * a row that crossed 272k. Dividing by a request count does not recover
   * it either — an average is not a distribution.
   *
   * Defaulting to false keeps an aggregated row on the base card, which
   * undercharges the rare long request rather than overcharging every short
   * one. Rows that really are per-request — an agent CLI's message log, a
   * request-level API table — should set it and get the tier.
   */
  perRequest?: boolean;
  /**
   * The prompt length to select a long-context tier against, overriding what
   * the counts imply. Passing it implies `perRequest`.
   *
   * For rows that carry the context length directly but whose component
   * counts are unreliable — a producer that stores `context_tokens` but
   * folds its cache counts together, say. Without it the length is derived
   * from the same quantities that get billed at the input rates
   * (`promptTokensBilled`), which is right whenever those counts are.
   */
  promptTokens?: number;
};
declare class PricingCatalog {
  private readonly sources;
  private readonly refreshMs;
  private readonly retryMs;
  private readonly cache;
  private readonly cacheTtlMs;
  private readonly fetchImpl;
  private readonly timeoutMs;
  private readonly overrides;
  private readonly fallback;
  private readonly onWarn;
  private readonly archiveObservedAt;
  private loadedAt;
  private failedAt;
  private status;
  private sourceName;
  private remote;
  private inflight;
  /**
   * Resolved lookups, keyed by the raw stored model string. A dashboard
   * request resolves thousands of rows across a handful of distinct models,
   * and every miss re-runs the whole candidate expansion. Invalidated
   * wherever `remote` is reassigned.
   */
  private readonly resolved;
  /** Entries currently memoised. Exposed for tests and diagnostics. */
  get resolvedSize(): number;
  constructor(options?: PricingCatalogOptions);
  /**
   * Every LIKE pattern a query layer must split by UTC hour, derived from
   * the schedules themselves so the two can never drift: a vendor that
   * gains a peak schedule declares `sqlMatch` next to its periods and the
   * query layer follows automatically.
   */
  timeSensitiveSqlPatterns(): readonly string[];
  /**
   * Patterns for models the *live* catalogue has repriced since the archive
   * was synced — they are time-sensitive only once a source is loaded, so
   * they cannot be derived from the static tables. Recomputed on each load.
   *
   * Looks each archive id up in the remote map directly rather than through
   * `pricingCandidates`: both are keyed by the same catalogue ids, and a
   * miss here only means the model blends across the request window instead
   * of pricing exactly.
   */
  private livePatterns;
  private recomputeLivePatterns;
  /**
   * Load the remote catalogue if it is missing or stale. Safe to call on
   * every request: it resolves immediately while fresh and de-duplicates
   * concurrent loads.
   */
  ensureLoaded(options?: {
    force?: boolean;
  }): Promise<void>;
  /** Hold a load as the in-flight one until it settles. */
  private track;
  /**
   * Reload now, ignoring the freshness window, the failure backoff and any
   * cached copy. For a "prices look wrong" button, a deploy hook, or a cron
   * that wants the catalogue warm before traffic arrives.
   */
  refresh(): Promise<void>;
  /**
   * Fetch one source, or read it from the cache when a fresh copy is
   * there. Returns the response body plus the time it was actually
   * retrieved from the network.
   */
  private fetchSource;
  /**
   * Enforce the deadline ourselves as well as passing the signal.
   *
   * `AbortSignal` only helps if the fetch implementation honours it — a
   * custom or mocked one need not, and then the timeout protects nobody.
   * The timer is cleared on settle so it cannot hold the process open.
   */
  private withTimeout;
  /**
   * A cache is an optimisation, so neither half of it may take the
   * catalogue down. A Redis client rejects when Redis is down; without
   * these guards an unreachable cache would stop the source from being
   * fetched at all, and a failed write-through would throw away a download
   * that had already succeeded.
   */
  private readCache;
  private writeCache;
  private load;
  state(): PricingCatalogState;
  getSchedule(model: string): NormalizedSchedule | null;
  private resolveSchedule;
  /**
   * The `pricing` block handed back per row, memoised on the rate card so a
   * request pricing thousands of rows against the same card allocates one
   * object rather than thousands. A rate card belongs to exactly one
   * schedule, so its name and provenance can never disagree.
   */
  private readonly priceCards;
  /**
   * The last blend computed for each schedule.
   *
   * Purely an allocation optimisation. `weightedRates` builds a fresh
   * `Rates` per call, so without this a request folding 93,000 blended rows
   * allocates 93,000 rate cards and 93,000 `ModelPrice` wrappers where one
   * of each would do — the memo above is keyed on the `Rates` object, so it
   * cannot help. Nothing depends on the sharing being achieved:
   * `sumEstimates` groups cards by value, so a miss costs time and never
   * changes an answer.
   *
   * One slot, not a map. A request folds every row against a single
   * window, so a second slot would never be read, and a map keyed by
   * request parameters is an unbounded structure hanging off schedules that
   * — for flat models — the constructor owns and never releases.
   */
  private readonly lastBlend;
  /**
   * What this row says about the single request behind it — nothing at all
   * unless the caller declared it to be one.
   *
   * `promptTokens` implies `perRequest`: a caller who states the prompt length
   * has necessarily told us the row describes one prompt. `usedReasoning` is
   * always derived, never asserted by the caller, because the counts answer it
   * directly and a producer that reports no reasoning tokens has said as much.
   */
  private factsFor;
  private ratesForMemo;
  private priceCardFor;
  /**
   * Resolve a model to the flat rate card that applies at `at` (default: now).
   *
   * `facts` selects a per-request variant, for showing what a request of that
   * shape would be charged — `{ promptTokens }` for a long-context tier,
   * `{ usedReasoning: true }` for thinking mode. Omitted, the base card is
   * returned, which is the right answer for "what does this model cost".
   */
  getPrice(model: string, at?: TimeInput, facts?: RequestFacts): ModelPrice | null;
  /**
   * Price a set of token counts.
   *
   * An unknown model returns cost 0 with `pricing: null` — the pair is what
   * separates "we do not know" from "it was free", and `tokens` records how
   * much usage that $0 is standing in for. Feed the results to
   * `sumEstimates` rather than adding `cost` up by hand, which throws that
   * distinction away along with the basis and the cards.
   */
  estimate(args: EstimateArgs): CostEstimate;
  /**
   * Price a raw SQL row using snake_case `*_tokens` column names — the same
   * thing `estimateCostFromRow` does, against this catalogue rather than
   * the default one.
   *
   * Pass `columns` when your table spells them differently, `shape` when
   * the rows come from a producer that nests its counts differently — that
   * travels with whoever wrote the row, not with the model — and
   * `inferShape` to let each row's own total correct the half of `shape`
   * that is recoverable.
   */
  estimateFromRow(row: Record<string, unknown>, options?: RowOptions): CostEstimate;
}
//#endregion
//#region src/total.d.ts
/**
 * A sum of estimates that keeps what a bare `+=` throws away.
 *
 * Every estimate carries provenance and a confidence — which card priced
 * it, how the card was arrived at, whether the model was known at all. Cost
 * is the only part of that which adds, so a caller folding thousands of
 * rows loses the rest at the first `+`. What they write instead is an
 * ad-hoc accumulator, and the ad-hoc version is usually wrong in the same
 * way: it keeps the *last* card it saw and calls it the model's price.
 *
 * That is only true when every row of a model shares one card, which is
 * exactly false for the models this package works hardest on — a DeepSeek
 * model spanning peak and off-peak has two, a factor of two apart.
 */
interface CostTotal {
  /** Summed cost. Identical to adding `estimate.cost` by hand. */
  cost: number;
  /**
   * The interval the true cost lies in, summed from each estimate's own
   * bounds. Equal to `cost` unless something in the sum was blended across a
   * price change, or priced on a long-context model without `perRequest` —
   * see `CostEstimate.low`.
   */
  low: number;
  high: number;
  /** Estimates folded in, and how many of them had no price. */
  count: number;
  /**
   * Estimates whose model the catalogue does not list. Their cost is 0,
   * so a total containing them is an undercount by construction — this is
   * how much of one.
   */
  unpriced: {
    count: number;
    tokens: number;
  };
  /** Tokens billed, across the priced estimates only. */
  tokens: number;
  /**
   * Cost split by how it was arrived at. `blended` is the share that would
   * sharpen if the query grouped by UTC hour; `flat` needs no such fix.
   */
  byBasis: Record<PriceBasis, number>;
  /**
   * The distinct rate cards that produced this cost, most expensive first,
   * with what each contributed. More than one for a model priced across a
   * peak boundary, or a workload whose long requests crossed a long-context
   * threshold while its short ones did not — the cases a single `pricing`
   * field cannot represent and silently misreports.
   */
  cards: Array<{
    pricing: ModelPrice;
    cost: number;
    count: number;
  }>;
}
/**
 * Fold estimates into one total, keeping their provenance and confidence.
 *
 * ```ts
 * const total = sumEstimates(rows.map(row => estimateCostFromRow(row, { window })))
 *
 * total.cost                  // what to display
 * total.low, total.high       // how far off it could be
 * total.unpriced.tokens       // usage this total counts as $0
 * total.byBasis.blended       // cost that an hour-grouped query would sharpen
 * total.cards                 // every rate actually applied, not just the last
 * ```
 *
 * Accepts any iterable, so a generator over a cursor never materialises the
 * estimates.
 *
 * Two rows quoting the same price share one card entry whatever produced
 * them — the same catalogue, two catalogues, or an estimate assembled by
 * hand. Grouping on object identity would have been cheaper, but it would
 * make this function's answer depend on a private memo inside
 * `PricingCatalog`: a cache eviction, a second instance, or a round-trip
 * through JSON would silently split one price into many entries, which is
 * the exact failure this function exists to prevent.
 */
declare function sumEstimates(estimates: Iterable<CostEstimate>): CostTotal;
//#endregion
//#region src/index.d.ts
/**
 * Set the options the default catalogue is built with. Call it once,
 * during startup, **before** anything touches the default catalogue.
 *
 * The usual reason is a cache:
 *
 * ```ts
 * import { configureDefaultCatalog } from 'llm-pricing'
 * import { fileCache } from 'llm-pricing/node'
 *
 * configureDefaultCatalog({ cache: fileCache() })
 * ```
 *
 * Throws if the catalogue already exists. Configuring it after the fact
 * cannot retroactively apply — the alternative is silently ignoring the
 * options and serving a whole process from an unconfigured catalogue.
 */
declare function configureDefaultCatalog(options: PricingCatalogOptions): PricingCatalog;
/** The shared catalogue, created on first call. */
declare function getDefaultCatalog(): PricingCatalog;
/** See `PricingCatalog#ensureLoaded`. */
declare function ensurePricingLoaded(): Promise<void>;
/** See `PricingCatalog#refresh`. */
declare function refreshPricing(): Promise<void>;
/** See `PricingCatalog#state`. */
declare function pricingState(): PricingCatalogState;
/** See `PricingCatalog#getPrice`. */
declare function getPriceFor(model: string, at?: TimeInput, facts?: RequestFacts): ModelPrice | null;
/** See `PricingCatalog#estimate`. */
declare function estimateCostUsd(args: EstimateArgs): CostEstimate;
/** See `PricingCatalog#estimateFromRow`. */
declare function estimateCostFromRow(row: Record<string, unknown>, options?: RowOptions): CostEstimate;
/** See `PricingCatalog#timeSensitiveSqlPatterns`. */
declare function timeSensitiveSqlPatterns(): readonly string[];
//#endregion
export { CACHE_CREATE_1H_INPUT_MULTIPLIER, type ContextTier, type CostEstimate, type CostTotal, DEFAULT_PROVIDER_PRIORITY, DEFAULT_ROW_COLUMNS, type EstimateArgs, type ModelPrice, type NormalizedSchedule, PRICE_ANCHOR_COLUMN, type ParseModelsDevOptions, type PeakWindows, type PriceBasis, type PricePeriod, type PriceSchedule, type PriceSource, type PricingCache, PricingCatalog, type PricingCatalogOptions, type PricingCatalogState, type PricingSource, RATE_KEYS, type RateCard, type RateKey, type Rates, type RequestFacts, type RowColumns, type RowOptions, SNAPSHOT_SYNCED_AT, SNAPSHOT_SYNCED_AT_MS, type TimeInput, type TokenCounts, type TokenShape, configureDefaultCatalog, costFromRates, ensurePricingLoaded, estimateCostFromRow, estimateCostUsd, getDefaultCatalog, getPriceFor, inferTokenShape, memoryCache, modelsDevSource, openRouterSource, pricingCandidates, pricingState, promptTokensBilled, refreshPricing, sumEstimates, timeSensitiveSqlPatterns, tokensBilled, usedReasoning };