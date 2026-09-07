//#region src/types.d.ts
declare const RATE_KEYS: readonly ["inputCostPerToken", "cacheCreationInputCostPerToken", "cacheReadInputCostPerToken", "cachedInputCostPerToken", "outputCostPerToken"];
type RateKey = (typeof RATE_KEYS)[number];
type Rates = Record<RateKey, number>;
/**
 * Where a rate card came from.
 *
 * - `openrouter` — the OpenRouter live catalogue.
 * - `modelsdev`  — the models.dev live catalogue.
 * - `fallback`   — the built-in table, used when the network is unavailable
 *                  or no catalogue lists the model.
 * - `override`   — a first-party schedule that deliberately OUTRANKS every
 *                  catalogue (see `src/catalog/overrides.ts`).
 * - `missing`    — reserved for callers that want to mark an unpriced model
 *                  without a null check.
 */
type PriceSource = 'openrouter' | 'modelsdev' | 'fallback' | 'override' | 'missing';
type ModelPrice = Rates & {
  displayName?: string;
  source: PriceSource;
  /**
   * Which provider inside `source` quoted this. `source` alone does not
   * identify a price: models.dev carries 186 providers quoting 6,199
   * models between them, so a bare model name collides 15-25 ways and the
   * winner is decided by provider priority — first-party where one exists,
   * and otherwise by whichever provider id sorts first. That tie-break is
   * arbitrary and, without this field, invisible.
   *
   * Absent on the built-in tables (`fallback`, `override`), which quote
   * first-party rates by construction and have no provider to name.
   */
  providerId?: string;
  /**
   * The long-context tier this card came from — its `abovePromptTokens`
   * threshold. Absent on the base card, which is what nearly every row
   * pays. See `ContextTier`; `sumEstimates` keys on this, so a request that
   * crossed the threshold is reported as its own line rather than averaged
   * into the base rate.
   */
  contextTierAbove?: number;
  /**
   * Whether this card is the thinking-mode variant — see `RateCard`. Part of
   * the card's identity for the same reason `contextTierAbove` is: "the output
   * rate" and "the output rate in thinking mode" are two facts about one
   * model, and `sumEstimates` keys on both so a mixed workload reports them
   * apart rather than averaged.
   */
  reasoningMode?: boolean;
};
/**
 * A rate card, plus the variant a request that used *thinking* pays instead.
 *
 * Alibaba is the vendor this exists for, and it publishes the rule plainly:
 * `qwen-plus` bills output at $1.2/MTok normally and **$4/MTok in thinking
 * mode**, under a column headed 思维链+回答 — "chain of thought AND answer".
 * So it is not a separate price for reasoning tokens; it replaces the card for
 * the whole response. Perplexity's `sonar-deep-research` does the other thing
 * — $3/MTok for reasoning tokens *added to* $8/MTok output — and that one is
 * deliberately not modelled here, because the two cannot share a shape. See
 * `reasoningRatesFrom` for how the two are told apart.
 *
 * A variant hangs off each card rather than off the period, because the two
 * request-scale dimensions genuinely compose: Alibaba's Beijing listing prices
 * a 128k-256k prompt at $2.868/MTok output normally and $3.441 in thinking
 * mode. Upstream publishes no model with both today, but the vendor's own
 * table has both axes, so the shape has to allow it.
 */
