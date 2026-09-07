import { A as ratesFor, B as PricePeriod, C as contextTierFor, D as periodAt, E as peakMsBetween, F as HOUR_MS, K as Rates, L as NormalizedSchedule, O as pricesByRequest, P as DAY_MS, S as blendRates, T as isTimeSensitive, V as PriceSchedule, _ as parseModelsDev, a as FALLBACK, d as DEFAULT_PROVIDER_PRIORITY, f as MODELS_DEV_URL, g as contextTiersFrom, i as CONTEXT_TIER_MULTIPLIERS, j as toMs, k as ratesAt, m as ModelsDevTier, o as FAST_BY_ID, p as ModelsDevResponse, r as undotted, s as FAST_MULTIPLIERS, t as dotted, u as withDerivedContextTiers, v as ratesFromCost, w as isPeakHour, x as blendParts, y as tierRatesFrom } from "./resolve-CZuloOeh.mjs";
//#region src/rates.d.ts
declare function scaleRates(rates: Rates, multiplier: number): Rates;
declare function weightedRates(parts: Array<{
  rates: Rates;
  weight: number;
}>): Rates;
/**
 * A single timeless rate card, expressed as a one-period schedule.
 *
 * `cacheCreation` defaults to the cached-read rate — correct for vendors
 * that do not price cache writes separately, and the historical behaviour
 * of this table. Pass it explicitly for Anthropic-style pricing where a
 * cache write costs ~1.25x input.
 */
declare function flatSchedule(displayName: string, input: number, cachedRead: number, output: number, cacheCreation?: number, source?: PriceSchedule['source']): PriceSchedule;
/** Whether two rate cards quote the same price. See `closeEnough`. */
declare function ratesEqual(a: Rates, b: Rates): boolean;
/**
 * Whether two periods quote the same price in every dimension — base card
 * and long-context tiers alike.
 *
 * `ratesEqual` alone is what `mergeLiveQuote` used to compare, and it cannot
 * see a reprice that only moved the tier: a model whose base rate holds
 * steady while its >272k rate doubles would read as "unchanged" and keep the
 * old tier forever. Peak is deliberately not compared — `mergeLiveQuote`
 * refuses to touch a peak schedule at all, so it never gets this far.
 */
declare function periodPricesEqual(a: PricePeriod, b: PricePeriod): boolean;
/**
 * Apply a live catalogue quote on top of an archived price history.
 *
 * Every upstream catalogue publishes one number per model: what it costs
 * right now. Taking that at face value re-prices history — a vendor raising a
 * rate silently inflates last month's bill. So the live quote is grafted on
 * as the newest period instead of replacing the schedule, leaving older
 * periods on the rates the archive recorded for them.
 *
 * `observedFromMs` is the moment the archive was last known to be accurate
 * (its sync date). The real change happened somewhere between then and now;
 * dating it at the sync is the conservative end of that interval, and it is
 * the only end we have evidence for.
 */
declare function mergeLiveQuote(archive: PriceSchedule | null, live: PriceSchedule, observedFromMs: number, sqlMatch?: string[]): PriceSchedule;
/**
 * Scale every period of a schedule, peak included, so a derived variant
 * (e.g. a fast tier) keeps its schedule instead of flattening.
 */
declare function scaleSchedule(base: PriceSchedule, multiplier: number, displayNameSuffix?: string): PriceSchedule;
//#endregion
//#region src/catalog/openrouter.d.ts
declare const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
interface OpenRouterModelsResponse {
  data?: Array<Record<string, unknown>>;
}
declare function parseOpenRouterModels(json: OpenRouterModelsResponse): Map<string, PriceSchedule>;
//#endregion
//#region src/catalog/overrides.d.ts
declare const OVERRIDES: Record<string, PriceSchedule>;
//#endregion
//#region src/catalog/sync.d.ts
/**
 * The merge behind `pnpm sync`, separated from the script so it can be
 * tested without a network call.
 *
 * This builds an ARCHIVE, not a table. models.dev — like OpenRouter,
 * LiteLLM and ccusage — publishes one number per model: whatever it costs
 * today. Applied naively that re-prices history, so a vendor raising a rate
 * silently inflates last month's bill. Each sync therefore *appends* a
 * period dated today rather than overwriting.
 *
 * Append-only in both directions: a model that disappears upstream keeps
 * its whole history, because stored model strings are immortal and a row
 * that silently prices at $0 is worse than one on a stale rate.
 */
