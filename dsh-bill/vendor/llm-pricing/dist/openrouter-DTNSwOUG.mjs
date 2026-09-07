//#region src/types.ts
const RATE_KEYS = [
	"inputCostPerToken",
	"cacheCreationInputCostPerToken",
	"cacheReadInputCostPerToken",
	"cachedInputCostPerToken",
	"outputCostPerToken"
];
const HOUR_MS = 36e5;
const DAY_MS = 24 * HOUR_MS;
//#endregion
//#region src/rates.ts
function scaleRates(rates, multiplier) {
	const out = {};
	for (const key of RATE_KEYS) out[key] = rates[key] * multiplier;
	return out;
}
function weightedRates(parts) {
	let total = 0;
	for (const part of parts) total += part.weight;
	if (total <= 0) return parts[0].rates;
	const out = {};
	for (const key of RATE_KEYS) {
		let acc = 0;
		for (const { rates, weight } of parts) acc += rates[key] * (weight / total);
		out[key] = acc;
	}
	return out;
}
/**
* A single timeless rate card, expressed as a one-period schedule.
*
* `cacheCreation` defaults to the cached-read rate — correct for vendors
* that do not price cache writes separately, and the historical behaviour
* of this table. Pass it explicitly for Anthropic-style pricing where a
* cache write costs ~1.25x input.
*/
function flatSchedule(displayName, input, cachedRead, output, cacheCreation = cachedRead, source = "fallback") {
	return {
		displayName,
		source,
		periods: [{
			from: Number.NEGATIVE_INFINITY,
			rates: {
				inputCostPerToken: input,
				cacheCreationInputCostPerToken: cacheCreation,
				cacheReadInputCostPerToken: cachedRead,
				cachedInputCostPerToken: cachedRead,
				outputCostPerToken: output
			}
		}]
	};
}
/**
* Whether two prices are the same price, within the rounding noise of a unit
* conversion (per-MTok archives vs per-token catalogue strings) and of the
* `input * 0.1` cache-rate default, which drifts in its last bits.
*
* Relative, not absolute: rates span from 1e-8 to 1e-4 per token, so any
* fixed tolerance is either meaningless at the top or blind at the bottom.
*/
function closeEnough(a, b) {
	return Math.abs(a - b) <= Math.max(Math.abs(a), Math.abs(b)) * 1e-9;
}
/** Whether two rate cards quote the same price. See `closeEnough`. */
function ratesEqual(a, b) {
	return RATE_KEYS.every((key) => closeEnough(a[key], b[key]));
}
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
function periodPricesEqual(a, b) {
	if (!cardsEqual(a, b)) return false;
	const at = a.contextTiers ?? [];
	const bt = b.contextTiers ?? [];
	return at.length === bt.length && at.every((tier, i) => tier.abovePromptTokens === bt[i].abovePromptTokens && cardsEqual(tier, bt[i]));
}
/**
* Whether two cards quote the same price, thinking-mode variant included.
*
* The variant has to be compared for the same reason the tiers do: a model
* whose base output rate holds steady while its thinking rate moves would read
* as unchanged and keep the old variant forever.
*/
function cardsEqual(a, b) {
	if (!ratesEqual(a.rates, b.rates)) return false;
	if (!a.reasoningRates || !b.reasoningRates) return a.reasoningRates === void 0 && b.reasoningRates === void 0;
	return ratesEqual(a.reasoningRates, b.reasoningRates);
}
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
function mergeLiveQuote(archive, live, observedFromMs, sqlMatch) {
	if (!archive) return live;
	const latest = archive.periods.at(-1);
	if (latest.peak) return archive;
	const liveLatest = live.periods.at(-1);
	if (periodPricesEqual(latest, liveLatest)) return {
		...archive,
		displayName: live.displayName ?? archive.displayName,
		source: live.source,
		providerId: live.providerId
	};
	const grafted = {
		rates: liveLatest.rates,
		reasoningRates: liveLatest.reasoningRates,
		contextTiers: liveLatest.contextTiers
	};
	const periods = observedFromMs > latest.from ? [...archive.periods, {
		from: observedFromMs,
		...grafted
	}] : [...archive.periods.slice(0, -1), {
		from: latest.from,
		...grafted
	}];
	return {
		displayName: live.displayName ?? archive.displayName,
		source: live.source,
		providerId: live.providerId,
		periods,
		sqlMatch: periods.length > 1 ? archive.sqlMatch ?? sqlMatch : void 0
	};
}
/**
* Scale every period of a schedule, peak included, so a derived variant
* (e.g. a fast tier) keeps its schedule instead of flattening.
*/
function scaleSchedule(base, multiplier, displayNameSuffix) {
	return {
		displayName: base.displayName && displayNameSuffix ? `${base.displayName} ${displayNameSuffix}` : base.displayName,
		source: base.source,
		providerId: base.providerId,
		sqlMatch: base.sqlMatch,
		periods: base.periods.map((period) => ({
			from: period.from,
			rates: scaleRates(period.rates, multiplier),
			reasoningRates: period.reasoningRates && scaleRates(period.reasoningRates, multiplier),
			peak: period.peak ? {
				...period.peak,
				rates: scaleRates(period.peak.rates, multiplier)
			} : void 0,
			contextTiers: period.contextTiers?.map((tier) => ({
				abovePromptTokens: tier.abovePromptTokens,
				rates: scaleRates(tier.rates, multiplier),
				reasoningRates: tier.reasoningRates && scaleRates(tier.reasoningRates, multiplier)
			}))
		}))
	};
}
//#endregion
//#region src/catalog/snapshot.json
var syncedAt = "2026-08-17";
//#endregion
//#region src/catalog/fallback.ts
const SNAPSHOT_MODELS = {
	"amazon.nova-2-lite-v1:0": ["Nova 2 Lite", [[
		null,
		.33,
		.033,
		.033,
		2.75
	]]],
	"amazon.nova-lite-v1:0": ["Nova Lite", [[
		null,
		.06,
		.015,
		.015,
		.24
	]]],
	"amazon.nova-micro-v1:0": ["Nova Micro", [[
		null,
		.035,
		.00875,
		.00875,
		.14
	]]],
	"amazon.nova-pro-v1:0": ["Nova Pro", [[
		null,
		.8,
		.2,
		.2,
		3.2
	]]],
	"anthropic.claude-fable-5": ["Claude Fable 5", [[
		null,
		10,
		12.5,
		1,
		50
	]]],
	"anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"anthropic.claude-opus-4-1-20250805-v1:0": ["Claude Opus 4.1", [[
		null,
		15,
		18.75,
		1.5,
		75
	]]],
	"anthropic.claude-opus-4-5-20251101-v1:0": ["Claude Opus 4.5", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"anthropic.claude-opus-4-6-v1": ["Claude Opus 4.6", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"anthropic.claude-opus-4-7": ["Claude Opus 4.7", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"anthropic.claude-opus-4-8": ["Claude Opus 4.8", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"anthropic.claude-opus-5": ["Claude Opus 5", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"anthropic.claude-sonnet-4-5-20250929-v1:0": ["Claude Sonnet 4.5", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"anthropic.claude-sonnet-4-6": ["Claude Sonnet 4.6", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"anthropic.claude-sonnet-5": ["Claude Sonnet 5", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"au.anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5 (AU)", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"au.anthropic.claude-opus-4-6-v1": ["AU Anthropic Claude Opus 4.6", [[
		null,
		16.5,
		20.625,
		1.65,
		82.5
	]]],
	"au.anthropic.claude-opus-4-8": ["Claude Opus 4.8 (AU)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"au.anthropic.claude-opus-5": ["Claude Opus 5 (AU)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"au.anthropic.claude-sonnet-4-5-20250929-v1:0": ["Claude Sonnet 4.5 (AU)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"au.anthropic.claude-sonnet-4-6": ["AU Anthropic Claude Sonnet 4.6", [[
		null,
		3.3,
		4.125,
		.33,
		16.5
	]]],
	"au.anthropic.claude-sonnet-5": ["Claude Sonnet 5 (AU)", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"claude-fable-5": ["Claude Fable 5", [[
		null,
		10,
		12.5,
		1,
		50
	]]],
	"claude-haiku-4-5": ["Claude Haiku 4.5 (latest)", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"claude-haiku-4-5-20251001": ["Claude Haiku 4.5", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"claude-haiku-4-5@20251001": ["Claude Haiku 4.5", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"claude-mythos-5": ["Claude Mythos 5", [[
		null,
		10,
		12.5,
		1,
		50
	]]],
	"claude-opus-4-1": ["Claude Opus 4.1", [[
		null,
		15,
		18.75,
		1.5,
		75
	]]],
	"claude-opus-4-1@20250805": ["Claude Opus 4.1", [[
		null,
		15,
		18.75,
		1.5,
		75
	]]],
	"claude-opus-4-5": ["Claude Opus 4.5 (latest)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-4-5-20251101": ["Claude Opus 4.5", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-4-5@20251101": ["Claude Opus 4.5", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-4-6": ["Claude Opus 4.6", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-4-6@default": ["Claude Opus 4.6", [[
		null,
		5,
		6.25,
		.5,
		25,
		[[
			2e5,
			10,
			12.5,
			1,
			37.5
		]]
	]]],
	"claude-opus-4-7": ["Claude Opus 4.7", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-4-7@default": ["Claude Opus 4.7", [[
		null,
		5,
		6.25,
		.5,
		25,
		[[
			2e5,
			10,
			12.5,
			1,
			37.5
		]]
	]]],
	"claude-opus-4-8": ["Claude Opus 4.8", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-4-8@default": ["Claude Opus 4.8", [[
		null,
		5,
		6.25,
		.5,
		25,
		[[
			2e5,
			10,
			12.5,
			1,
			37.5
		]]
	]]],
	"claude-opus-4@20250514": ["Claude Opus 4", [[
		null,
		15,
		18.75,
		1.5,
		75
	]]],
	"claude-opus-5": ["Claude Opus 5", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-opus-5@default": ["Claude Opus 5", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"claude-sonnet-4-5": ["Claude Sonnet 4.5 (latest)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"claude-sonnet-4-5-20250929": ["Claude Sonnet 4.5", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"claude-sonnet-4-5@20250929": ["Claude Sonnet 4.5", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"claude-sonnet-4-6": ["Claude Sonnet 4.6", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"claude-sonnet-4-6@default": ["Claude Sonnet 4.6", [[
		null,
		3,
		3.75,
		.3,
		15,
		[[
			2e5,
			6,
			7.5,
			.6,
			22.5
		]]
	]]],
	"claude-sonnet-4@20250514": ["Claude Sonnet 4", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"claude-sonnet-5": ["Claude Sonnet 5", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"claude-sonnet-5@default": ["Claude Sonnet 5", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"codestral-2501": ["Codestral 25.01", [[
		null,
		.3,
		.03,
		.03,
		.9
	]]],
	"codestral-latest": ["Codestral (latest)", [[
		null,
		.3,
		.03,
		.03,
		.9
	]]],
	"codex-mini": ["Codex Mini", [[
		null,
		1.5,
		.375,
		.375,
		6
	]]],
	"cohere-command-a": ["Command A", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"cohere-embed-v-4-0": ["Embed v4", [[
		null,
		.12,
		.012,
		.012,
		0
	]]],
	"cohere-embed-v3-english": ["Embed v3 English", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		0
	]]],
	"cohere-embed-v3-multilingual": ["Embed v3 Multilingual", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		0
	]]],
	"command-a-03-2025": ["Command A", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"command-a-plus-05-2026": ["Command A Plus", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"command-a-reasoning-08-2025": ["Command A Reasoning", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"command-a-translate-08-2025": ["Command A Translate", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"command-a-vision-07-2025": ["Command A Vision", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"command-r-08-2024": ["Command R", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"command-r-plus-08-2024": ["Command R+", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"command-r7b-12-2024": ["Command R7B", [[
		null,
		.0375,
		.00375,
		.00375,
		.15
	]]],
	"command-r7b-arabic-02-2025": ["Command R7B Arabic", [[
		null,
		.0375,
		.00375,
		.00375,
		.15
	]]],
	"deep-research-max-preview-04-2026": ["Deep Research Max Preview (Apr-21-2026)", [[
		null,
		2,
		.2,
		.2,
		12,
		[[
			2e5,
			4,
			.4,
			.4,
			18
		]]
	]]],
	"deep-research-preview-04-2026": ["Deep Research Preview (Apr-21-2026)", [[
		null,
		2,
		.2,
		.2,
		12,
		[[
			2e5,
			4,
			.4,
			.4,
			18
		]]
	]]],
	"deepseek-ai/deepseek-v3.1-maas": ["DeepSeek V3.1", [[
		null,
		.6,
		.06,
		.06,
		1.7
	]]],
	"deepseek-ai/deepseek-v3.2-maas": ["DeepSeek V3.2", [[
		null,
		.56,
		.056,
		.056,
		1.68
	]]],
	"deepseek-chat": ["DeepSeek Chat", [[
		null,
		.14,
		.0028,
		.0028,
		.28
	]]],
	"deepseek-r1": ["DeepSeek-R1", [[
		null,
		1.35,
		.135,
		.135,
		5.4
	]]],
	"deepseek-reasoner": ["DeepSeek Reasoner", [[
		null,
		.14,
		.0028,
		.0028,
		.28
	]]],
	"deepseek-v3.2": ["DeepSeek-V3.2", [[
		null,
		.58,
		.057999999999999996,
		.057999999999999996,
		1.68
	]]],
	"deepseek-v3.2-speciale": ["DeepSeek-V3.2-Speciale", [[
		null,
		.58,
		.057999999999999996,
		.057999999999999996,
		1.68
	]]],
	"deepseek-v4-flash": ["DeepSeek V4 Flash", [[
		null,
		.14,
		.0028,
		.0028,
		.28
	]]],
	"deepseek-v4-flash-0731": ["DeepSeek V4 Flash 0731", [[
		null,
		.2,
		.04,
		.04,
		.4
	]]],
	"deepseek-v4-pro": ["DeepSeek V4 Pro", [[
		null,
		.435,
		.003625,
		.003625,
		.87
	]]],
	"deepseek.r1-v1:0": ["DeepSeek-R1", [[
		null,
		1.35,
		.135,
		.135,
		5.4
	]]],
	"deepseek.v3-v1:0": ["DeepSeek-V3.1", [[
		null,
		.58,
		.057999999999999996,
		.057999999999999996,
		1.68
	]]],
	"deepseek.v3.2": ["DeepSeek-V3.2", [[
		null,
		.62,
		.062,
		.062,
		1.85
	]]],
	"devstral-2512": ["Devstral 2", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"devstral-latest": ["Devstral 2", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"devstral-medium-2507": ["Devstral Medium", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"devstral-medium-latest": ["Devstral 2 (latest)", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"devstral-small-2505": ["Devstral Small 2505", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.3
	]]],
	"devstral-small-2507": ["Devstral Small", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.3
	]]],
	"eu.anthropic.claude-fable-5": ["Claude Fable 5 (EU)", [[
		null,
		11,
		13.75,
		1.1,
		55
	]]],
	"eu.anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5 (EU)", [[
		null,
		1.1,
		1.375,
		.11,
		5.5
	]]],
	"eu.anthropic.claude-opus-4-5-20251101-v1:0": ["Claude Opus 4.5 (EU)", [[
		null,
		5.5,
		6.875,
		.55,
		27.5
	]]],
	"eu.anthropic.claude-opus-4-6-v1": ["Claude Opus 4.6 (EU)", [[
		null,
		5.5,
		6.875,
		.55,
		27.5
	]]],
	"eu.anthropic.claude-opus-4-7": ["Claude Opus 4.7 (EU)", [[
		null,
		5.5,
		6.875,
		.55,
		27.5
	]]],
	"eu.anthropic.claude-opus-4-8": ["Claude Opus 4.8 (EU)", [[
		null,
		5.5,
		6.875,
		.55,
		27.5
	]]],
	"eu.anthropic.claude-opus-5": ["Claude Opus 5 (EU)", [[
		null,
		5.5,
		6.875,
		.55,
		27.5
	]]],
	"eu.anthropic.claude-sonnet-4-5-20250929-v1:0": ["Claude Sonnet 4.5 (EU)", [[
		null,
		3.3,
		4.125,
		.33,
		16.5
	]]],
	"eu.anthropic.claude-sonnet-4-6": ["Claude Sonnet 4.6 (EU)", [[
		null,
		3.3,
		4.125,
		.33,
		16.5
	]]],
	"eu.anthropic.claude-sonnet-5": ["Claude Sonnet 5 (EU)", [[
		null,
		2.2,
		2.75,
		.22,
		11
	]]],
	"gemini-2.5-computer-use-preview-10-2025": ["Gemini 2.5 Computer Use Preview 10-2025", [[
		null,
		1.25,
		.125,
		.125,
		10,
		[[
			2e5,
			2.5,
			.25,
			.25,
			15
		]]
	]]],
	"gemini-2.5-flash": ["Gemini 2.5 Flash", [[
		null,
		.3,
		.03,
		.03,
		2.5
	]]],
	"gemini-2.5-flash-image": ["Nano Banana", [[
		null,
		.3,
		.075,
		.075,
		30
	]]],
	"gemini-2.5-flash-lite": ["Gemini 2.5 Flash-Lite", [[
		null,
		.1,
		.01,
		.01,
		.4
	]]],
	"gemini-2.5-flash-preview-tts": ["Gemini 2.5 Flash Preview TTS", [[
		null,
		.5,
		.05,
		.05,
		10
	]]],
	"gemini-2.5-flash-tts": ["Gemini 2.5 Flash TTS", [[
		null,
		.5,
		.05,
		.05,
		10
	]]],
	"gemini-2.5-pro": ["Gemini 2.5 Pro", [[
		null,
		1.25,
		.125,
		.125,
		10,
		[[
			2e5,
			2.5,
			.25,
			.25,
			15
		]]
	]]],
	"gemini-2.5-pro-preview-tts": ["Gemini 2.5 Pro Preview TTS", [[
		null,
		1,
		.1,
		.1,
		20
	]]],
	"gemini-2.5-pro-tts": ["Gemini 2.5 Pro TTS", [[
		null,
		1,
		.1,
		.1,
		20
	]]],
	"gemini-3-flash-preview": ["Gemini 3 Flash Preview", [[
		null,
		.5,
		.05,
		.05,
		3
	]]],
	"gemini-3-pro-image": ["Nano Banana Pro", [[
		null,
		2,
		.2,
		.2,
		120
	]]],
	"gemini-3-pro-image-preview": ["Nano Banana Pro", [[
		null,
		2,
		.2,
		.2,
		120
	]]],
	"gemini-3.1-flash-image": ["Nano Banana 2", [[
		null,
		.5,
		.05,
		.05,
		60
	]]],
	"gemini-3.1-flash-image-preview": ["Nano Banana 2", [[
		null,
		.5,
		.05,
		.05,
		60
	]]],
	"gemini-3.1-flash-lite": ["Gemini 3.1 Flash Lite", [[
		null,
		.25,
		.025,
		.025,
		1.5
	]]],
	"gemini-3.1-flash-lite-image": ["Nano Banana 2 Lite", [[
		null,
		.25,
		.025,
		.025,
		30
	]]],
	"gemini-3.1-flash-lite-preview": ["Gemini 3.1 Flash Lite Preview", [[
		null,
		.25,
		.025,
		.025,
		1.5
	]]],
	"gemini-3.1-flash-live-preview": ["Gemini 3.1 Flash Live Preview", [[
		null,
		.75,
		.07500000000000001,
		.07500000000000001,
		4.5
	]]],
	"gemini-3.1-flash-tts-preview": ["Gemini 3.1 Flash TTS Preview", [[
		null,
		1,
		.1,
		.1,
		20
	]]],
	"gemini-3.1-pro-preview": ["Gemini 3.1 Pro Preview", [[
		null,
		2,
		.2,
		.2,
		12,
		[[
			2e5,
			4,
			.4,
			.4,
			18
		]]
	]]],
	"gemini-3.1-pro-preview-customtools": ["Gemini 3.1 Pro Preview Custom Tools", [[
		null,
		2,
		.2,
		.2,
		12,
		[[
			2e5,
			4,
			.4,
			.4,
			18
		]]
	]]],
	"gemini-3.5-flash": ["Gemini 3.5 Flash", [[
		null,
		1.5,
		.15,
		.15,
		9
	]]],
	"gemini-3.5-flash-lite": ["Gemini 3.5 Flash Lite", [[
		null,
		.3,
		.03,
		.03,
		2.5
	]]],
	"gemini-3.5-live-translate-preview": ["Gemini 3.5 Live Translate Preview", [[
		null,
		3.5,
		.35000000000000003,
		.35000000000000003,
		21
	]]],
	"gemini-3.6-flash": ["Gemini 3.6 Flash", [[
		null,
		1.5,
		.15,
		.15,
		7.5
	]]],
	"gemini-3.7-flash": ["Gemini 3.7 Flash", [[
		null,
		.75,
		.075,
		.075,
		3.75
	]]],
	"gemini-embedding-001": ["Gemini Embedding 001", [[
		null,
		.15,
		.015,
		.015,
		0
	]]],
	"gemini-embedding-2": ["Gemini Embedding 2", [[
		null,
		.2,
		.020000000000000004,
		.020000000000000004,
		0
	]]],
	"gemini-flash-latest": ["Gemini Flash Latest", [[
		null,
		1.5,
		.15,
		.15,
		9
	]]],
	"gemini-flash-lite-latest": ["Gemini Flash-Lite Latest", [[
		null,
		.25,
		.025,
		.025,
		1.5
	]]],
	"gemini-omni-flash-preview": ["Gemini Omni Flash Preview", [[
		null,
		1.5,
		.15000000000000002,
		.15000000000000002,
		17.5
	]]],
	"gemini-robotics-er-1.6-preview": ["Gemini Robotics-ER 1.6 Preview", [[
		null,
		1,
		.1,
		.1,
		5
	]]],
	"glm-4.5": ["GLM-4.5", [[
		null,
		.6,
		0,
		.11,
		2.2
	]]],
	"glm-4.5-air": ["GLM-4.5-Air", [[
		null,
		.2,
		0,
		.03,
		1.1
	]]],
	"glm-4.5v": ["GLM-4.5V", [[
		null,
		.6,
		.06,
		.06,
		1.8
	]]],
	"glm-4.6": ["GLM-4.6", [[
		null,
		.6,
		0,
		.11,
		2.2
	]]],
	"glm-4.6v": ["GLM-4.6V", [[
		null,
		.3,
		.03,
		.03,
		.9
	]]],
	"glm-4.7": ["GLM-4.7", [[
		null,
		.6,
		0,
		.11,
		2.2
	]]],
	"glm-4.7-flashx": ["GLM-4.7-FlashX", [[
		null,
		.07,
		0,
		.01,
		.4
	]]],
	"glm-5": ["GLM-5", [[
		null,
		1,
		0,
		.2,
		3.2
	]]],
	"glm-5-turbo": ["GLM-5-Turbo", [[
		null,
		1.2,
		0,
		.24,
		4
	]]],
	"glm-5.1": ["GLM-5.1", [[
		null,
		1.4,
		0,
		.26,
		4.4
	]]],
	"glm-5.2": ["GLM-5.2", [[
		null,
		1.4,
		0,
		.28,
		4.4
	]]],
	"glm-5v-turbo": ["GLM-5V-Turbo", [[
		null,
		1.2,
		0,
		.24,
		4
	]]],
	"global.anthropic.claude-fable-5": ["Claude Fable 5 (Global)", [[
		null,
		10,
		12.5,
		1,
		50
	]]],
	"global.anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5 (Global)", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"global.anthropic.claude-opus-4-5-20251101-v1:0": ["Claude Opus 4.5 (Global)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"global.anthropic.claude-opus-4-6-v1": ["Claude Opus 4.6 (Global)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"global.anthropic.claude-opus-4-7": ["Claude Opus 4.7 (Global)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"global.anthropic.claude-opus-4-8": ["Claude Opus 4.8 (Global)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"global.anthropic.claude-opus-5": ["Claude Opus 5 (Global)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"global.anthropic.claude-sonnet-4-5-20250929-v1:0": ["Claude Sonnet 4.5 (Global)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"global.anthropic.claude-sonnet-4-6": ["Claude Sonnet 4.6 (Global)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"global.anthropic.claude-sonnet-5": ["Claude Sonnet 5 (Global)", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"global.openai.gpt-5.6-luna": ["GPT-5.6 Luna (Global)", [[
		null,
		.22,
		.275,
		.022,
		1.32,
		[[
			272e3,
			.44,
			.55,
			.044,
			1.98
		]]
	]]],
	"global.openai.gpt-5.6-sol": ["GPT-5.6 Sol (Global)", [[
		null,
		5.5,
		6.875,
		.55,
		33,
		[[
			272e3,
			11,
			13.75,
			1.1,
			49.5
		]]
	]]],
	"global.openai.gpt-5.6-terra": ["GPT-5.6 Terra (Global)", [[
		null,
		2.2,
		2.75,
		.22,
		13.2,
		[[
			272e3,
			4.4,
			5.5,
			.44,
			19.8
		]]
	]]],
	"google.gemma-3-12b-it": ["Google Gemma 3 12B", [[
		null,
		.049999999999999996,
		.005,
		.005,
		.09999999999999999
	]]],
	"google.gemma-3-27b-it": ["Google Gemma 3 27B Instruct", [[
		null,
		.12,
		.012,
		.012,
		.2
	]]],
	"google.gemma-3-4b-it": ["Gemma 3 4B IT", [[
		null,
		.04,
		.004,
		.004,
		.08
	]]],
	"gpt-3.5-turbo": ["GPT-3.5-turbo", [[
		null,
		.5,
		0,
		0,
		1.5
	]]],
	"gpt-3.5-turbo-0125": ["GPT-3.5 Turbo 0125", [[
		null,
		.5,
		.05,
		.05,
		1.5
	]]],
	"gpt-3.5-turbo-1106": ["GPT-3.5 Turbo 1106", [[
		null,
		1,
		.1,
		.1,
		2
	]]],
	"gpt-3.5-turbo-instruct": ["GPT-3.5 Turbo Instruct", [[
		null,
		1.5,
		.15000000000000002,
		.15000000000000002,
		2
	]]],
	"gpt-4": ["GPT-4", [[
		null,
		30,
		3,
		3,
		60
	]]],
	"gpt-4-turbo": ["GPT-4 Turbo", [[
		null,
		10,
		1,
		1,
		30
	]]],
	"gpt-4-turbo-vision": ["GPT-4 Turbo Vision", [[
		null,
		10,
		1,
		1,
		30
	]]],
	"gpt-4.1": ["GPT-4.1", [[
		null,
		2,
		.5,
		.5,
		8
	]]],
	"gpt-4.1-mini": ["GPT-4.1 mini", [[
		null,
		.4,
		.1,
		.1,
		1.6
	]]],
	"gpt-4.1-nano": ["GPT-4.1 nano", [[
		null,
		.1,
		.025,
		.025,
		.4
	]]],
	"gpt-4o": ["GPT-4o", [[
		null,
		2.5,
		1.25,
		1.25,
		10
	]]],
	"gpt-4o-2024-05-13": ["GPT-4o (2024-05-13)", [[
		null,
		5,
		.5,
		.5,
		15
	]]],
	"gpt-4o-2024-08-06": ["GPT-4o (2024-08-06)", [[
		null,
		2.5,
		1.25,
		1.25,
		10
	]]],
	"gpt-4o-2024-11-20": ["GPT-4o (2024-11-20)", [[
		null,
		2.5,
		1.25,
		1.25,
		10
	]]],
	"gpt-4o-mini": ["GPT-4o mini", [[
		null,
		.15,
		.075,
		.075,
		.6
	]]],
	"gpt-5": ["GPT-5", [[
		null,
		1.25,
		.125,
		.125,
		10
	]]],
	"gpt-5-codex": ["GPT-5-Codex", [[
		null,
		1.25,
		.13,
		.13,
		10
	]]],
	"gpt-5-mini": ["GPT-5 Mini", [[
		null,
		.25,
		.025,
		.025,
		2
	]]],
	"gpt-5-nano": ["GPT-5 Nano", [[
		null,
		.05,
		.005,
		.005,
		.4
	]]],
	"gpt-5-pro": ["GPT-5 Pro", [[
		null,
		15,
		1.5,
		1.5,
		120
	]]],
	"gpt-5.1": ["GPT-5.1", [[
		null,
		1.25,
		.125,
		.125,
		10
	]]],
	"gpt-5.1-codex": ["GPT-5.1 Codex", [[
		null,
		1.25,
		.125,
		.125,
		10
	]]],
	"gpt-5.1-codex-max": ["GPT-5.1 Codex Max", [[
		null,
		1.25,
		.125,
		.125,
		10
	]]],
	"gpt-5.1-codex-mini": ["GPT-5.1 Codex Mini", [[
		null,
		.25,
		.025,
		.025,
		2
	]]],
	"gpt-5.2": ["GPT-5.2", [[
		null,
		1.75,
		.175,
		.175,
		14
	]]],
	"gpt-5.2-chat-latest": ["GPT-5.2 Chat", [[
		null,
		1.75,
		.175,
		.175,
		14
	]]],
	"gpt-5.2-codex": ["GPT-5.2 Codex", [[
		null,
		1.75,
		.175,
		.175,
		14
	]]],
	"gpt-5.2-pro": ["GPT-5.2 Pro", [[
		null,
		21,
		2.1,
		2.1,
		168
	]]],
	"gpt-5.3-chat-latest": ["GPT-5.3 Chat (latest)", [[
		null,
		1.75,
		.175,
		.175,
		14
	]]],
	"gpt-5.3-codex": ["GPT-5.3 Codex", [[
		null,
		1.75,
		.175,
		.175,
		14
	]]],
	"gpt-5.3-codex-spark": ["GPT-5.3 Codex Spark", [[
		null,
		1.75,
		.175,
		.175,
		14
	]]],
	"gpt-5.4": ["GPT-5.4", [[
		null,
		2.5,
		.25,
		.25,
		15,
		[[
			272e3,
			5,
			.5,
			.5,
			22.5
		]]
	]]],
	"gpt-5.4-mini": ["GPT-5.4 mini", [[
		null,
		.75,
		.075,
		.075,
		4.5
	]]],
	"gpt-5.4-nano": ["GPT-5.4 nano", [[
		null,
		.2,
		.02,
		.02,
		1.25
	]]],
	"gpt-5.4-pro": ["GPT-5.4 Pro", [[
		null,
		30,
		3,
		3,
		180,
		[[
			272e3,
			60,
			6,
			6,
			270
		]]
	]]],
	"gpt-5.5": ["GPT-5.5", [[
		null,
		5,
		.5,
		.5,
		30,
		[[
			272e3,
			10,
			1,
			1,
			45
		]]
	]]],
	"gpt-5.5-pro": ["GPT-5.5 Pro", [[
		null,
		30,
		3,
		3,
		180,
		[[
			272e3,
			60,
			6,
			6,
			270
		]]
	]]],
	"gpt-5.6": ["GPT-5.6", [[
		null,
		5,
		6.25,
		.5,
		30,
		[[
			272e3,
			10,
			12.5,
			1,
			45
		]]
	]]],
	"gpt-5.6-luna": ["GPT-5.6 Luna", [[
		null,
		.2,
		.25,
		.02,
		1.2,
		[[
			272e3,
			.4,
			.5,
			.04,
			1.8
		]]
	]]],
	"gpt-5.6-sol": ["GPT-5.6 Sol", [[
		null,
		5,
		6.25,
		.5,
		30,
		[[
			272e3,
			10,
			12.5,
			1,
			45
		]]
	]]],
	"gpt-5.6-terra": ["GPT-5.6 Terra", [[
		null,
		2,
		2.5,
		.2,
		12,
		[[
			272e3,
			4,
			5,
			.4,
			18
		]]
	]]],
	"gpt-chat-latest": ["GPT Chat Latest", [[
		null,
		5,
		.5,
		.5,
		30
	]]],
	"gpt-image-1": ["GPT-Image-1", [[
		null,
		5,
		1.25,
		1.25,
		40
	]]],
	"gpt-image-1.5": ["GPT-Image-1.5", [[
		null,
		5,
		1.25,
		1.25,
		32
	]]],
	"gpt-image-2": ["gpt-image-2", [[
		null,
		5,
		1.25,
		1.25,
		30
	]]],
	"gpt-realtime-2.1": ["GPT-Realtime-2.1", [[
		null,
		4,
		.4,
		.4,
		24
	]]],
	"grok-4-1-fast-non-reasoning": ["Grok 4.1 Fast (Non-Reasoning)", [[
		null,
		.2,
		.05,
		.05,
		.5
	]]],
	"grok-4-1-fast-reasoning": ["Grok 4.1 Fast (Reasoning)", [[
		null,
		.2,
		.05,
		.05,
		.5
	]]],
	"grok-4-20-non-reasoning": ["Grok 4.20 (Non-Reasoning)", [[
		null,
		2,
		.2,
		.2,
		6
	]]],
	"grok-4-20-reasoning": ["Grok 4.20 (Reasoning)", [[
		null,
		2,
		.2,
		.2,
		6
	]]],
	"grok-4.20-0309-non-reasoning": ["Grok 4.20 (Non-Reasoning)", [[
		null,
		1.25,
		.2,
		.2,
		2.5,
		[[
			2e5,
			2.5,
			.4,
			.4,
			5
		]]
	]]],
	"grok-4.20-0309-reasoning": ["Grok 4.20 (Reasoning)", [[
		null,
		1.25,
		.2,
		.2,
		2.5,
		[[
			2e5,
			2.5,
			.4,
			.4,
			5
		]]
	]]],
	"grok-4.20-multi-agent-0309": ["Grok 4.20 Multi-Agent", [[
		null,
		1.25,
		.2,
		.2,
		2.5,
		[[
			2e5,
			2.5,
			.4,
			.4,
			5
		]]
	]]],
	"grok-4.3": ["Grok 4.3", [[
		null,
		1.25,
		.2,
		.2,
		2.5,
		[[
			2e5,
			2.5,
			.4,
			.4,
			5
		]]
	]]],
	"grok-4.5": ["Grok 4.5", [[
		null,
		2,
		.3,
		.3,
		6,
		[[
			2e5,
			4,
			.6,
			.6,
			12
		]]
	]]],
	"grok-4.6": ["Grok 4.6", [[
		null,
		2,
		.5,
		.5,
		6,
		[[
			2e5,
			4,
			1,
			1,
			12
		]]
	]]],
	"grok-build-0.1": ["Grok Build 0.1", [[
		null,
		1,
		.2,
		.2,
		2,
		[[
			2e5,
			2,
			.4,
			.4,
			4
		]]
	]]],
	"jp.anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5 (JP)", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"jp.anthropic.claude-opus-4-7": ["Claude Opus 4.7 (JP)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"jp.anthropic.claude-opus-4-8": ["Claude Opus 4.8 (JP)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"jp.anthropic.claude-opus-5": ["Claude Opus 5 (JP)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"jp.anthropic.claude-sonnet-4-5-20250929-v1:0": ["Claude Sonnet 4.5 (JP)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"jp.anthropic.claude-sonnet-4-6": ["Claude Sonnet 4.6 (JP)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"jp.anthropic.claude-sonnet-5": ["Claude Sonnet 5 (JP)", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"kimi-k2-0711-preview": ["Kimi K2 0711", [[
		null,
		.6,
		.15,
		.15,
		2.5
	]]],
	"kimi-k2-0905-preview": ["Kimi K2 0905", [[
		null,
		.6,
		.15,
		.15,
		2.5
	]]],
	"kimi-k2-thinking": ["Kimi K2 Thinking", [[
		null,
		.6,
		.15,
		.15,
		2.5
	]]],
	"kimi-k2-thinking-turbo": ["Kimi K2 Thinking Turbo", [[
		null,
		1.15,
		.15,
		.15,
		8
	]]],
	"kimi-k2-turbo-preview": ["Kimi K2 Turbo", [[
		null,
		2.4,
		.6,
		.6,
		10
	]]],
	"kimi-k2.5": ["Kimi K2.5", [[
		null,
		.6,
		.1,
		.1,
		3
	]]],
	"kimi-k2.6": ["Kimi K2.6", [[
		null,
		.95,
		.16,
		.16,
		4
	]]],
	"kimi-k2.7-code": ["Kimi K2.7 Code", [[
		null,
		.95,
		.19,
		.19,
		4
	]]],
	"kimi-k2.7-code-highspeed": ["Kimi K2.7 Code HighSpeed", [[
		null,
		1.9,
		.38,
		.38,
		8
	]]],
	"kimi-k3": ["Kimi K3", [[
		null,
		3,
		.3,
		.3,
		15
	]]],
	"llama-3.3-70b-instruct": ["Llama-3.3-70B-Instruct", [[
		null,
		.71,
		.071,
		.071,
		.71
	]]],
	"llama-4-maverick-17b-128e-instruct-fp8": ["Llama 4 Maverick 17B 128E Instruct FP8", [[
		null,
		.25,
		.025,
		.025,
		1
	]]],
	"llama-4-scout-17b-16e-instruct": ["Llama 4 Scout 17B 16E Instruct", [[
		null,
		.2,
		.020000000000000004,
		.020000000000000004,
		.78
	]]],
	"magistral-medium-latest": ["Magistral Medium (latest)", [[
		null,
		2,
		.2,
		.2,
		5
	]]],
	"magistral-small": ["Magistral Small", [[
		null,
		.5,
		.05,
		.05,
		1.5
	]]],
	"meta.llama3-1-70b-instruct-v1:0": ["Llama 3.1 70B Instruct", [[
		null,
		.72,
		.072,
		.072,
		.72
	]]],
	"meta.llama3-1-8b-instruct-v1:0": ["Llama 3.1 8B Instruct", [[
		null,
		.22,
		.022000000000000002,
		.022000000000000002,
		.22
	]]],
	"meta.llama3-3-70b-instruct-v1:0": ["Llama 3.3 70B Instruct", [[
		null,
		.72,
		.072,
		.072,
		.72
	]]],
	"meta.llama4-maverick-17b-instruct-v1:0": ["Llama 4 Maverick 17B Instruct", [[
		null,
		.24,
		.024,
		.024,
		.97
	]]],
	"meta.llama4-scout-17b-instruct-v1:0": ["Llama 4 Scout 17B Instruct", [[
		null,
		.17,
		.017,
		.017,
		.66
	]]],
	"meta/llama-3.3-70b-instruct-maas": ["Llama 3.3 70B Instruct", [[
		null,
		.72,
		.072,
		.072,
		.72
	]]],
	"meta/llama-4-maverick-17b-128e-instruct-maas": ["Llama 4 Maverick 17B 128E Instruct", [[
		null,
		.35,
		.034999999999999996,
		.034999999999999996,
		1.15
	]]],
	"minimax.minimax-m2": ["MiniMax M2", [[
		null,
		.3,
		.03,
		.03,
		1.2
	]]],
	"minimax.minimax-m2.1": ["MiniMax M2.1", [[
		null,
		.3,
		.03,
		.03,
		1.2
	]]],
	"minimax.minimax-m2.5": ["MiniMax M2.5", [[
		null,
		.3,
		.03,
		.03,
		1.2
	]]],
	"ministral-3b": ["Ministral 3B", [[
		null,
		.04,
		.004,
		.004,
		.04
	]]],
	"ministral-3b-latest": ["Ministral 3B (latest)", [[
		null,
		.04,
		.004,
		.004,
		.04
	]]],
	"ministral-8b-latest": ["Ministral 8B (latest)", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.1
	]]],
	"mistral-embed": ["Mistral Embed", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		0
	]]],
	"mistral-large-2411": ["Mistral Large 2.1", [[
		null,
		2,
		.2,
		.2,
		6
	]]],
	"mistral-large-2512": ["Mistral Large 3", [[
		null,
		.5,
		.05,
		.05,
		1.5
	]]],
	"mistral-large-latest": ["Mistral Large (latest)", [[
		null,
		.5,
		.05,
		.05,
		1.5
	]]],
	"mistral-medium-2505": ["Mistral Medium 3", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"mistral-medium-2508": ["Mistral Medium 3.1", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"mistral-medium-2604": ["Mistral Medium 3.5", [[
		null,
		1.5,
		.15000000000000002,
		.15000000000000002,
		7.5
	]]],
	"mistral-medium-latest": ["Mistral Medium (latest)", [[
		null,
		1.5,
		.15000000000000002,
		.15000000000000002,
		7.5
	]]],
	"mistral-nemo": ["Mistral Nemo", [[
		null,
		.15,
		.015,
		.015,
		.15
	]]],
	"mistral-small-2503": ["Mistral Small 3.1", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.3
	]]],
	"mistral-small-2506": ["Mistral Small 3.2", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.3
	]]],
	"mistral-small-2603": ["Mistral Small 4", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"mistral-small-latest": ["Mistral Small (latest)", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"mistral.devstral-2-123b": ["Devstral 2 123B", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2
	]]],
	"mistral.magistral-small-2509": ["Magistral Small 1.2", [[
		null,
		.5,
		.05,
		.05,
		1.5
	]]],
	"mistral.ministral-3-14b-instruct": ["Ministral 14B 3.0", [[
		null,
		.2,
		.020000000000000004,
		.020000000000000004,
		.2
	]]],
	"mistral.ministral-3-3b-instruct": ["Ministral 3 3B", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.1
	]]],
	"mistral.ministral-3-8b-instruct": ["Ministral 3 8B", [[
		null,
		.15,
		.015,
		.015,
		.15
	]]],
	"mistral.mistral-large-3-675b-instruct": ["Mistral Large 3", [[
		null,
		.5,
		.05,
		.05,
		1.5
	]]],
	"mistral.pixtral-large-2502-v1:0": ["Pixtral Large (25.02)", [[
		null,
		2,
		.2,
		.2,
		6
	]]],
	"mistral.voxtral-mini-3b-2507": ["Voxtral Mini 3B 2507", [[
		null,
		.04,
		.004,
		.004,
		.04
	]]],
	"mistral.voxtral-small-24b-2507": ["Voxtral Small 24B 2507", [[
		null,
		.15,
		.015,
		.015,
		.35
	]]],
	"model-router": ["Model Router", [[
		null,
		.14,
		.014000000000000002,
		.014000000000000002,
		0
	]]],
	"moonshot.kimi-k2-thinking": ["Kimi K2 Thinking", [[
		null,
		.6,
		.06,
		.06,
		2.5
	]]],
	"moonshotai.kimi-k2.5": ["Kimi K2.5", [[
		null,
		.6,
		.06,
		.06,
		3
	]]],
	"moonshotai/kimi-k2-thinking-maas": ["Kimi K2 Thinking", [[
		null,
		.6,
		.06,
		.06,
		2.5
	]]],
	"muse-spark-1.1": ["Muse Spark 1.1", [[
		null,
		1.25,
		.15,
		.15,
		4.25
	]]],
	"muse-spark-1.2": ["Muse Spark 1.2", [[
		null,
		1.25,
		.15,
		.15,
		4.25
	]]],
	"muse-spark-1.2-contributor": ["Muse Spark 1.2 Contributor", [[
		null,
		.1,
		.002,
		.002,
		.2
	]]],
	"nvidia.nemotron-nano-12b-v2": ["NVIDIA Nemotron Nano 12B v2 VL BF16", [[
		null,
		.2,
		.020000000000000004,
		.020000000000000004,
		.6
	]]],
	"nvidia.nemotron-nano-3-30b": ["NVIDIA Nemotron Nano 3 30B", [[
		null,
		.06,
		.006,
		.006,
		.24
	]]],
	"nvidia.nemotron-nano-9b-v2": ["NVIDIA Nemotron Nano 9B v2", [[
		null,
		.06,
		.006,
		.006,
		.23
	]]],
	"nvidia.nemotron-super-3-120b": ["NVIDIA Nemotron 3 Super 120B A12B", [[
		null,
		.15,
		.015,
		.015,
		.65
	]]],
	"o1": ["o1", [[
		null,
		15,
		7.5,
		7.5,
		60
	]]],
	"o1-pro": ["o1-pro", [[
		null,
		150,
		15,
		15,
		600
	]]],
	"o3": ["o3", [[
		null,
		2,
		.5,
		.5,
		8
	]]],
	"o3-mini": ["o3-mini", [[
		null,
		1.1,
		.55,
		.55,
		4.4
	]]],
	"o3-pro": ["o3-pro", [[
		null,
		20,
		2,
		2,
		80
	]]],
	"o4-mini": ["o4-mini", [[
		null,
		1.1,
		.275,
		.275,
		4.4
	]]],
	"open-mistral-7b": ["Mistral 7B", [[
		null,
		.25,
		.025,
		.025,
		.25
	]]],
	"open-mistral-nemo": ["Open Mistral Nemo", [[
		null,
		.15,
		.015,
		.015,
		.15
	]]],
	"open-mixtral-8x22b": ["Mixtral 8x22B", [[
		null,
		2,
		.2,
		.2,
		6
	]]],
	"open-mixtral-8x7b": ["Mixtral 8x7B", [[
		null,
		.7,
		.06999999999999999,
		.06999999999999999,
		.7
	]]],
	"openai.gpt-5.4": ["GPT-5.4", [[
		null,
		2.75,
		.275,
		.275,
		16.5
	]]],
	"openai.gpt-5.5": ["GPT-5.5", [[
		null,
		5.5,
		.55,
		.55,
		33
	]]],
	"openai.gpt-5.6-luna": ["GPT-5.6 Luna", [[
		null,
		.22,
		.275,
		.022,
		1.32,
		[[
			272e3,
			.44,
			.55,
			.044,
			1.98
		]]
	]]],
	"openai.gpt-5.6-sol": ["GPT-5.6 Sol", [[
		null,
		5.5,
		6.875,
		.55,
		33,
		[[
			272e3,
			11,
			13.75,
			1.1,
			49.5
		]]
	]]],
	"openai.gpt-5.6-terra": ["GPT-5.6 Terra", [[
		null,
		2.2,
		2.75,
		.22,
		13.2,
		[[
			272e3,
			4.4,
			5.5,
			.44,
			19.8
		]]
	]]],
	"openai.gpt-oss-120b": ["gpt-oss-120b", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"openai.gpt-oss-120b-1:0": ["gpt-oss-120b", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"openai.gpt-oss-20b": ["gpt-oss-20b", [[
		null,
		.07,
		.007000000000000001,
		.007000000000000001,
		.3
	]]],
	"openai.gpt-oss-20b-1:0": ["gpt-oss-20b", [[
		null,
		.07,
		.007000000000000001,
		.007000000000000001,
		.3
	]]],
	"openai.gpt-oss-safeguard-120b": ["GPT OSS Safeguard 120B", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"openai.gpt-oss-safeguard-20b": ["GPT OSS Safeguard 20B", [[
		null,
		.07,
		.007000000000000001,
		.007000000000000001,
		.2
	]]],
	"openai/gpt-oss-120b-maas": ["GPT OSS 120B", [[
		null,
		.09,
		.009,
		.009,
		.36
	]]],
	"openai/gpt-oss-20b-maas": ["GPT OSS 20B", [[
		null,
		.07,
		.007000000000000001,
		.007000000000000001,
		.25
	]]],
	"phi-4": ["Phi-4", [[
		null,
		.125,
		.0125,
		.0125,
		.5
	]]],
	"phi-4-mini": ["Phi-4-mini", [[
		null,
		.075,
		.0075,
		.0075,
		.3
	]]],
	"phi-4-mini-reasoning": ["Phi-4-mini-reasoning", [[
		null,
		.075,
		.0075,
		.0075,
		.3
	]]],
	"phi-4-multimodal": ["Phi-4-multimodal", [[
		null,
		.08,
		.008,
		.008,
		.32
	]]],
	"phi-4-reasoning": ["Phi-4-reasoning", [[
		null,
		.125,
		.0125,
		.0125,
		.5
	]]],
	"phi-4-reasoning-plus": ["Phi-4-reasoning-plus", [[
		null,
		.125,
		.0125,
		.0125,
		.5
	]]],
	"pixtral-12b": ["Pixtral 12B", [[
		null,
		.15,
		.015,
		.015,
		.15
	]]],
	"pixtral-large-latest": ["Pixtral Large (latest)", [[
		null,
		2,
		.2,
		.2,
		6
	]]],
	"qvq-max": ["QVQ Max", [[
		null,
		1.2,
		.12,
		.12,
		4.8
	]]],
	"qwen-flash": ["Qwen Flash", [[
		null,
		.05,
		.005000000000000001,
		.005000000000000001,
		.4
	]]],
	"qwen-max": ["Qwen Max", [[
		null,
		1.6,
		.16000000000000003,
		.16000000000000003,
		6.4
	]]],
	"qwen-mt-plus": ["Qwen-MT Plus", [[
		null,
		2.46,
		.246,
		.246,
		7.37
	]]],
	"qwen-mt-turbo": ["Qwen-MT Turbo", [[
		null,
		.16,
		.016,
		.016,
		.49
	]]],
	"qwen-omni-turbo": ["Qwen-Omni Turbo", [[
		null,
		.07,
		.007000000000000001,
		.007000000000000001,
		.27
	]]],
	"qwen-omni-turbo-realtime": ["Qwen-Omni Turbo Realtime", [[
		null,
		.27,
		.027000000000000003,
		.027000000000000003,
		1.07
	]]],
	"qwen-plus": ["Qwen Plus", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		1.2,
		null,
		4
	]]],
	"qwen-plus-character-ja": ["Qwen Plus Character (Japanese)", [[
		null,
		.5,
		.05,
		.05,
		1.4
	]]],
	"qwen-turbo": ["Qwen Turbo", [[
		null,
		.05,
		.005000000000000001,
		.005000000000000001,
		.2,
		null,
		.5
	]]],
	"qwen-vl-max": ["Qwen-VL Max", [[
		null,
		.8,
		.08000000000000002,
		.08000000000000002,
		3.2
	]]],
	"qwen-vl-ocr": ["Qwen-VL OCR", [[
		null,
		.72,
		.072,
		.072,
		.72
	]]],
	"qwen-vl-plus": ["Qwen-VL Plus", [[
		null,
		.21,
		.021,
		.021,
		.63
	]]],
	"qwen.qwen3-235b-a22b-2507-v1:0": ["Qwen3 235B A22B 2507", [[
		null,
		.22,
		.022000000000000002,
		.022000000000000002,
		.88
	]]],
	"qwen.qwen3-32b-v1:0": ["Qwen3 32B (dense)", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"qwen.qwen3-coder-30b-a3b-v1:0": ["Qwen3 Coder 30B A3B Instruct", [[
		null,
		.15,
		.015,
		.015,
		.6
	]]],
	"qwen.qwen3-coder-480b-a35b-v1:0": ["Qwen3 Coder 480B A35B Instruct", [[
		null,
		.22,
		.022000000000000002,
		.022000000000000002,
		1.8
	]]],
	"qwen.qwen3-coder-next": ["Qwen3 Coder Next", [[
		null,
		.22,
		.022000000000000002,
		.022000000000000002,
		1.8
	]]],
	"qwen.qwen3-next-80b-a3b": ["Qwen/Qwen3-Next-80B-A3B-Instruct", [[
		null,
		.14,
		.014000000000000002,
		.014000000000000002,
		1.4
	]]],
	"qwen.qwen3-vl-235b-a22b": ["Qwen/Qwen3-VL-235B-A22B-Instruct", [[
		null,
		.3,
		.03,
		.03,
		1.5
	]]],
	"qwen/qwen3-235b-a22b-instruct-2507-maas": ["Qwen3 235B A22B Instruct", [[
		null,
		.22,
		.022000000000000002,
		.022000000000000002,
		.88
	]]],
	"qwen2-5-14b-instruct": ["Qwen2.5 14B Instruct", [[
		null,
		.35,
		.034999999999999996,
		.034999999999999996,
		1.4
	]]],
	"qwen2-5-32b-instruct": ["Qwen2.5 32B Instruct", [[
		null,
		.7,
		.06999999999999999,
		.06999999999999999,
		2.8
	]]],
	"qwen2-5-72b-instruct": ["Qwen2.5 72B Instruct", [[
		null,
		1.4,
		.13999999999999999,
		.13999999999999999,
		5.6
	]]],
	"qwen2-5-7b-instruct": ["Qwen2.5 7B Instruct", [[
		null,
		.175,
		.017499999999999998,
		.017499999999999998,
		.7
	]]],
	"qwen2-5-omni-7b": ["Qwen2.5-Omni 7B", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.4
	]]],
	"qwen2-5-vl-72b-instruct": ["Qwen2.5-VL 72B Instruct", [[
		null,
		2.8,
		.27999999999999997,
		.27999999999999997,
		8.4
	]]],
	"qwen2-5-vl-7b-instruct": ["Qwen2.5-VL 7B Instruct", [[
		null,
		.35,
		.034999999999999996,
		.034999999999999996,
		1.05
	]]],
	"qwen3-14b": ["Qwen3 14B", [[
		null,
		.35,
		.034999999999999996,
		.034999999999999996,
		1.4,
		null,
		4.2
	]]],
	"qwen3-235b-a22b": ["Qwen3 235B-A22B", [[
		null,
		.7,
		.06999999999999999,
		.06999999999999999,
		2.8,
		null,
		8.4
	]]],
	"qwen3-32b": ["Qwen3 32B", [[
		null,
		.7,
		.06999999999999999,
		.06999999999999999,
		2.8,
		null,
		8.4
	]]],
	"qwen3-8b": ["Qwen3 8B", [[
		null,
		.18,
		.018,
		.018,
		.7,
		null,
		2.1
	]]],
	"qwen3-asr-flash": ["Qwen3-ASR Flash", [[
		null,
		.035,
		.0035000000000000005,
		.0035000000000000005,
		.035
	]]],
	"qwen3-coder-30b-a3b-instruct": ["Qwen3-Coder 30B-A3B Instruct", [[
		null,
		.45,
		.045000000000000005,
		.045000000000000005,
		2.25
	]]],
	"qwen3-coder-480b-a35b-instruct": ["Qwen3-Coder 480B-A35B Instruct", [[
		null,
		1.5,
		.15000000000000002,
		.15000000000000002,
		7.5
	]]],
	"qwen3-coder-flash": ["Qwen3 Coder Flash", [[
		null,
		.3,
		.03,
		.03,
		1.5
	]]],
	"qwen3-coder-plus": ["Qwen3 Coder Plus", [[
		null,
		1,
		.1,
		.1,
		5
	]]],
	"qwen3-livetranslate-flash-realtime": ["Qwen3-LiveTranslate Flash Realtime", [[
		null,
		10,
		1,
		1,
		10
	]]],
	"qwen3-max": ["Qwen3 Max", [[
		null,
		1.2,
		.12,
		.12,
		6
	]]],
	"qwen3-next-80b-a3b-instruct": ["Qwen3-Next 80B-A3B Instruct", [[
		null,
		.5,
		.05,
		.05,
		2
	]]],
	"qwen3-next-80b-a3b-thinking": ["Qwen3-Next 80B-A3B (Thinking)", [[
		null,
		.5,
		.05,
		.05,
		6
	]]],
	"qwen3-omni-flash": ["Qwen3-Omni Flash", [[
		null,
		.43,
		.043000000000000003,
		.043000000000000003,
		1.66
	]]],
	"qwen3-omni-flash-realtime": ["Qwen3-Omni Flash Realtime", [[
		null,
		.52,
		.052000000000000005,
		.052000000000000005,
		1.99
	]]],
	"qwen3-vl-235b-a22b": ["Qwen3-VL 235B-A22B", [[
		null,
		.7,
		.06999999999999999,
		.06999999999999999,
		2.8,
		null,
		8.4
	]]],
	"qwen3-vl-30b-a3b": ["Qwen3-VL 30B-A3B", [[
		null,
		.2,
		.020000000000000004,
		.020000000000000004,
		.8,
		null,
		2.4
	]]],
	"qwen3-vl-plus": ["Qwen3-VL Plus", [[
		null,
		.2,
		.020000000000000004,
		.020000000000000004,
		1.6,
		null,
		4.8
	]]],
	"qwen3.5-122b-a10b": ["Qwen3.5 122B-A10B", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		3.2
	]]],
	"qwen3.5-27b": ["Qwen3.5 27B", [[
		null,
		.3,
		.03,
		.03,
		2.4
	]]],
	"qwen3.5-35b-a3b": ["Qwen3.5 35B-A3B", [[
		null,
		.25,
		.025,
		.025,
		2
	]]],
	"qwen3.5-397b-a17b": ["Qwen3.5 397B-A17B", [[
		null,
		.6,
		.06,
		.06,
		3.6
	]]],
	"qwen3.5-plus": ["Qwen3.5 Plus", [[
		null,
		.4,
		.04000000000000001,
		.04000000000000001,
		2.4
	]]],
	"qwen3.6-27b": ["Qwen3.6 27B", [[
		null,
		.6,
		.06,
		.06,
		3.6
	]]],
	"qwen3.6-35b-a3b": ["Qwen3.6 35B-A3B", [[
		null,
		.248,
		.024800000000000003,
		.024800000000000003,
		1.485
	]]],
	"qwen3.6-flash": ["Qwen3.6 Flash", [[
		null,
		.1875,
		.234375,
		.018750000000000003,
		1.125
	]]],
	"qwen3.6-max-preview": ["Qwen3.6 Max Preview", [[
		null,
		1.3,
		1.625,
		.13,
		7.8
	]]],
	"qwen3.6-plus": ["Qwen3.6 Plus", [[
		null,
		.5,
		.625,
		.05,
		3,
		[[
			256e3,
			2,
			2.5,
			.2,
			6
		]]
	]]],
	"qwen3.7-max": ["Qwen3.7 Max", [[
		null,
		2.5,
		3.125,
		.5,
		7.5
	]]],
	"qwen3.7-plus": ["Qwen3.7 Plus", [[
		null,
		.5,
		.625,
		.05,
		3,
		[[
			256e3,
			2,
			2.5,
			.2,
			6
		]]
	]]],
	"qwen3.8-max": ["Qwen3.8 Max", [[
		null,
		2,
		2.5,
		.25,
		6
	]]],
	"qwq-plus": ["QwQ Plus", [[
		null,
		.8,
		.08000000000000002,
		.08000000000000002,
		2.4
	]]],
	"text-embedding-3-large": ["text-embedding-3-large", [[
		null,
		.13,
		.013000000000000001,
		.013000000000000001,
		0
	]]],
	"text-embedding-3-small": ["text-embedding-3-small", [[
		null,
		.02,
		.002,
		.002,
		0
	]]],
	"text-embedding-ada-002": ["text-embedding-ada-002", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		0
	]]],
	"us.anthropic.claude-fable-5": ["Claude Fable 5 (US)", [[
		null,
		10,
		12.5,
		1,
		50
	]]],
	"us.anthropic.claude-haiku-4-5-20251001-v1:0": ["Claude Haiku 4.5 (US)", [[
		null,
		1,
		1.25,
		.1,
		5
	]]],
	"us.anthropic.claude-opus-4-1-20250805-v1:0": ["Claude Opus 4.1 (US)", [[
		null,
		15,
		18.75,
		1.5,
		75
	]]],
	"us.anthropic.claude-opus-4-5-20251101-v1:0": ["Claude Opus 4.5 (US)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"us.anthropic.claude-opus-4-6-v1": ["Claude Opus 4.6 (US)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"us.anthropic.claude-opus-4-7": ["Claude Opus 4.7 (US)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"us.anthropic.claude-opus-4-8": ["Claude Opus 4.8 (US)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"us.anthropic.claude-opus-5": ["Claude Opus 5 (US)", [[
		null,
		5,
		6.25,
		.5,
		25
	]]],
	"us.anthropic.claude-sonnet-4-5-20250929-v1:0": ["Claude Sonnet 4.5 (US)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"us.anthropic.claude-sonnet-4-6": ["Claude Sonnet 4.6 (US)", [[
		null,
		3,
		3.75,
		.3,
		15
	]]],
	"us.anthropic.claude-sonnet-5": ["Claude Sonnet 5 (US)", [[
		null,
		2,
		2.5,
		.2,
		10
	]]],
	"us.deepseek.r1-v1:0": ["DeepSeek-R1 (US)", [[
		null,
		1.35,
		.135,
		.135,
		5.4
	]]],
	"us.meta.llama4-maverick-17b-instruct-v1:0": ["Llama 4 Maverick 17B Instruct (US)", [[
		null,
		.24,
		.024,
		.024,
		.97
	]]],
	"us.meta.llama4-scout-17b-instruct-v1:0": ["Llama 4 Scout 17B Instruct (US)", [[
		null,
		.17,
		.017,
		.017,
		.66
	]]],
	"voxtral-small-latest": ["Voxtral Small (latest)", [[
		null,
		.1,
		.010000000000000002,
		.010000000000000002,
		.3
	]]],
	"writer.palmyra-x4-v1:0": ["Palmyra X4", [[
		null,
		2.5,
		.25,
		.25,
		10
	]]],
	"writer.palmyra-x5-v1:0": ["Palmyra X5", [[
		null,
		.6,
		.06,
		.06,
		6
	]]],
	"xai.grok-4.3": ["Grok 4.3", [[
		null,
		1.25,
		.2,
		.2,
		2.5
	]]],
	"zai-org/glm-4.7-maas": ["GLM-4.7", [[
		null,
		.6,
		.06,
		.06,
		2.2
	]]],
	"zai-org/glm-5-maas": ["GLM-5", [[
		null,
		1,
		.1,
		.1,
		3.2
	]]],
	"zai.glm-4.7": ["GLM-4.7", [[
		null,
		.6,
		.06,
		.06,
		2.2
	]]],
	"zai.glm-4.7-flash": ["GLM-4.7-Flash", [[
		null,
		.07,
		.007000000000000001,
		.007000000000000001,
		.4
	]]],
	"zai.glm-5": ["GLM-5", [[
		null,
		1,
		.1,
		.1,
		3.2
	]]]
};
/** When the bundled archive was last refreshed (YYYY-MM-DD). */
const SNAPSHOT_SYNCED_AT = syncedAt;
/**
* The archive's last observation, as epoch ms. Anything a live source
* reports is newer than this and must not be applied before it — see
* `mergeLiveQuote`.
*/
const SNAPSHOT_SYNCED_AT_MS = Date.parse(`${syncedAt}T00:00:00Z`);
function toRates(input, cacheWrite, cacheRead, output) {
	return {
		inputCostPerToken: input / 1e6,
		cacheCreationInputCostPerToken: cacheWrite / 1e6,
		cacheReadInputCostPerToken: cacheRead / 1e6,
		cachedInputCostPerToken: cacheRead / 1e6,
		outputCostPerToken: output / 1e6
	};
}
function toTier([above, input, cacheWrite, cacheRead, output]) {
	return {
		abovePromptTokens: above,
		rates: toRates(input, cacheWrite, cacheRead, output)
	};
}
function toPeriod([from, input, cacheWrite, cacheRead, output, tiers, reasoningOutput]) {
	const rates = toRates(input, cacheWrite, cacheRead, output);
	return {
		from: from === null ? Number.NEGATIVE_INFINITY : Date.parse(`${from}T00:00:00Z`),
		rates,
		contextTiers: tiers?.map(toTier) ?? void 0,
		reasoningRates: reasoningOutput === void 0 ? void 0 : {
			...rates,
			outputCostPerToken: reasoningOutput / 1e6
		}
	};
}
const FALLBACK = {};
for (const [id, [displayName, periods]] of Object.entries(SNAPSHOT_MODELS)) FALLBACK[id] = {
	displayName,
	source: "fallback",
	periods: periods.map(toPeriod),
	sqlMatch: periods.length > 1 ? [`%${id}%`] : void 0
};
const FAST_MULTIPLIERS = [
	[6, ["claude-opus-4-6", "claude-opus-4-7"]],
	[2, ["claude-opus-4-8", "claude-opus-5"]],
	[2.5, ["gpt-5.5"]],
	[2, [
		"gpt-5",
		"gpt-5-codex",
		"gpt-5.1",
		"gpt-5.1-codex",
		"gpt-5.1-codex-max",
		"gpt-5.1-codex-mini",
		"gpt-5.2-codex",
		"gpt-5.3-codex",
		"gpt-5.4",
		"gpt-5.4-mini",
		"gpt-5.6-sol",
		"gpt-5.6-luna",
		"gpt-5.6-terra"
	]]
];
const CONTEXT_TIER_MULTIPLIERS = { "qwen-plus": [[256e3, 3]] };
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
const FAST_BY_ID = {};
for (const [multiplier, baseIds] of FAST_MULTIPLIERS) for (const id of baseIds) FAST_BY_ID[`${id}-fast`] = {
	base: id,
	multiplier
};
/**
* Attach the hand-maintained long-context tiers for `id`, if there are any and
* the schedule does not already price by prompt size.
*
* Derived per period, so a model with price history gets a tier scaled from
* each era's own card rather than from today's — and returned by identity when
* there is nothing to add, which is every model but the handful listed above.
*/
function withDerivedContextTiers(id, schedule) {
	const multipliers = CONTEXT_TIER_MULTIPLIERS[id];
	if (!multipliers || schedule.periods.some((period) => period.contextTiers?.length)) return schedule;
	return {
		...schedule,
		periods: schedule.periods.map((period) => ({
			...period,
			contextTiers: multipliers.map(([abovePromptTokens, multiplier]) => ({
				abovePromptTokens,
				rates: scaleRates(period.rates, multiplier),
				reasoningRates: period.reasoningRates && scaleRates(period.reasoningRates, multiplier)
			}))
		}))
	};
}
//#endregion
//#region src/catalog/overrides.ts
const DEEPSEEK_PEAK_FROM_MS = Date.UTC(2026, 7, 16, 16, 0, 0);
const DEEPSEEK_PEAK_WINDOWS_UTC = [[1, 4], [6, 10]];
const DEEPSEEK_WEEKEND_OFF_PEAK_FROM_MS = Date.UTC(2026, 7, 22, 16, 0, 0);
const DEEPSEEK_PEAK_DAYS_UTC = [
	1,
	2,
	3,
	4,
	5
];
function deepseekRates(hitPerMTok, missPerMTok, outputPerMTok) {
	return {
		inputCostPerToken: missPerMTok / 1e6,
		cacheCreationInputCostPerToken: missPerMTok / 1e6,
		cacheReadInputCostPerToken: hitPerMTok / 1e6,
		cachedInputCostPerToken: hitPerMTok / 1e6,
		outputCostPerToken: outputPerMTok / 1e6
	};
}
/**
* The two periods DeepSeek's peak schedule has had, from one pair of cards.
*
* The weekend period differs from the weekday-and-weekend one it replaces by
* exactly `daysUtc`, so it is derived from it rather than restated: written
* out twice, the six rate literals per model had nothing checking the copies
* still agreed, and the next rate correction would have landed on one period
* only.
*/
function deepseekPeakPeriods(offPeak, peak) {
	const weekdaysAndWeekends = {
		from: DEEPSEEK_PEAK_FROM_MS,
		rates: offPeak,
		peak: {
			windowsUtc: DEEPSEEK_PEAK_WINDOWS_UTC,
			rates: peak
		}
	};
	return [weekdaysAndWeekends, {
		...weekdaysAndWeekends,
		from: DEEPSEEK_WEEKEND_OFF_PEAK_FROM_MS,
		peak: {
			...weekdaysAndWeekends.peak,
			daysUtc: DEEPSEEK_PEAK_DAYS_UTC
		}
	}];
}
const DEEPSEEK_SQL_MATCH = ["%deepseek%"];
const OVERRIDES = {
	"deepseek-v4-flash": {
		displayName: "DeepSeek V4 Flash",
		source: "override",
		sqlMatch: DEEPSEEK_SQL_MATCH,
		periods: [{
			from: Number.NEGATIVE_INFINITY,
			rates: deepseekRates(.0028, .14, .28)
		}, ...deepseekPeakPeriods(deepseekRates(.007, .22, .66), deepseekRates(.014, .44, 1.32))]
	},
	"deepseek-v4-pro": {
		displayName: "DeepSeek V4 Pro",
		source: "override",
		sqlMatch: DEEPSEEK_SQL_MATCH,
		periods: [{
			from: Number.NEGATIVE_INFINITY,
			rates: deepseekRates(.003625, .435, .87)
		}, ...deepseekPeakPeriods(deepseekRates(.022, .66, 1.98), deepseekRates(.044, 1.32, 3.96))]
	}
};
//#endregion
//#region src/schedule.ts
function toMs(value) {
	if (value === null || value === void 0) return null;
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	const ms = value instanceof Date ? value.getTime() : Date.parse(value);
	return Number.isFinite(ms) ? ms : null;
}
/**
* A schedule is time-sensitive when *when* the tokens were spent changes
* what they cost: more than one effective period, or any peak window.
*
* Called once per priced row, so it stays allocation-free (no closure).
*/
function isTimeSensitive(schedule) {
	if (schedule.periods.length > 1) return true;
	for (const period of schedule.periods) if (period.peak) return true;
	return false;
}
/**
* Nothing known: an aggregated row, or a caller that never opted in.
*
* Exported and shared rather than built per call — this is the majority case,
* and `estimate` runs once per row, so a fresh `{}` each time would be an
* allocation to say nothing.
*/
const NOTHING_KNOWN = Object.freeze({
	promptTokens: void 0,
	usedReasoning: void 0
});
/**
* Whether any period of this schedule prices by something only a single
* request can answer — prompt size or thinking mode.
*
* Lets callers that memoise a resolution leave those facts out of their key
* for the ~97% of models priced by neither, where they cannot change the
* answer.
*/
const PRICES_BY_REQUEST = /* @__PURE__ */ new WeakMap();
function pricesByRequest(schedule) {
	const known = PRICES_BY_REQUEST.get(schedule);
	if (known !== void 0) return known;
	let found = false;
	for (const period of schedule.periods) if (period.contextTiers?.length || period.reasoningRates) {
		found = true;
		break;
	}
	PRICES_BY_REQUEST.set(schedule, found);
	return found;
}
function periodAt(schedule, atMs) {
	let current = schedule.periods[0];
	for (const period of schedule.periods) if (period.from <= atMs) current = period;
	else break;
	return current;
}
/**
* The UTC weekday (0 = Sunday) of a whole-day index counted from the epoch.
* 1970-01-01 was a Thursday, and the `+ 7` keeps pre-epoch days positive.
*/
function weekdayOf(dayIndex) {
	return ((dayIndex + 4) % 7 + 7) % 7;
}
/**
* Whether a day carries the peak windows at all. `daysUtc` absent means
* every day does — the shape every vendor but DeepSeek publishes.
*/
function isPeakDay(daysUtc, dayIndex) {
	return daysUtc === void 0 || daysUtc.includes(weekdayOf(dayIndex));
}
function isPeakHour(peak, atMs) {
	const dayIndex = Math.floor(atMs / DAY_MS);
	if (!isPeakDay(peak.daysUtc, dayIndex)) return false;
	const hour = Math.floor((atMs - dayIndex * DAY_MS) / HOUR_MS);
	return peak.windowsUtc.some(([start, end]) => hour >= start && hour < end);
}
/**
* The tier a prompt of `promptTokens` falls in, or null for the base card.
*
* `undefined` promptTokens means the caller did not state that this row is
* one request, so no tier can be selected — see `EstimateArgs.perRequest`.
* Ascending order is a `normalizeSchedule` invariant, so the last match is
* the highest one cleared.
*/
function contextTierFor(period, promptTokens) {
	if (promptTokens === void 0 || !period.contextTiers) return null;
	let hit = null;
	for (const tier of period.contextTiers) if (promptTokens > tier.abovePromptTokens) hit = tier;
	else break;
	return hit;
}
/**
* A card, or its thinking-mode variant when the request reasoned and the
* vendor prices that apart.
*
* Applied to whichever card the other dimensions already chose, which is what
* keeps prompt size and thinking mode composing instead of multiplying: each
* card carries its own variant, so there is never a matrix to enumerate.
*/
function variantOf(card, usedReasoning) {
	return usedReasoning && card.reasoningRates ? card.reasoningRates : card.rates;
}
/**
* The one card a period resolves to: peak window first, then prompt size,
* then thinking mode.
*
* Peak and the two per-request dimensions never co-occur upstream — no vendor
* publishes both a peak schedule and either of the others — so peak is an
* early return rather than another axis.
*/
function cardFor(period, atMs, facts) {
	if (atMs !== void 0 && period.peak && isPeakHour(period.peak, atMs)) return period.peak.rates;
	return variantOf(contextTierFor(period, facts.promptTokens) ?? period, facts.usedReasoning);
}
/** Exact rate card at one instant. */
function ratesAt(schedule, atMs, facts = NOTHING_KNOWN) {
	return cardFor(periodAt(schedule, atMs), atMs, facts);
}
/**
* Milliseconds of one daily UTC window that fall in [epoch, x). Closed
* form: whole elapsed days each contribute the window's full length, and
* the partial last day contributes however much of it has elapsed.
*
* Everything about *x* — how many peak days precede it, how far into its own
* day it is, and whether that day carries the windows at all — is a property
* of the boundary rather than of the window, so `peakMsBetween` computes it
* once per boundary and passes it in.
*/
function dailyWindowMsUpTo(day, startMs, lengthMs) {
	return day.peakDaysBefore * lengthMs + (day.counts ? Math.min(Math.max(day.intoDay - startMs, 0), lengthMs) : 0);
}
/**
* Everything the prefix sum needs about one boundary: whole weeks contribute
* their peak days each, leaving at most six days to walk.
*/
function dayCountAt(x, daysUtc) {
	const days = Math.floor(x / DAY_MS);
	const intoDay = x - days * DAY_MS;
	if (daysUtc === void 0) return {
		peakDaysBefore: days,
		intoDay,
		counts: true
	};
	const weeks = Math.floor(days / 7);
	let count = weeks * peakDaysPerWeek(daysUtc);
	for (let day = weeks * 7; day < days; day++) if (isPeakDay(daysUtc, day)) count++;
	return {
		peakDaysBefore: count,
		intoDay,
		counts: isPeakDay(daysUtc, days)
	};
}
/**
* How many days of a whole week are peak days — counted rather than read off
* `daysUtc.length`.
*
* `normalizeSchedule` does deduplicate, but this is a multiplier on every
* whole week in the range, so trusting that invariant across a module
* boundary means a caller reaching these exported primitives with a
* hand-written `[1, 1, 1]` bills three times the peak hours it should. Seven
* membership tests on an at-most-seven-element array, twice per blended
* segment and never on the per-row path, is not a price worth paying for
* that.
*/
function peakDaysPerWeek(daysUtc) {
	let perWeek = 0;
	for (let weekday = 0; weekday < 7; weekday++) if (daysUtc.includes(weekday)) perWeek++;
	return perWeek;
}
/**
* The effective start of a blend window. An unbounded (all-time) one would
* give ancient rates unbounded weight; a year of lookback is enough for any
* live schedule.
*/
function blendStart(fromMs, toMs) {
	return Number.isFinite(fromMs) ? fromMs : toMs - 365 * DAY_MS;
}
/**
* The periods a window draws on, each clipped to it.
*
* Shared by everything that reasons about a blend — the rate parts, the tier
* claim, the bound cards. Three independent walks of the same overlap
* arithmetic were three chances to disagree about which periods a window
* actually touched, and a disagreement there is silent: the blend would
* average one set of periods while the tier claim spoke for another.
*/
function weightedPeriods(schedule, startMs, toMs) {
	const out = [];
	const periods = schedule.periods;
	for (let i = 0; i < periods.length; i++) {
		const period = periods[i];
		const next = periods[i + 1];
		const from = Math.max(startMs, period.from);
		const to = Math.min(toMs, next ? next.from : Number.POSITIVE_INFINITY);
		if (to > from) out.push({
			period,
			from,
			to
		});
	}
	return out;
}
const UNRULED_OUT_BY_PERIOD = /* @__PURE__ */ new WeakMap();
function unruledOutCards(period, facts) {
	const openPrompt = facts.promptTokens === void 0 && !!period.contextTiers?.length;
	const openReasoning = facts.usedReasoning === void 0;
	if (!openPrompt && !openReasoning) return;
	const key = (openPrompt ? 1 : 0) | (openReasoning ? 2 : 0);
	let cache = UNRULED_OUT_BY_PERIOD.get(period);
	if (!cache) {
		cache = [
			void 0,
			void 0,
			void 0,
			void 0
		];
		UNRULED_OUT_BY_PERIOD.set(period, cache);
	}
	let cards = cache[key];
	if (!cards) {
		cards = [];
		const reachable = openPrompt ? [period, ...period.contextTiers] : [period];
		for (const card of reachable) {
			if (card !== period) cards.push(card.rates);
			if (openReasoning && card.reasoningRates) cards.push(card.reasoningRates);
		}
		cache[key] = cards;
	}
	return cards.length > 0 ? cards : void 0;
}
/**
* Milliseconds of [from, to) that land inside a daily UTC peak window.
*
* O(windows + 7) — differencing the two prefix sums beats walking the range a
* day at a time, which cost ~730 iterations for a year-long window. The
* weekday count each prefix needs depends only on the boundary, so it is
* taken once rather than per window.
*/
function peakMsBetween(peak, fromMs, toMs) {
	const start = dayCountAt(fromMs, peak.daysUtc);
	const end = dayCountAt(toMs, peak.daysUtc);
	let total = 0;
	for (const [from, to] of peak.windowsUtc) {
		const startMs = from * HOUR_MS;
		const lengthMs = (to - from) * HOUR_MS;
		total += dailyWindowMsUpTo(end, startMs, lengthMs) - dailyWindowMsUpTo(start, startMs, lengthMs);
	}
	return total;
}
/**
* The rate cards a blend draws on, with the wall-clock weight each carries.
*
* Separate from `blendRates` because the weighted average throws away the
* one thing that says how rough it is: the cards it averaged. Keeping them
* is what lets an estimate report the interval its true cost must lie in.
*/
function blendParts(schedule, fromMs, toMs, facts = NOTHING_KNOWN) {
	const start = blendStart(fromMs, toMs);
	if (!(toMs > start)) return [{
		rates: ratesAt(schedule, start, facts),
		weight: 1
	}];
	return partsFor(weightedPeriods(schedule, start, toMs), facts);
}
/**
* The weighted cards a set of already-clipped segments pays.
*
* Split from `blendParts` so `ratesFor` can walk the periods once and feed
* the same segments to all three things that need them — the weights, the
* tier claim, and the bound cards. Passing the walk around rather than
* repeating it is what actually makes them agree; two calls with matching
* arguments only makes them agree today.
*/
function partsFor(segments, facts) {
	const parts = [];
	for (const { period, from, to } of segments) {
		const span = to - from;
		if (period.peak) {
			const peakMs = peakMsBetween(period.peak, from, to);
			parts.push({
				rates: period.peak.rates,
				weight: peakMs
			}, {
				rates: period.rates,
				weight: span - peakMs
			});
		} else parts.push({
			rates: variantOf(contextTierFor(period, facts.promptTokens) ?? period, facts.usedReasoning),
			weight: span
		});
	}
	return parts;
}
/**
* Degraded path: the row is a sum over a whole window, so we no longer know
* which hours its tokens were spent in. Blend the schedule across the
* window by wall-clock time — i.e. assume usage is spread evenly. That is
* wrong for a user who only ever codes during peak hours, but it is
* bounded (never outside [off-peak, peak]) and it is the honest answer when
* the time axis has already been aggregated away. Callers that *do* have a
* timestamp pass `at` instead and get the exact rate.
*/
function blendRates(schedule, fromMs, toMs, facts) {
	return weightedRates(blendParts(schedule, fromMs, toMs, facts));
}
const FLAT_RESOLUTION = /* @__PURE__ */ new WeakMap();
/**
* Build a `ResolvedRates` with every field present, in one order.
*
* One shape across every return site, so the fields `estimate` and
* `priceCardFor` read once per row are a monomorphic load rather than four
* hidden classes. Costs nothing either way, and it keeps the four sites from
* drifting apart.
*/
function resolved(rates, basis, cards, tierAbove, reasoningMode) {
	return {
		rates,
		basis,
		cards,
		tierAbove,
		reasoningMode
	};
}
/**
* Resolve a schedule to the one flat rate card that applies, either at an
* instant (`at`) or averaged across a window. Both are ignored for models
* with a flat schedule, which is nearly all of them.
*/
function ratesFor(schedule, at, window, now = Date.now(), facts = NOTHING_KNOWN) {
	if (!isTimeSensitive(schedule)) {
		const period = schedule.periods[0];
		if (!period.contextTiers?.length && !period.reasoningRates) {
			let only = FLAT_RESOLUTION.get(period);
			if (!only) {
				only = resolved(period.rates, "flat", void 0, void 0, void 0);
				FLAT_RESOLUTION.set(period, only);
			}
			return only;
		}
		return resolveCard(period, void 0, "flat", facts);
	}
	const atMs = toMs(at);
	if (atMs !== null) return exactAt(schedule, atMs, facts);
	const from = window ? toMs(window[0]) : null;
	const until = window ? toMs(window[1]) : null;
	if (from === null && until === null) return exactAt(schedule, now, facts);
	const begin = from ?? Number.NEGATIVE_INFINITY;
	const end = until ?? now;
	if (begin === end) return exactAt(schedule, begin, facts);
	const [lo, hi] = begin > end ? [end, begin] : [begin, end];
	const segments = weightedPeriods(schedule, blendStart(lo, hi), hi);
	const parts = partsFor(segments, facts);
	const cards = [];
	for (const part of parts) if (part.weight > 0) cards.push(part.rates);
	for (const { period } of segments) {
		const unruled = unruledOutCards(period, facts);
		if (unruled) cards.push(...unruled);
	}
	return resolved(weightedRates(parts), "blended", cards, facts.promptTokens === void 0 ? void 0 : blendedTierAbove(segments, facts.promptTokens), blendedReasoningMode(segments, facts));
}
/**
* One period resolved to one card, with what that card claims to be.
*
* Shared by the flat path and `exactAt`, which differ only in whether a peak
* window can apply: they were the same three questions asked twice, and a rule
* added to one of them would have quietly missed the other.
*/
function resolveCard(period, atMs, basis, facts) {
	const rates = cardFor(period, atMs, facts);
	const tier = contextTierFor(period, facts.promptTokens);
	return resolved(rates, basis, unruledOutCards(period, facts), tier?.abovePromptTokens, rates === (tier ?? period).reasoningRates ? true : void 0);
}
/** The one card in force at an instant, plus what it claims to be. */
function exactAt(schedule, atMs, facts) {
	return resolveCard(periodAt(schedule, atMs), atMs, "exact", facts);
}
/**
* Whether every weighted segment charged the thinking variant, so a blend can
* honestly say it was applied.
*/
function blendedReasoningMode(segments, facts) {
	if (!facts.usedReasoning) return;
	for (const { period } of segments) if (!(contextTierFor(period, facts.promptTokens) ?? period).reasoningRates) return;
	return true;
}
/**
* The tier a blended card can honestly claim: the common one, or none.
*
* A window spanning the day Anthropic withdrew its >200k premium averages a
* tiered period with an untiered one, and the result is neither. Reporting
* the tier there would name a rate the row did not pay.
*/
function blendedTierAbove(segments, promptTokens) {
	const first = segments[0];
	if (!first) return;
	const common = contextTierFor(first.period, promptTokens)?.abovePromptTokens;
	for (let i = 1; i < segments.length; i++) if (contextTierFor(segments[i].period, promptTokens)?.abovePromptTokens !== common) return;
	return common;
}
//#endregion
//#region src/normalize.ts
/**
* The first rate on this schedule that cannot be billed, or null.
*
* A rate has to be finite and non-negative to mean anything. Neither
* failure is hypothetical:
*
* - **Negative.** OpenRouter quotes `-1` on the meta-models it prices only
*   at request time (`openrouter/auto` and friends). A negative rate does
*   not merely mis-price its own model — summed into a total it credits
*   back every other model's cost, so one unpriceable id can carry a whole
*   account below zero. Both catalogue adapters now reject these at parse
*   time; this catches the same value arriving through `overrides` or
*   `fallback`, which are caller-supplied and not under this package's
*   control.
* - **NaN / Infinity.** One such rate propagates through every sum it
*   reaches, so a single bad card turns an entire aggregate into NaN —
*   which loses more than a wrong number would. `costFromRates` already
*   guards its token counts this way; rates deserve the same.
*/
function unbillableRate(schedule) {
	for (const period of schedule.periods) {
		const cards = [period, ...period.contextTiers ?? []];
		for (const rates of [
			...cards.map((card) => card.rates),
			...cards.map((card) => card.reasoningRates),
			period.peak?.rates
		]) {
			if (!rates) continue;
			for (const key of RATE_KEYS) {
				const value = rates[key];
				if (!Number.isFinite(value) || value < 0) return `${key}=${value}`;
			}
		}
	}
	return null;
}
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
function normalizeSchedule(schedule, onWarn, id) {
	const unbillable = unbillableRate(schedule);
	if (unbillable !== null) {
		onWarn?.(`schedule "${id ?? schedule.displayName ?? "?"}" quotes an unbillable rate (${unbillable}) and was dropped`, void 0);
		return null;
	}
	const only = schedule.periods.length === 1 ? schedule.periods[0] : void 0;
	if (only && !only.peak && only.from === Number.NEGATIVE_INFINITY) {
		const gated = normalizeTiers(only, onWarn, id);
		warnIfUnanchored(schedule, onWarn, id);
		return gated === only ? schedule : {
			...schedule,
			periods: [gated]
		};
	}
	const usable = schedule.periods.filter((period) => !Number.isNaN(period.from));
	if (usable.length === 0) {
		onWarn?.(`schedule "${id ?? schedule.displayName ?? "?"}" has no usable periods and was dropped`, void 0);
		return null;
	}
	usable.sort((a, b) => a.from - b.from);
	const periods = usable.map((period) => {
		if (!period.peak) return normalizeTiers(period, onWarn, id);
		const windowsUtc = normalizeWindows(period.peak.windowsUtc);
		const daysUtc = normalizeDays(period.peak.daysUtc);
		return windowsUtc.length === 0 || daysUtc?.length === 0 ? normalizeTiers({
			...period,
			peak: void 0
		}, onWarn, id) : normalizeTiers({
			...period,
			peak: {
				windowsUtc,
				daysUtc,
				rates: period.peak.rates
			}
		}, onWarn, id);
	});
	const first = periods[0];
	if (first.from !== Number.NEGATIVE_INFINITY) {
		onWarn?.(`schedule "${id ?? schedule.displayName ?? "?"}" begins at ${new Date(first.from).toISOString()}; opening it at -infinity so earlier rows still price`, void 0);
		periods[0] = {
			...first,
			from: Number.NEGATIVE_INFINITY
		};
	}
	const result = {
		...schedule,
		periods
	};
	warnIfUnanchored(result, onWarn, id);
	return result;
}
/**
* A time-sensitive schedule with no `sqlMatch` still prices correctly when
* the caller passes `at`, but the query layer is never told to split its rows
* by hour, so in practice they all blend. The type says the field is
* required; this is what says so at runtime.
*/
function warnIfUnanchored(schedule, onWarn, id) {
	if (!onWarn || !isTimeSensitive(schedule) || schedule.sqlMatch?.length) return;
	onWarn(`schedule "${id ?? schedule.displayName ?? "?"}" varies with time but declares no sqlMatch, so its rows cannot be anchored to an hour`, void 0);
}
/**
* Bring a period's long-context tiers to the shape `contextTierFor` assumes,
* or strip them.
*
* Returned by identity when there is nothing to change, so the common case —
* no tiers at all, or upstream's already-sorted list — allocates nothing and
* lets the bundled tables stay shared.
*
* Three rules, each guarding a way a bad tier costs more than no tier:
*
* - **Never alongside `peak`.** The two dimensions are independent and no
*   vendor publishes both, so a period carrying both is malformed rather
*   than expressive. Keeping the peak is the safer half to keep: it applies
*   to every request inside its hours, where a tier applies only to
*   unusually long ones.
* - **Thresholds must be positive and finite.** A threshold of 0 makes the
*   "tier" the base rate for every request, silently doubling an entire
*   vendor's bill.
* - **Ascending, and one card per threshold.** `contextTierFor` stops at the
*   first threshold the prompt fails, so an unsorted list can return a
*   cheaper tier than the one that applies.
*/
function normalizeTiers(period, onWarn, name = "?") {
	const tiers = period.contextTiers;
	if (!tiers || tiers.length === 0) return tiers ? {
		...period,
		contextTiers: void 0
	} : period;
	if (period.peak) {
		onWarn?.(`schedule "${name}" prices both a peak window and a long-context tier; keeping the peak and dropping the tier, since no vendor publishes both`, void 0);
		return {
			...period,
			contextTiers: void 0
		};
	}
	const usable = tiers.filter((tier) => Number.isFinite(tier.abovePromptTokens) && tier.abovePromptTokens > 0);
	if (usable.length !== tiers.length) onWarn?.(`schedule "${name}" has ${tiers.length - usable.length} long-context tier(s) with an unusable threshold; dropped`, void 0);
	const sorted = (usable.length === tiers.length ? [...usable] : usable).sort((a, b) => a.abovePromptTokens - b.abovePromptTokens);
	const deduped = sorted.filter((tier, i) => {
		const clash = i > 0 && sorted[i - 1].abovePromptTokens === tier.abovePromptTokens;
		if (clash) onWarn?.(`schedule "${name}" quotes two long-context tiers above ${tier.abovePromptTokens} tokens; keeping the first`, void 0);
		return !clash;
	});
	if (deduped.length === 0) return {
		...period,
		contextTiers: void 0
	};
	return deduped.length === tiers.length && deduped.every((tier, i) => tier === tiers[i]) ? period : {
		...period,
		contextTiers: deduped
	};
}
/**
* Clamp peak windows to real UTC hours and merge them into a disjoint set.
*
* `peakMsBetween` sums each window independently, so overlapping windows
* count their shared hours twice and a reversed one contributes a *negative*
* duration. Either way the blended rate escapes [off-peak, peak], which is
* the one guarantee blending makes.
*/
function normalizeWindows(windows) {
	const clamped = windows.map(([start, end]) => [Math.max(0, Math.min(24, Math.floor(start))), Math.max(0, Math.min(24, Math.ceil(end)))]).filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
	const merged = [];
	for (const [start, end] of clamped) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}
/**
* Reduce peak weekdays to a deduplicated set of real UTC weekdays, or
* `undefined` for "every day" — the shape a vendor without a weekday rule
* publishes, and the one the hot path skips the day check for entirely.
*
* Deduplicated and sorted so that one weekday rule has one representation —
* two schedules that mean "weekdays" compare equal whichever order they were
* written in. The blend arithmetic counts its own distinct days rather than
* relying on that, so a duplicate is a tidiness problem, not a pricing one.
*/
function normalizeDays(days) {
	if (days === void 0) return;
	const seen = new Set(days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6));
	return seen.size === 7 ? void 0 : [...seen].sort((a, b) => a - b);
}
//#endregion
//#region src/resolve.ts
const VENDOR_PREFIX_BY_FAMILY = [
	{
		test: (n) => n.startsWith("claude-"),
		prefix: "anthropic/"
	},
	{
		test: (n) => n.startsWith("gpt-") || n.startsWith("o1-") || n.startsWith("o3-") || n.startsWith("o4-"),
		prefix: "openai/"
	},
	{
		test: (n) => n.startsWith("deepseek-"),
		prefix: "deepseek/"
	},
	{
		test: (n) => n.startsWith("glm-"),
		prefix: "z-ai/"
	},
	{
		test: (n) => n.startsWith("grok-"),
		prefix: "x-ai/"
	},
	{
		test: (n) => n.startsWith("gemini-"),
		prefix: "google/"
	},
	{
		test: (n) => n.startsWith("llama-"),
		prefix: "meta-llama/"
	},
	{
		test: (n) => n.startsWith("qwen"),
		prefix: "qwen/"
	},
	{
		test: (n) => n.startsWith("mistral-") || n.startsWith("codestral-"),
		prefix: "mistralai/"
	}
];
const DASHED_VENDOR_SEGMENTS = [
	"x-ai",
	"z-ai",
	"meta-llama",
	"zai-org",
	"google-vertex",
	"amazon-bedrock",
	"azure-cognitive-services"
];
/**
* `claude-opus-4-7` -> `claude-opus-4.7`. The lookahead keeps the regex from
* chewing through 8-digit date suffixes.
*/
function dotted(s) {
	return s.replaceAll(/(\D)(\d+)-(\d+)(?=-|$)/g, "$1$2.$3");
}
/**
* The inverse: `anthropic/claude-opus-4.7` -> `claude-opus-4-7`. Catalogue
* ids use dots, so a caller who passes one straight through would otherwise
* miss every dash-keyed table (the snapshot included) and silently price
* at $0.
*/
function undotted(s) {
	return s.replaceAll(/(\d)\.(\d)/g, "$1-$2");
}
const DOTTED_ID_PREFIXES = /* @__PURE__ */ new Set([
	"us",
	"eu",
	"apac",
	"us-gov",
	"anthropic",
	"meta",
	"amazon",
	"mistral",
	"cohere",
	"ai21",
	"deepseek",
	"stability",
	"writer",
	"luma",
	"twelvelabs",
	"qwen"
]);
/**
* Strip the decoration a hosting platform or gateway wraps around a
* vendor's model id, leaving the id the price catalogues actually use.
*
* Everything here is still only a *candidate* — probed as an exact key, so
* an over-eager strip misses rather than mis-prices.
*/
function unwrapPlatformId(model) {
	let id = model;
	id = id.replace(/-v\d+:\d+$/, "");
	id = id.replace(/@\d{4,8}$/, "");
	if (!id.endsWith(":free")) id = id.replace(/:[a-z][\w-]*$/, "");
	if (id.includes("/")) id = id.slice(id.lastIndexOf("/") + 1);
	let dot = id.indexOf(".");
	while (dot > 0 && DOTTED_ID_PREFIXES.has(id.slice(0, dot))) {
		id = id.slice(dot + 1);
		dot = id.indexOf(".");
	}
	return id;
}
function pricingCandidates(model) {
	const set = /* @__PURE__ */ new Set();
	const add = (s) => {
		if (!s) return;
		set.add(s);
		const stripped = s.replace(/^[^/]+\//, "");
		set.add(stripped);
		for (const { test, prefix } of VENDOR_PREFIX_BY_FAMILY) if (test(stripped)) set.add(`${prefix}${stripped}`);
	};
	const addAllForms = (form) => {
		const untagged = form.replace(/-\d{4}-\d{2}-\d{2}$/, "").replace(/-(?:\d{4}|\d{6}|\d{8}|latest)$/, "");
		for (const variant of [form, untagged]) {
			add(variant);
			add(dotted(variant));
			add(undotted(variant));
		}
	};
	const base = model.toLowerCase().trim().replace(/\/+$/, "");
	addAllForms(base);
	const deparenthesized = base.replace(/\s*\([^)]*\)\s*$/, "").trim();
	if (deparenthesized && deparenthesized !== base) addAllForms(deparenthesized);
	const withoutLeadingSegment = base.slice(base.indexOf("-") + 1);
	if (base.includes("-") && withoutLeadingSegment) addAllForms(withoutLeadingSegment);
	for (const vendor of DASHED_VENDOR_SEGMENTS) if (base.startsWith(`${vendor}-`)) addAllForms(base.slice(vendor.length + 1));
	const unwrapped = unwrapPlatformId(base);
	if (unwrapped !== base) addAllForms(unwrapped);
	return [...set];
}
//#endregion
//#region src/catalog/modelsdev.ts
const MODELS_DEV_URL = "https://models.dev/api.json";
const DEFAULT_PROVIDER_PRIORITY = [
	"anthropic",
	"openai",
	"google",
	"deepseek",
	"xai",
	"meta",
	"mistral",
	"cohere",
	"alibaba",
	"zai",
	"moonshotai",
	"llama",
	"google-vertex",
	"amazon-bedrock",
	"azure"
];
/**
* Whether a models.dev cost block may be priced against at all.
*
* The single definition of what is allowed into either the live index or the
* archive — both read the same payload, and a rule enforced in only one of
* them lets a row upstream rejects live still be written to disk forever.
*/
function isUsableCost(cost) {
	if (!cost) return false;
	const { input, output } = cost;
	if (typeof input !== "number" || typeof output !== "number") return false;
	if (!Number.isFinite(input) || !Number.isFinite(output)) return false;
	if (input < 0 || output < 0) return false;
	return input > 0 || output > 0;
}
/**
* The cache rates a cost block implies, in whatever unit `divisor` selects
* (1e6 for per-token, 1 to stay per-MTok as the archive does).
*
* Absent `cache_write` falls back to `cache_read`, absent `cache_read` to 10%
* of input — the same convention the OpenRouter adapter applies. Shared so
* the live index and the archive cannot default differently and turn one
* quote into two.
*/
function cacheRatesFrom(cost, divisor) {
	const input = cost.input / divisor;
	const cacheRead = typeof cost.cache_read === "number" && Number.isFinite(cost.cache_read) ? cost.cache_read / divisor : input * .1;
	return {
		cacheRead,
		cacheWrite: typeof cost.cache_write === "number" && Number.isFinite(cost.cache_write) ? cost.cache_write / divisor : cacheRead
	};
}
/** The five rates a models.dev cost block implies, in `divisor`'s unit. */
function ratesFromCost(cost, divisor) {
	const { cacheRead, cacheWrite } = cacheRatesFrom(cost, divisor);
	return {
		inputCostPerToken: cost.input / divisor,
		cacheCreationInputCostPerToken: cacheWrite,
		cacheReadInputCostPerToken: cacheRead,
		cachedInputCostPerToken: cacheRead,
		outputCostPerToken: cost.output / divisor
	};
}
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
function tierRatesFrom(base, tier, divisor) {
	return ratesFromCost(inheritTierGaps(base, tier), divisor);
}
/** A tier's cost block with the rates it omits filled in from the base. */
function inheritTierGaps(base, tier) {
	const ratio = typeof base.input === "number" && base.input > 0 ? tier.input / base.input : null;
	const scaled = (from) => ratio !== null && typeof from === "number" && Number.isFinite(from) ? from * ratio : void 0;
	return {
		...tier,
		cache_read: quoted(tier.cache_read) ?? scaled(base.cache_read),
		cache_write: quoted(tier.cache_write) ?? scaled(base.cache_write)
	};
}
/** A rate the tier states in its own right, or undefined. */
function quoted(rate) {
	return typeof rate === "number" && Number.isFinite(rate) ? rate : void 0;
}
/**
* The thinking-mode card a models.dev cost block declares, or undefined.
*
* `cost.reasoning` carries two incompatible meanings upstream, and the data
* itself separates them — no provider list required:
*
* - **Dearer than output (23 listings, every one a qwen model).** Alibaba's
*   thinking-mode output price, which its own table heads 思维链+回答 — chain
*   of thought AND answer. It replaces the card for the whole response, which
*   is exactly what this returns. `qwen-plus` is $1.2/MTok of output normally
*   and $4 in thinking mode; models.dev's figures match Alibaba's published
*   table to the cent for both its regions.
* - **Cheaper than output (6 listings, all of one model).** Perplexity's
*   `sonar-deep-research` bills reasoning tokens at $3/MTok *in addition to*
*   $8/MTok output. Treating that as a replacement would price a whole
*   response at $3 and undercharge by 62%, so it is ignored — a per-token
*   reasoning rate is a fifth priced quantity this package does not model, and
*   ignoring it undercharges only the reasoning tokens.
*
* `reasoning: 0` (17 listings, all one router's placeholder ids) is rejected by
* the same rule, which matters more than it looks: applied literally it would
* make thinking output free, turning the dearest requests into the cheapest.
*
* Only the output rate moves. Alibaba charges the same input rate either way,
* and `cost.reasoning` is a single number with nothing to say about the rest of
* the card.
*/
function reasoningRatesFrom(cost, base, divisor) {
	const { reasoning, output } = cost;
	if (typeof reasoning !== "number" || !Number.isFinite(reasoning) || typeof output !== "number") return;
	if (!(reasoning > output)) return;
	return {
		...base,
		outputCostPerToken: reasoning / divisor
	};
}
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
function contextTiersFrom(cost, divisor) {
	const tiers = [];
	for (const tier of cost.tiers ?? []) {
		const size = tier.tier?.size;
		if (tier.tier?.type !== "context" || typeof size !== "number" || !Number.isFinite(size) || size <= 0) continue;
		if (!isUsableCost(tier)) continue;
		const rates = tierRatesFrom(cost, tier, divisor);
		tiers.push({
			abovePromptTokens: size,
			rates,
			reasoningRates: reasoningRatesFrom(tier, rates, divisor)
		});
	}
	if (tiers.length === 0) return;
	return tiers.sort((a, b) => a.abovePromptTokens - b.abovePromptTokens);
}
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
function parseModelsDev(json, options = {}) {
	const priority = options.providerPriority ?? DEFAULT_PROVIDER_PRIORITY;
	const rank = new Map(priority.map((id, i) => [id, i]));
	const providers = Object.keys(json).sort((a, b) => {
		const ra = rank.get(a) ?? Number.POSITIVE_INFINITY;
		const rb = rank.get(b) ?? Number.POSITIVE_INFINITY;
		return ra === rb ? a.localeCompare(b) : ra - rb;
	});
	const map = /* @__PURE__ */ new Map();
	const compound = /* @__PURE__ */ new Map();
	for (const providerId of providers) {
		const models = json[providerId]?.models;
		if (!models) continue;
		for (const [modelId, model] of Object.entries(models)) {
			const cost = model?.cost;
			if (!isUsableCost(cost)) continue;
			const rates = ratesFromCost(cost, 1e6);
			const schedule = {
				displayName: typeof model.name === "string" ? model.name : void 0,
				source: "modelsdev",
				providerId,
				tier: rank.has(providerId) ? 0 : 1,
				periods: [{
					from: Number.NEGATIVE_INFINITY,
					rates,
					reasoningRates: reasoningRatesFrom(cost, rates, 1e6),
					contextTiers: contextTiersFrom(cost, 1e6)
				}]
			};
			const bare = modelId.toLowerCase();
			map.set(`${providerId.toLowerCase()}/${bare}`, schedule);
			if (bare.includes("/")) {
				if (!compound.has(bare)) compound.set(bare, {
					...schedule,
					tier: 1
				});
			} else if (!map.has(bare)) map.set(bare, schedule);
		}
	}
	for (const [key, schedule] of compound) if (!map.has(key)) map.set(key, schedule);
	return map;
}
//#endregion
//#region src/catalog/openrouter.ts
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
/**
* Turn an OpenRouter `/models` payload into a lookup keyed by both the full
* `vendor/model` id and the bare model name.
*
* The bare-name index is what lets any vendor resolve without a
* hand-written prefix rule: callers store model ids without OpenRouter's
* mandatory `vendor/` prefix. Bare names cannot collide with full ids —
* those always contain a slash — and first-wins keeps a future duplicate
* bare name from silently flipping an already-resolved price.
*/
/**
* A quoted rate, or null when the field is absent, unparseable, or
* negative.
*
* `parseFloat(x) || fallback` cannot tell "free" from "missing", and a
* quoted $0 cache read is real — implicit caching is free on some vendors,
* and 19 of OpenRouter's 413 listings quote 0/0 in earnest (16 carry the
* `:free` suffix; the rest are `openrouter/free` and the Lyria models,
* which bill per second rather than per token). Reading those as missing
* bills their reads at 10% of input.
*
* A negative quote is neither free nor missing. OpenRouter uses `-1` as a
* sentinel on the meta-models whose endpoint — and therefore price — the
* router only picks at request time: `openrouter/auto`, `auto-beta`,
* `fusion`, `pareto-code`, `bodybuilder`. Taken literally that is a rate
* of minus one dollar per token, which does not merely mis-price its own
* model — summed into a total it credits back everything else. Measured
* against a real store, 14 aggregated rows of `openrouter/auto` came to
* -$9,625,814 and turned a $645k account total negative.
*
* `parseModelsDev` has rejected negative quotes since it was written (see
* `isUsableCost`); this adapter simply missed the same rule. It stops
* short of that one's 0/0 rejection on purpose — models.dev has real
* placeholder rows quoting 0/0 to advertise availability, and OpenRouter,
* as counted above, does not.
*/
function num(value) {
	const parsed = Number.parseFloat(String(value ?? ""));
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}
function parseOpenRouterModels(json) {
	const map = /* @__PURE__ */ new Map();
	for (const model of json.data ?? []) {
		const id = model.id;
		if (!id || typeof id !== "string") continue;
		const pricing = model.pricing;
		if (!pricing || typeof pricing !== "object") continue;
		const input = num(pricing.prompt);
		const output = num(pricing.completion);
		if (input === null || output === null) continue;
		const cacheRead = num(pricing.input_cache_read) ?? input * .1;
		const cacheWrite = num(pricing.input_cache_write) ?? cacheRead;
		const key = id.toLowerCase();
		const slash = key.indexOf("/");
		const schedule = {
			displayName: typeof model.name === "string" ? model.name : void 0,
			source: "openrouter",
			providerId: slash > 0 ? key.slice(0, slash) : void 0,
			periods: [{
				from: Number.NEGATIVE_INFINITY,
				rates: {
					inputCostPerToken: input,
					cacheCreationInputCostPerToken: cacheWrite,
					cacheReadInputCostPerToken: cacheRead,
					cachedInputCostPerToken: cacheRead,
					outputCostPerToken: output
				}
			}]
		};
		map.set(key, schedule);
		const bare = key.slice(slash + 1);
		if (bare !== key && !map.has(bare)) map.set(bare, schedule);
	}
	return map;
}
//#endregion
export { FAST_BY_ID as A, scaleRates as B, pricesByRequest as C, OVERRIDES as D, toMs as E, closeEnough as F, RATE_KEYS as G, weightedRates as H, flatSchedule as I, mergeLiveQuote as L, SNAPSHOT_SYNCED_AT as M, SNAPSHOT_SYNCED_AT_MS as N, CONTEXT_TIER_MULTIPLIERS as O, withDerivedContextTiers as P, periodPricesEqual as R, periodAt as S, ratesFor as T, DAY_MS as U, scaleSchedule as V, HOUR_MS as W, blendRates as _, contextTiersFrom as a, isTimeSensitive as b, ratesFromCost as c, dotted as d, pricingCandidates as f, blendParts as g, NOTHING_KNOWN as h, MODELS_DEV_URL as i, FAST_MULTIPLIERS as j, FALLBACK as k, reasoningRatesFrom as l, normalizeSchedule as m, parseOpenRouterModels as n, isUsableCost as o, undotted as p, DEFAULT_PROVIDER_PRIORITY as r, parseModelsDev as s, OPENROUTER_MODELS_URL as t, tierRatesFrom as u, contextTierFor as v, ratesAt as w, peakMsBetween as x, isPeakHour as y, ratesEqual as z };