interface RateCard {
  rates: Rates;
  /**
   * What this card costs for a request that used thinking. Absent — the
   * overwhelming majority — means the vendor charges thinking output at the
   * same rate as any other output, which is what 97 of the 143 models
   * quoting the field say explicitly.
   *
   * Only consulted when the caller states the row describes a single request,
   * for the same reason a long-context tier is: a sum of thinking and
   * non-thinking requests cannot be attributed to either card. See
   * `EstimateArgs.perRequest`.
   */
  reasoningRates?: Rates;
}
/**
 * A dearer rate card that applies to a whole request once its **prompt**
 * exceeds `abovePromptTokens`.
 *
 * Real and widely published: `gpt-5.5` doubles input and takes output to
 * 1.5x above 272k, Gemini 2.5 Pro does the same above 200k, and so do
 * Vertex's Claude listings. models.dev publishes these as
 * `cost.tiers[].tier = { type: 'context', size }`.
 *
 * Three things this shape says deliberately:
 *
 * - **A full card, not a multiplier.** The ratios are not uniform — 206 of
 *   the 375 tiers upstream are input x2 / output x1.5, but 74 are x2/x2 and
 *   others run to x4. A multiplier would approximate all of them.
 * - **Measured on the prompt, billed on everything.** Output tokens do not
 *   count toward the threshold but are billed at the tier's output rate
 *   once it is crossed — which is what the vendors' ">200K prompt" wording
 *   means.
 * - **Inside a period, not beside it.** Tiers are themselves historical:
 *   Anthropic's own >200k premium ($6/$22.50 on Sonnet 4/4.5) existed until
 *   2026-03-13 and was then withdrawn, so a schedule has to carry a tier
 *   for its old periods and none for its new ones.
 */
interface ContextTier extends RateCard {
  /** Strictly greater than: a prompt of exactly this size pays the base card. */
  abovePromptTokens: number;
}
/**
 * When* a peak card applies, with no reference to what it costs.
 *
 * Named and separated from the rates so the primitives that answer "is this
 * instant peak?" take the whole shape rather than its fields: `daysUtc` was
 * once a loose optional argument beside `windowsUtc`, and every call that
 * forgot it kept compiling while billing DeepSeek's weekends at twice the
 * rate.
 */
interface PeakWindows {
  /** Daily [startHour, endHour) UTC windows. */
  windowsUtc: Array<[number, number]>;
  /**
   * The UTC weekdays (0 = Sunday) those windows apply on; absent means every
   * day. DeepSeek bills the off-peak rate around the clock at weekends.
   *
   * One set for every window, in UTC — which states a vendor's *local*
   * weekday rule only while none of its windows crosses a UTC midnight.
   * DeepSeek's clear that bar with room to spare (01:00-10:00 UTC is
   * 09:00-18:00 the same Beijing day, so the two weekdays cannot disagree
   * inside a window), but a vendor whose local peak straddles midnight would
   * need a different weekday set per side of it and cannot be written here:
   * expressing that is a change to this shape, not a `daysUtc` a caller can
   * pick. Nothing enforces the precondition, so check it when adding a
   * vendor — the failure is silent and per-instant.
   */
  daysUtc?: number[];
}
interface PricePeriod extends RateCard {
  from: number;
  peak?: PeakWindows & {
    rates: Rates;
  };
  /**
   * Long-context tiers, ascending by threshold; the highest one the prompt
   * clears wins. Only consulted when the caller states the row describes a
   * single request — see `EstimateArgs.perRequest`.
   *
   * Never present alongside `peak`. No vendor publishes both, and pricing
   * one of the two dimensions away silently would be worse than refusing
   * the combination, so `normalizeSchedule` drops the tiers and warns.
   */
  contextTiers?: ContextTier[];
}
interface PriceSchedule {
  displayName?: string;
  source: PriceSource;
  /** Which provider inside `source` quoted this. See `ModelPrice`. */
  providerId?: string;
  /**
   * How much this quote is trusted; lower wins. `0` means the source ranks
   * the quoting provider as first-party for this model, `1` (the default
   * when absent) means it does not.
   *
   * A lookup probes several spellings of one stored name, and a spelling
   * can be listed *only* by resellers: `gpt-5-5` is sold by three no-name
   * routers at three different prices, while OpenAI's own listing is filed
   * under `gpt-5.5`. Without a tier the exact-but-worthless spelling wins
   * on candidate order alone.
   */
  tier?: number;
  /**
   * Ascending by `from`. The first entry opens at -Infinity so any
   * timestamp resolves.
   */
  periods: PricePeriod[];
  /**
   * SQL LIKE patterns (lowercase) matching every stored spelling of this
   * model. REQUIRED on any schedule that is time-sensitive (more than one
   * period, or any peak window): it is what tells a query layer to split
   * these rows by UTC hour so each hour can take its own rate. Match the
   * whole vendor rather than one model id — over-matching only costs a few
   * extra (correctly priced) rows, under-matching silently mis-prices.
   */
  sqlMatch?: string[];
}
declare const NORMALIZED: unique symbol;
/**
 * A schedule that has been through `normalizeSchedule`, and so keeps every
 * promise the comments above make: at least one period, ascending by `from`,
 * the first opening at -Infinity, and peak windows that are real, disjoint
 * UTC hours.
 *
 * The primitives that read a schedule run once per priced row and therefore
 * check nothing — which is the whole reason validation happens at ingest.
 * This brand is what keeps that from being a convention: they accept only
 * this type, so no schedule can reach them without passing the gate.
 * `mergeLiveQuote` and `scaleSchedule` both produced schedules that skipped
 * it while nothing but a comment said they should not.
 *
 * There is no way to make one except through `normalizeSchedule`, exported
 * from `llm-pricing/internal` for anyone extending the package.
 */
