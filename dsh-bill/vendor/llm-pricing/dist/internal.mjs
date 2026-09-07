import { A as FAST_BY_ID, B as scaleRates, C as pricesByRequest, D as OVERRIDES, E as toMs, F as closeEnough, H as weightedRates, I as flatSchedule, L as mergeLiveQuote, O as CONTEXT_TIER_MULTIPLIERS, P as withDerivedContextTiers, R as periodPricesEqual, S as periodAt, T as ratesFor, U as DAY_MS, V as scaleSchedule, W as HOUR_MS, _ as blendRates, a as contextTiersFrom, b as isTimeSensitive, c as ratesFromCost, d as dotted, g as blendParts, i as MODELS_DEV_URL, j as FAST_MULTIPLIERS, k as FALLBACK, l as reasoningRatesFrom, m as normalizeSchedule, n as parseOpenRouterModels, o as isUsableCost, p as undotted, r as DEFAULT_PROVIDER_PRIORITY, s as parseModelsDev, t as OPENROUTER_MODELS_URL, u as tierRatesFrom, v as contextTierFor, w as ratesAt, x as peakMsBetween, y as isPeakHour, z as ratesEqual } from "./openrouter-DTNSwOUG.mjs";
//#region src/catalog/sync.ts
/**
* Rates count as unchanged within `closeEnough`'s relative epsilon, rather
* than exactly. The archive is append-only, so a spurious reprice is
* permanent, and the snapshot already holds figures like
* `0.010000000000000002` — an exact comparison would turn that last-bit
* drift into a price-change record that never happened.
*/
function sameRates(a, b) {
	return a.length === b.length && a.every((value, i) => closeEnough(value, b[i]));
}
/**
* The rates a cost block archives as, per MTok — the four base numbers plus
* the long-context tiers, if any.
*
* Written in the same shape the on-disk tuple uses so the reprice comparison
* and the write path cannot drift: a tier that changed while the base rate
* held steady has to read as a reprice, or the archive keeps yesterday's
* long-context rate forever.
*/
function archivedRates(cost) {
	const base = ratesFromCost(cost, 1);
	return {
		base: flatten(base),
		tiers: (contextTiersFrom(cost, 1) ?? []).map(({ abovePromptTokens, rates }) => [abovePromptTokens, ...flatten(rates)]),
		reasoningOutput: reasoningRatesFrom(cost, base, 1)?.outputCostPerToken
	};
}
/**
* `Rates` in archive-tuple order — which is NOT the order `Rates` declares
* them in: cache *write* comes before cache read on disk. Written once so a
* base row and a tier row cannot encode it differently; getting it wrong in
* one of two places would silently swap the two cache prices, and
* `sameRates` compares the same two positions on both sides, so nothing
* would notice.
*/
function flatten(rates) {
	return [
		rates.inputCostPerToken,
		rates.cacheCreationInputCostPerToken,
		rates.cacheReadInputCostPerToken,
		rates.outputCostPerToken
	];
}
/** Flatten a period's rates for comparison, every dimension included. */
function comparable(period) {
	return [
		...period.slice(1, 5),
		...(period[5] ?? []).flat(),
		...period[6] === void 0 ? [] : [period[6]]
	];
}
/**
* Whether this observation only *adds* tiers to a period whose base rates
* are unchanged.
*
* This is not a reprice, and treating it as one does real damage. The tiers
* did not appear today — gpt-5.5 has had its 272k rate since launch; this
* package simply did not record tiers before. Appending a period dated today
* would assert that every earlier row was untiered, which is false, and it
* would hand 30-odd flat models a two-period history: they would start
* blending across the request window and demand an hour anchor, all to
* express a change that never happened.
*
* So the tiers are backfilled into the period instead — the same reasoning
* the archive already applies to a model's first observation, which opens at
* -infinity because "the model was priced this way before we started
* watching". Correcting only the *latest* period keeps that honest: it is the
* period the current quote is evidence about, and an earlier period's tier
* is not something today's quote can speak to.
*
* **Available only while the archive records no tiers at all** — see
* `archiveHasTiers`. This is the one-time cost of the archive learning a new
* dimension, not standing behaviour: once tiers are being recorded, a tier
* that appears is news, and backfilling it would assert a premium over
* history that nobody was charged.
*/
function isDimensionBackfill(previous, next) {
	if (!sameRates(previous.slice(1, 5), next.slice(1, 5))) return false;
	const gainedTiers = !previous[5] && !!next[5];
	const gainedReasoning = previous[6] === void 0 && next[6] !== void 0;
	const keptTiers = sameRates((previous[5] ?? []).flat(), (next[5] ?? []).flat());
	const keptReasoning = previous[6] === next[6];
	return (gainedTiers || gainedReasoning) && (gainedTiers || keptTiers) && (gainedReasoning || keptReasoning);
}
/**
* Whether the archive already records long-context tiers for anything.
*
* Decides whether a newly-seen tier reads as a gap being filled or as a
* vendor introducing a premium — the two are indistinguishable in the data,
* so the archive's own state is what separates them.
*/
function archiveRecords(models, slot) {
	return Object.values(models).some((entry) => entry[1].some((period) => period[slot] !== void 0));
}
function mergeSnapshot(previous, api, providers, today) {
	const models = { ...previous };
	const seen = /* @__PURE__ */ new Set();
	let added = 0;
	let repriced = 0;
	let backfilled = 0;
	const mayBackfill = {
		5: !archiveRecords(previous, 5),
		6: !archiveRecords(previous, 6)
	};
	for (const provider of providers) for (const [id, model] of Object.entries(api[provider]?.models ?? {})) {
		const cost = model?.cost;
		if (!isUsableCost(cost)) continue;
		const key = id.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		const { base, tiers, reasoningOutput } = archivedRates(cost);
		const period = reasoningOutput === void 0 ? tiers.length > 0 ? [
			null,
			...base,
			tiers
		] : [null, ...base] : [
			null,
			...base,
			tiers.length > 0 ? tiers : null,
			reasoningOutput
		];
		const displayName = typeof model.name === "string" ? model.name : id;
		const before = models[key];
		if (!before) {
			models[key] = [displayName, [period]];
			added++;
			continue;
		}
		const periods = before[1];
		const latest = periods.at(-1);
		if (sameRates(comparable(latest), comparable(period))) {
			models[key] = [displayName, periods];
			continue;
		}
		if ((!latest[5] && !!period[5] && mayBackfill[5] || latest[6] === void 0 && period[6] !== void 0 && mayBackfill[6]) && isDimensionBackfill(latest, period)) {
			const corrected = [latest[0], ...period.slice(1)];
			models[key] = [displayName, [...periods.slice(0, -1), corrected]];
			backfilled++;
			continue;
		}
		const dated = [today, ...period.slice(1)];
		models[key] = [displayName, latest[0] === today ? [...periods.slice(0, -1), dated] : [...periods, dated]];
		repriced++;
	}
	return {
		models,
		added,
		repriced,
		backfilled,
		retained: Object.keys(models).filter((key) => !seen.has(key))
	};
}
//#endregion
export { CONTEXT_TIER_MULTIPLIERS, DAY_MS, DEFAULT_PROVIDER_PRIORITY, FALLBACK, FAST_BY_ID, FAST_MULTIPLIERS, HOUR_MS, MODELS_DEV_URL, OPENROUTER_MODELS_URL, OVERRIDES, blendParts, blendRates, contextTierFor, contextTiersFrom, dotted, flatSchedule, isPeakHour, isTimeSensitive, mergeLiveQuote, mergeSnapshot, normalizeSchedule, parseModelsDev, parseOpenRouterModels, peakMsBetween, periodAt, periodPricesEqual, pricesByRequest, ratesAt, ratesEqual, ratesFor, ratesFromCost, scaleRates, scaleSchedule, tierRatesFrom, toMs, undotted, weightedRates, withDerivedContextTiers };