/**
 * The on-disk archive format, shared with the reader in `fallback.ts` so the
 * two cannot disagree about the tuple's arity or order. `$/MTok`.
 *
 * The trailing elements are optional and positional, so every period written
 * before a dimension existed still reads correctly: a 5-element row means "no
 * tier, no thinking rate", which is what those models were archived as. A
 * model with a thinking rate but no tiers writes `null` in the tier slot,
 * because the slots cannot be reordered without rewriting history.
 */
type SnapshotTier = [abovePromptTokens: number, input: number, cacheWrite: number, cacheRead: number, output: number];
type SnapshotPeriod = [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number] | [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number, tiers: SnapshotTier[] | null] | [from: string | null, input: number, cacheWrite: number, cacheRead: number, output: number, tiers: SnapshotTier[] | null, reasoningOutput: number];
type SnapshotEntry = [displayName: string, periods: SnapshotPeriod[]];
type SnapshotModels = Record<string, SnapshotEntry>;
interface SyncResult {
  models: SnapshotModels;
  added: number;
  repriced: number;
  /**
   * Models whose latest period gained a dimension — long-context tiers or a
   * thinking-mode rate — without any change to the rates already recorded.
   * New *information*, corrected in place rather than appended. See
   * `isDimensionBackfill`.
   */
  backfilled: number;
  /** Present in the archive, no longer listed upstream. Kept. */
  retained: string[];
}
declare function mergeSnapshot(previous: SnapshotModels, api: ModelsDevResponse, providers: readonly string[], today: string): SyncResult;
//#endregion
//#region src/normalize.d.ts
/**
 * Bring a schedule to the shape the pricing primitives assume, or reject it.
 *
 * Schedules arrive from three places — the bundled tables, a parsed remote
 * catalogue, and whatever a caller passes as `overrides`/`fallback` — and
 * only the first is under this package's control. The primitives are hot
 * (`periodAt` runs per priced row) so they check nothing; this runs once,
 * at ingest, and is where the assumptions get enforced.
 *
 * Returns null for a schedule that cannot price anything, so the caller can
 * drop it rather than throw on the first lookup.
 */
declare function normalizeSchedule(schedule: PriceSchedule, onWarn?: (message: string, error: unknown) => void, id?: string): NormalizedSchedule | null;
//#endregion
export { CONTEXT_TIER_MULTIPLIERS, DAY_MS, DEFAULT_PROVIDER_PRIORITY, FALLBACK, FAST_BY_ID, FAST_MULTIPLIERS, HOUR_MS, MODELS_DEV_URL, type ModelsDevResponse, type ModelsDevTier, OPENROUTER_MODELS_URL, OVERRIDES, type OpenRouterModelsResponse, type SnapshotEntry, type SnapshotModels, type SnapshotPeriod, type SnapshotTier, type SyncResult, blendParts, blendRates, contextTierFor, contextTiersFrom, dotted, flatSchedule, isPeakHour, isTimeSensitive, mergeLiveQuote, mergeSnapshot, normalizeSchedule, parseModelsDev, parseOpenRouterModels, peakMsBetween, periodAt, periodPricesEqual, pricesByRequest, ratesAt, ratesEqual, ratesFor, ratesFromCost, scaleRates, scaleSchedule, tierRatesFrom, toMs, undotted, weightedRates, withDerivedContextTiers };