type NormalizedSchedule = PriceSchedule & {
  readonly [NORMALIZED]: true;
};
type TimeInput = number | string | Date | null | undefined;
/**
 * How a rate card was arrived at:
 *
 * - `flat`    — the model has a single timeless rate; `at` is irrelevant.
 * - `exact`   — time-sensitive model priced at a known instant.
 * - `blended` — time-sensitive model priced across a window (see `blendRates`).
 */
type PriceBasis = 'flat' | 'exact' | 'blended';
interface CostEstimate {
  cost: number;
  pricing: ModelPrice | null;
  basis: PriceBasis;
  /**
   * What this row could have cost, at the cheapest and dearest rate card the
   * estimate could not rule out.
   *
   * Two things separate them from `cost`:
   *
   * - **A blend.** They are the off-peak and peak ends of the window, which
   *   for DeepSeek is a factor of two apart. `basis: 'blended'` says the
   *   number is approximate; these say by how much.
   * - **An unstated prompt length on a model that prices by it.** The row is
   *   costed at the base card, because a sum cannot say whether any request
   *   inside it crossed a long-context threshold — but it may have, and
   *   `high` is what that would have cost. Pass `perRequest` and the interval
   *   closes to a point. Note this applies at `basis: 'flat'` too: the
   *   uncertainty is about prompt size, not about time.
   *
   * Equal to `cost` whenever exactly one card was possible, which is nearly
   * every row. Sound because cost is linear in the rates: blending averages
   * the cards, so the blended cost is the same average of their costs and
   * cannot fall outside them.
   */
  low: number;
  high: number;
  /**
   * Tokens this estimate billed for — the quantities actually multiplied by
   * a rate, after cache carve-outs and the reasoning convention. Zero-cost
   * for an unpriced model, where it is the only record that real usage was
   * counted as $0. See `sumEstimates`.
   */
  tokens: number;
}
declare const HOUR_MS: number;
declare const DAY_MS: number;
//#endregion
//#region src/schedule.d.ts
declare function toMs(value: TimeInput): number | null;
/**
 * A schedule is time-sensitive when *when* the tokens were spent changes
 * what they cost: more than one effective period, or any peak window.
 *
 * Called once per priced row, so it stays allocation-free (no closure).
 */
declare function isTimeSensitive(schedule: PriceSchedule): boolean;
/**
 * What the caller has told us about the *single request* a row describes.
 *
 * Two of the four pricing dimensions are per-request rather than per-moment —
 * how long the prompt was, and whether the request reasoned — and neither can
 * be recovered from a sum. They travel together because they are answers to
 * the same question ("what do we know about this one request?"), are gated by
 * the same caller declaration, and are handled the same way when absent: the
 * base card prices the row, and every card that was not ruled out widens
 * `low`/`high`.
 *
 * A field left `undefined` means the caller did not say — never "no" — which
 * is why `usedReasoning` is a tri-state rather than a plain boolean.
 */
interface RequestFacts {
  promptTokens?: number;
  usedReasoning?: boolean;
}
declare function pricesByRequest(schedule: PriceSchedule): boolean;
declare function periodAt(schedule: NormalizedSchedule, atMs: number): PricePeriod;
declare function isPeakHour(peak: PeakWindows, atMs: number): boolean;
/**
 * The tier a prompt of `promptTokens` falls in, or null for the base card.
 *
 * `undefined` promptTokens means the caller did not state that this row is
 * one request, so no tier can be selected — see `EstimateArgs.perRequest`.
 * Ascending order is a `normalizeSchedule` invariant, so the last match is
 * the highest one cleared.
 */
declare function contextTierFor(period: PricePeriod, promptTokens: number | undefined): ContextTier | null;
/** Exact rate card at one instant. */
declare function ratesAt(schedule: NormalizedSchedule, atMs: number, facts?: RequestFacts): Rates;
/**
 * Milliseconds of [from, to) that land inside a daily UTC peak window.
 *
 * O(windows + 7) — differencing the two prefix sums beats walking the range a
 * day at a time, which cost ~730 iterations for a year-long window. The
 * weekday count each prefix needs depends only on the boundary, so it is
 * taken once rather than per window.
 */
declare function peakMsBetween(peak: PeakWindows, fromMs: number, toMs: number): number;
/**
 * The rate cards a blend draws on, with the wall-clock weight each carries.
 *
 * Separate from `blendRates` because the weighted average throws away the
 * one thing that says how rough it is: the cards it averaged. Keeping them
 * is what lets an estimate report the interval its true cost must lie in.
 */
declare function blendParts(schedule: NormalizedSchedule, fromMs: number, toMs: number, facts?: RequestFacts): Array<{
  rates: Rates;
  weight: number;
}>;
/**
 * Degraded path: the row is a sum over a whole window, so we no longer know
 * which hours its tokens were spent in. Blend the schedule across the
 * window by wall-clock time — i.e. assume usage is spread evenly. That is
 * wrong for a user who only ever codes during peak hours, but it is
 * bounded (never outside [off-peak, peak]) and it is the honest answer when
 * the time axis has already been aggregated away. Callers that *do* have a
 * timestamp pass `at` instead and get the exact rate.
 */
declare function blendRates(schedule: NormalizedSchedule, fromMs: number, toMs: number, facts?: RequestFacts): Rates;
/**
 * A schedule resolved to one rate card, with how that was arrived at.
 *
 * Named because three places hold it: `ratesFor` returns it, and the
 * catalogue both stores and returns it.
 */
interface ResolvedRates {
  rates: Rates;
  basis: PriceBasis;
  /**
   * The distinct cards this cost could have been charged at — the material
   * for a cost interval, not a claim that any of them was applied.
   *
   * Two things put a card in here. A blend averaged it (the peak and
   * off-peak ends of a window), or the caller left one of the per-request
   * facts unstated on a model priced by it, so a long or reasoning request
   * inside the row would have paid a dearer card — see `unruledOutCards`.
   *
   * Absent when the resolution really did have exactly one possible card,
   * which is nearly every row.
   *
   * The invariant a consumer may rely on, whichever source filled it:
   * `min(cards ∪ {cost}) <= cost <= max(cards ∪ {cost})`. Note it does not
   * assume a tier is dearer than its base — two upstream listings quote one
   * that is cheaper on output, and those land on the `low` side by
   * themselves.
   */
  cards?: Rates[];
  /**
   * The long-context threshold this resolution crossed, when it crossed
   * one. On a blend, set only when every segment that carried weight landed
   * in the same tier — otherwise the averaged card belongs to no single
   * tier and claiming one would be a lie about which rate was applied.
   */
  tierAbove?: number;
  /** Whether the card returned is a thinking-mode variant. */
  reasoningMode?: boolean;
}
/**
 * Resolve a schedule to the one flat rate card that applies, either at an
 * instant (`at`) or averaged across a window. Both are ignored for models
 * with a flat schedule, which is nearly all of them.
 */
declare function ratesFor(schedule: NormalizedSchedule, at: TimeInput, window: readonly [TimeInput, TimeInput] | undefined, now?: number, facts?: RequestFacts): ResolvedRates;
//#endregion
//#region src/catalog/modelsdev.d.ts
declare const MODELS_DEV_URL = "https://models.dev/api.json";
declare const DEFAULT_PROVIDER_PRIORITY: readonly string[];
interface ModelsDevCost {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
  reasoning?: number;
  /**
   * Request-scale tiers. Each entry is a full cost block plus the threshold
   * that selects it; only `tier.type === 'context'` exists upstream today
   * (375 of 375 tiers across 360 models), and anything else is ignored
   * rather than guessed at.
   */
  tiers?: ModelsDevTier[];
}
interface ModelsDevTier extends ModelsDevCost {
  tier?: {
    type?: string;
    size?: number;
  };
}
interface ModelsDevModel {
  id?: string;
  name?: string;
  cost?: ModelsDevCost;
}
type ModelsDevResponse = Record<string, {
  id?: string;
  name?: string;
  models?: Record<string, ModelsDevModel>;
}>;
interface ParseModelsDevOptions {
  /** Provider ids that win the bare-name index, best first. */
  providerPriority?: readonly string[];
}
/** The five rates a models.dev cost block implies, in `divisor`'s unit. */
declare function ratesFromCost(cost: ModelsDevCost, divisor: number): Rates;
/**
 * The rates a long-context tier implies — the tier's own numbers where it
 * publishes them, and otherwise the base card's, scaled by how much the tier
 * moved input.
 *
 * A tier is a *variant* of the base card, not an independent quote, and the
 * generic defaults get that badly wrong when a tier is quoted partially.
 * `openrouter`'s `google/gemini-2.5-pro` publishes `cache_write: 0.375` on the
 * base and omits it on the >200k tier; `cacheRatesFrom` would then fall back
 * to the tier's own `cache_read` of 0.25 and bill long requests' cache writes
 * BELOW the base rate, while their input doubled. 11 listings upstream are
 * shaped that way.
 *
 * Scaling by the input ratio is the assumption these vendors actually
 * publish — every fully-quoted tier upstream moves its cache rates in step
 * with input — and it can only ever be applied to a number the tier did not
 * state, so an explicit upstream rate is never overridden. That matters for
 * the two listings whose tier is genuinely *cheaper* in one dimension
 * (`llmgateway`'s grok-4-20 pair): those numbers are quoted, so they stand.
 */
declare function tierRatesFrom(base: ModelsDevCost, tier: ModelsDevTier, divisor: number): Rates;
/**
 * The long-context tiers a models.dev cost block declares, ascending.
 *
 * Only `type: 'context'` is read. A tier's threshold is a **prompt** length,
 * so a differently-typed tier would be selected by something this package
 * does not measure; ignoring it prices those requests at the base rate,
 * which undercharges, where guessing could overcharge every request.
 *
 * Each tier must pass `isUsableCost` in its own right. That matters more
 * here than for a base quote: a tier quoting 0/0 would make every request
 * above the threshold free, turning the dearest requests into the cheapest.
 *
 * Rates a tier leaves out are inherited from `cost` rather than defaulted
 * generically — see `tierRatesFrom`.
 */
declare function contextTiersFrom(cost: ModelsDevCost, divisor: number): ContextTier[] | undefined;
/**
 * Turn a models.dev `api.json` payload into a lookup keyed by both
 * `provider/model` and the bare model id.
 *
 * models.dev quotes USD per **million** tokens; this converts to per-token
 * so every source in this package speaks the same unit.
 *
 * Long-context tiers are read from `cost.tiers`. The older
 * `context_over_200k` field is ignored: it is a redundant restatement of the
 * same numbers with the threshold baked into the key, and reading both would
 * risk quoting one model two thresholds. `cost.reasoning` becomes a
 * thinking-mode card where it means one — see `reasoningRatesFrom`.
 */
declare function parseModelsDev(json: ModelsDevResponse, options?: ParseModelsDevOptions): Map<string, PriceSchedule>;
//#endregion
//#region src/catalog/fallback.d.ts
/** When the bundled archive was last refreshed (YYYY-MM-DD). */
declare const SNAPSHOT_SYNCED_AT: string;
/**
 * The archive's last observation, as epoch ms. Anything a live source
 * reports is newer than this and must not be applied before it — see
 * `mergeLiveQuote`.
 */
declare const SNAPSHOT_SYNCED_AT_MS: number;
declare const FALLBACK: Record<string, PriceSchedule>;
declare const FAST_MULTIPLIERS: Array<[multiplier: number, baseIds: string[]]>;
declare const CONTEXT_TIER_MULTIPLIERS: Record<string, Array<[abovePromptTokens: number, multiplier: number]>>;
/**
 * `<id>-fast` -> the base id and its multiplier.
 *
 * Fast variants are derived when a model is *resolved*, not baked into the
 * table, for two reasons. The multiplier then applies to whatever the base
 * currently resolves to — including a live reprice — and it beats the
 * reseller quotes that litter these ids upstream: no vendor publishes a
 * first-party `-fast` model, so aggregators fill the gap with routers
 * marking the real rate up 20%.
 */
declare const FAST_BY_ID: Record<string, {
  base: string;
  multiplier: number;
}>;
/**
 * Attach the hand-maintained long-context tiers for `id`, if there are any and
 * the schedule does not already price by prompt size.
 *
 * Derived per period, so a model with price history gets a tier scaled from
 * each era's own card rather than from today's — and returned by identity when
 * there is nothing to add, which is every model but the handful listed above.
 */
declare function withDerivedContextTiers(id: string, schedule: PriceSchedule): PriceSchedule;
//#endregion
//#region src/resolve.d.ts
/**
 * `claude-opus-4-7` -> `claude-opus-4.7`. The lookahead keeps the regex from
 * chewing through 8-digit date suffixes.
 */
declare function dotted(s: string): string;
/**
 * The inverse: `anthropic/claude-opus-4.7` -> `claude-opus-4-7`. Catalogue
 * ids use dots, so a caller who passes one straight through would otherwise
 * miss every dash-keyed table (the snapshot included) and silently price
 * at $0.
 */
declare function undotted(s: string): string;
declare function pricingCandidates(model: string): string[];
//#endregion
export { ratesFor as A, PricePeriod as B, contextTierFor as C, periodAt as D, peakMsBetween as E, HOUR_MS as F, RateKey as G, PriceSource as H, ModelPrice as I, Rates as K, NormalizedSchedule as L, ContextTier as M, CostEstimate as N, pricesByRequest as O, DAY_MS as P, PeakWindows as R, blendRates as S, isTimeSensitive as T, RATE_KEYS as U, PriceSchedule as V, RateCard as W, parseModelsDev as _, FALLBACK as a, RequestFacts as b, SNAPSHOT_SYNCED_AT as c, DEFAULT_PROVIDER_PRIORITY as d, MODELS_DEV_URL as f, contextTiersFrom as g, ParseModelsDevOptions as h, CONTEXT_TIER_MULTIPLIERS as i, toMs as j, ratesAt as k, SNAPSHOT_SYNCED_AT_MS as l, ModelsDevTier as m, pricingCandidates as n, FAST_BY_ID as o, ModelsDevResponse as p, TimeInput as q, undotted as r, FAST_MULTIPLIERS as s, dotted as t, withDerivedContextTiers as u, ratesFromCost as v, isPeakHour as w, blendParts as x, tierRatesFrom as y, PriceBasis as z };