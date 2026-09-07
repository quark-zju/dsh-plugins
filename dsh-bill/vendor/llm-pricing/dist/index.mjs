import { A as FAST_BY_ID, C as pricesByRequest, D as OVERRIDES, E as toMs, G as RATE_KEYS, L as mergeLiveQuote, M as SNAPSHOT_SYNCED_AT, N as SNAPSHOT_SYNCED_AT_MS, P as withDerivedContextTiers, T as ratesFor, V as scaleSchedule, b as isTimeSensitive, f as pricingCandidates, h as NOTHING_KNOWN, i as MODELS_DEV_URL, k as FALLBACK, m as normalizeSchedule, n as parseOpenRouterModels, r as DEFAULT_PROVIDER_PRIORITY, s as parseModelsDev, t as OPENROUTER_MODELS_URL } from "./openrouter-DTNSwOUG.mjs";
//#region src/cache.ts
function encodeCacheEntry(fetchedAt, body) {
	return JSON.stringify({
		fetchedAt,
		body
	});
}
function decodeCacheEntry(raw) {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (typeof parsed.body !== "string" || typeof parsed.fetchedAt !== "number") return null;
		return {
			fetchedAt: parsed.fetchedAt,
			body: parsed.body
		};
	} catch {
		return null;
	}
}
/**
* An in-process cache. Useful for tests and for sharing one download
* between several `PricingCatalog` instances in the same process; it buys
* nothing across restarts — use a file or KV store for that.
*/
function memoryCache(store = /* @__PURE__ */ new Map()) {
	return {
		get: (key) => store.get(key) ?? null,
		set: (key, value) => {
			store.set(key, value);
		}
	};
}
//#endregion
//#region src/estimate.ts
/**
* Anthropic prices a 1-hour ephemeral cache write at 2x input, vs the
* default 5-minute write at 1.25x input (the latter is what
* `cacheCreationInputCostPerToken` already encodes).
*/
const CACHE_CREATE_1H_INPUT_MULTIPLIER = 2;
/**
* A token count, or 0 for anything that is not a usable one.
*
* Negatives are a caller bug that would *subtract* from the bill, and NaN
* or Infinity propagates through every sum it reaches — one bad row turns a
* whole aggregate into NaN, which loses more than a wrong number would.
* Both become 0, the value a missing count already had.
*
* Coerced rather than type-checked, so the counts a driver hands back —
* `bigint` for a Postgres bigint, a string for a numeric — still bill
* instead of silently reading as zero.
*/
function count(value) {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : 0;
}
function billedTokens(tokens) {
	const creation1h = count(tokens.cacheCreation1hInputTokens);
	const cacheCreation = count(tokens.cacheCreationInputTokens) || count(tokens.cacheCreation5mInputTokens) + creation1h;
	const known1h = Math.min(creation1h, cacheCreation);
	const creationDefaultRate = Math.max(0, cacheCreation - known1h);
	const cached = count(tokens.cachedInputTokens);
	const cacheRead = count(tokens.cacheReadInputTokens) || Math.max(0, cached - cacheCreation);
	const input = count(tokens.inputTokens);
	return {
		fresh: tokens.inputIncludesCache === false ? Math.max(0, input - Math.min(cached, input)) : Math.max(0, input - cacheCreation - cacheRead),
		creationDefault: creationDefaultRate,
		creation1h: known1h,
		cacheRead,
		output: count(tokens.outputTokens) + (tokens.reasoningIncludedInOutput === false ? count(tokens.reasoningOutputTokens) : 0)
	};
}
/**
* Apply a resolved rate card to a set of token counts.
*
* Pure and stateless — every catalogue/schedule decision has already been
* made by the time this runs, which is what makes it exhaustively testable.
*/
function costFromRates(rates, tokens) {
	return costFromBilled(rates, billedTokens(tokens));
}
/**
* `costFromRates` for counts that have already been reduced. The arithmetic
* lives here so the two cannot drift apart.
*/
function costFromBilled(rates, b) {
	return b.fresh * rates.inputCostPerToken + b.creationDefault * rates.cacheCreationInputCostPerToken + b.creation1h * rates.inputCostPerToken * 2 + b.cacheRead * rates.cacheReadInputCostPerToken + b.output * rates.outputCostPerToken;
}
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
function promptTokensBilled(tokens) {
	return promptOfBilled(billedTokens(tokens));
}
/** `promptTokensBilled` for counts that have already been reduced. */
function promptOfBilled(b) {
	return b.fresh + b.creationDefault + b.creation1h + b.cacheRead;
}
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
function usedReasoning(tokens) {
	return count(tokens.reasoningOutputTokens) > 0;
}
/**
* How many tokens `costFromRates` would bill for the same counts.
*
* Not the row's `total_tokens`: cache reads and fresh input are counted
* once each rather than twice, and reasoning is included only when it sits
* outside `outputTokens`. It answers "how much usage does this cost cover",
* which is what makes an unpriced row's $0 legible as a gap.
*/
function tokensBilled(tokens) {
	return totalOfBilled(billedTokens(tokens));
}
/** `tokensBilled` for counts that have already been reduced. */
function totalOfBilled(b) {
	return promptOfBilled(b) + b.output;
}
//#endregion
//#region src/row.ts
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
const PRICE_ANCHOR_COLUMN = "price_hour_epoch";
const DEFAULT_ROW_COLUMNS = {
	model: "model",
	inputTokens: "input_tokens",
	cachedInputTokens: "cached_input_tokens",
	cacheCreationInputTokens: "cache_creation_input_tokens",
	cacheCreation5mInputTokens: "cache_creation_5m_input_tokens",
	cacheCreation1hInputTokens: "cache_creation_1h_input_tokens",
	cacheReadInputTokens: "cache_read_input_tokens",
	outputTokens: "output_tokens",
	reasoningOutputTokens: "reasoning_output_tokens",
	totalTokens: "total_tokens",
	priceAnchor: PRICE_ANCHOR_COLUMN,
	promptTokens: "prompt_tokens"
};
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
function inferTokenShape(row, columns = DEFAULT_ROW_COLUMNS) {
	const reasoning = rowNum(row[columns.reasoningOutputTokens]);
	const total = rowNum(row[columns.totalTokens]);
	if (reasoning <= 0 || total <= 0) return {};
	const base = rowNum(row[columns.inputTokens]) + rowNum(row[columns.outputTokens]);
	if (total === base + reasoning) return { reasoningIncludedInOutput: false };
	if (total === base) return { reasoningIncludedInOutput: true };
	return {};
}
function rowNum(v) {
	if (v === null || v === void 0) return 0;
	const n = Number(v);
	return Number.isFinite(n) ? n : 0;
}
/**
* The anchor is documented as epoch **seconds**, and the SQL helper emits
* seconds. A caller who passes milliseconds would otherwise be priced at a
* point tens of thousands of years out — silently, and often at a
* plausible-looking rate, because the last period runs to infinity.
*
* Epoch seconds above 1e12 is the year 33658, so there is no real value to
* confuse with a millisecond timestamp.
*/
function anchorToMs(anchor) {
	return anchor > 0xe8d4a51000 ? anchor : anchor * 1e3;
}
/**
* Price a raw SQL row that uses snake_case `*_tokens` column names, so
* every cost-folding loop does not repeat the same nine coercions.
*/
function estimateCostFromRow$1(catalog, row, options = {}) {
	const { window, columns = DEFAULT_ROW_COLUMNS, shape = {}, inferShape = false, perRequest = false } = options;
	const anchor = row[columns.priceAnchor];
	const at = anchor === null || anchor === void 0 ? void 0 : anchorToMs(rowNum(anchor));
	const promptTokens = perRequest ? rowNum(row[columns.promptTokens]) || void 0 : void 0;
	return catalog.estimate({
		model: String(row[columns.model] ?? "unknown"),
		inputTokens: rowNum(row[columns.inputTokens]),
		cachedInputTokens: rowNum(row[columns.cachedInputTokens]),
		cacheCreationInputTokens: rowNum(row[columns.cacheCreationInputTokens]),
		cacheCreation5mInputTokens: rowNum(row[columns.cacheCreation5mInputTokens]),
		cacheCreation1hInputTokens: rowNum(row[columns.cacheCreation1hInputTokens]),
		cacheReadInputTokens: rowNum(row[columns.cacheReadInputTokens]),
		outputTokens: rowNum(row[columns.outputTokens]),
		reasoningOutputTokens: rowNum(row[columns.reasoningOutputTokens]),
		...shape,
		...inferShape ? inferTokenShape(row, columns) : void 0,
		at,
		window,
		perRequest,
		promptTokens
	});
}
//#endregion
//#region src/sources.ts
/**
* OpenRouter's `/models`. One quote per model, reflecting whichever
* endpoint OpenRouter would route to by default — which is NOT always the
* first-party price (see `catalog/overrides.ts`).
*/
function openRouterSource(url = OPENROUTER_MODELS_URL) {
	return {
		name: "openrouter",
		url,
		parse: (json) => parseOpenRouterModels(json)
	};
}
/**
* models.dev's `api.json` — the dataset behind llmpricing.dev. Quotes every
* provider separately, so first-party rates are actually reachable, at the
* cost of a ~4 MB payload and a provider-priority decision.
*/
function modelsDevSource(options = {}) {
	const { url = MODELS_DEV_URL, ...parseOptions } = options;
	return {
		name: "modelsdev",
		url,
		parse: (json) => parseModelsDev(json, parseOptions)
	};
}
//#endregion
//#region src/catalog.ts
const DEFAULT_REFRESH_MS = 864e5;
const DEFAULT_RETRY_MS = 3e5;
const DEFAULT_TIMEOUT_MS = 3e4;
/**
* Cap on the resolved-lookup memo. It is keyed by the raw stored model
* string, so anywhere a name reaches it from user input an unbounded Map is
* a leak that outlives every request. Cleared wholesale rather than evicted
* one at a time: the working set of a real deployment is a few hundred
* names, so hitting this at all means the keys are not model names.
*/
const RESOLVED_LIMIT = 5e4;
/** Normalise a whole table, dropping the schedules that cannot price. */
function normalizeTable(table, onWarn) {
	const out = {};
	for (const [id, schedule] of Object.entries(table)) {
		const normalized = normalizeSchedule(schedule, onWarn, id);
		if (normalized) out[id] = normalized;
	}
	return out;
}
var PricingCatalog = class {
	sources;
	refreshMs;
	retryMs;
	cache;
	cacheTtlMs;
	fetchImpl;
	timeoutMs;
	overrides;
	fallback;
	onWarn;
	archiveObservedAt;
	loadedAt = 0;
	failedAt = 0;
	status = "missing";
	sourceName = "fallback";
	remote = /* @__PURE__ */ new Map();
	inflight = null;
	/**
	* Resolved lookups, keyed by the raw stored model string. A dashboard
	* request resolves thousands of rows across a handful of distinct models,
	* and every miss re-runs the whole candidate expansion. Invalidated
	* wherever `remote` is reassigned.
	*/
	resolved = /* @__PURE__ */ new Map();
	/** Entries currently memoised. Exposed for tests and diagnostics. */
	get resolvedSize() {
		return this.resolved.size;
	}
	constructor(options = {}) {
		this.onWarn = options.onWarn ?? ((message, error) => {
			console.warn(`[llm-pricing] ${message}:`, error instanceof Error ? error.message : error);
		});
		this.sources = options.sources ?? [modelsDevSource()];
		this.refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
		this.retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
		this.cache = options.cache;
		this.cacheTtlMs = options.cacheTtlMs ?? this.refreshMs;
		this.fetchImpl = options.fetch ?? globalThis.fetch;
		this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.overrides = normalizeTable({
			...OVERRIDES,
			...options.overrides
		}, this.onWarn);
		this.fallback = normalizeTable({
			...FALLBACK,
			...options.fallback
		}, this.onWarn);
		this.archiveObservedAt = options.archiveObservedAt ?? SNAPSHOT_SYNCED_AT_MS;
	}
	/**
	* Every LIKE pattern a query layer must split by UTC hour, derived from
	* the schedules themselves so the two can never drift: a vendor that
	* gains a peak schedule declares `sqlMatch` next to its periods and the
	* query layer follows automatically.
	*/
	timeSensitiveSqlPatterns() {
		return [.../* @__PURE__ */ new Set([...[...Object.values(this.overrides), ...Object.values(this.fallback)].filter((schedule) => isTimeSensitive(schedule)).flatMap((schedule) => schedule.sqlMatch ?? []), ...this.livePatterns])];
	}
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
	livePatterns = [];
	recomputeLivePatterns() {
		const patterns = /* @__PURE__ */ new Set();
		for (const [id, archived] of Object.entries(this.fallback)) {
			const live = this.remote.get(id);
			if (!live) continue;
			const merged = mergeLiveQuote(archived, live, this.archiveObservedAt, [`%${id}%`]);
			if (isTimeSensitive(merged)) for (const pattern of merged.sqlMatch ?? []) patterns.add(pattern);
		}
		this.livePatterns = [...patterns];
	}
	/**
	* Load the remote catalogue if it is missing or stale. Safe to call on
	* every request: it resolves immediately while fresh and de-duplicates
	* concurrent loads.
	*/
	ensureLoaded(options = {}) {
		const now = Date.now();
		if (!options.force) {
			if (this.status === "ready" && now - this.loadedAt < this.refreshMs) return Promise.resolve();
			if (this.failedAt !== 0 && now - this.failedAt < this.retryMs) return Promise.resolve();
			this.inflight ??= this.track(this.load(false));
			return this.inflight;
		}
		this.inflight = this.track((this.inflight ?? Promise.resolve()).then(async () => this.load(true)));
		return this.inflight;
	}
	/** Hold a load as the in-flight one until it settles. */
	track(load) {
		const tracked = load.finally(() => {
			if (this.inflight === tracked) this.inflight = null;
		});
		return tracked;
	}
	/**
	* Reload now, ignoring the freshness window, the failure backoff and any
	* cached copy. For a "prices look wrong" button, a deploy hook, or a cron
	* that wants the catalogue warm before traffic arrives.
	*/
	refresh() {
		return this.ensureLoaded({ force: true });
	}
	/**
	* Fetch one source, or read it from the cache when a fresh copy is
	* there. Returns the response body plus the time it was actually
	* retrieved from the network.
	*/
	async fetchSource(source, force) {
		const cached = await this.readCache(source);
		if (!force && cached && Date.now() - cached.fetchedAt < this.cacheTtlMs) return cached;
		try {
			const response = await this.withTimeout(this.fetchImpl(source.url, {
				headers: { accept: "application/json" },
				signal: AbortSignal.timeout(this.timeoutMs)
			}));
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const body = await response.text();
			const fetchedAt = Date.now();
			await this.writeCache(source, fetchedAt, body);
			return {
				body,
				fetchedAt
			};
		} catch (error) {
			if (cached) {
				this.onWarn(`source "${source.name}" unreachable, using cached copy`, error);
				return {
					...cached,
					rescued: true
				};
			}
			throw error;
		}
	}
	/**
	* Enforce the deadline ourselves as well as passing the signal.
	*
	* `AbortSignal` only helps if the fetch implementation honours it — a
	* custom or mocked one need not, and then the timeout protects nobody.
	* The timer is cleared on settle so it cannot hold the process open.
	*/
	async withTimeout(work) {
		let timer;
		try {
			return await Promise.race([work, new Promise((_, reject) => {
				timer = setTimeout(() => reject(/* @__PURE__ */ new Error(`timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
			})]);
		} finally {
			clearTimeout(timer);
		}
	}
	/**
	* A cache is an optimisation, so neither half of it may take the
	* catalogue down. A Redis client rejects when Redis is down; without
	* these guards an unreachable cache would stop the source from being
	* fetched at all, and a failed write-through would throw away a download
	* that had already succeeded.
	*/
	async readCache(source) {
		if (!this.cache) return null;
		try {
			return decodeCacheEntry(await this.cache.get(source.url));
		} catch (error) {
			this.onWarn(`cache unreadable for "${source.name}"`, error);
			return null;
		}
	}
	async writeCache(source, fetchedAt, body) {
		if (!this.cache) return;
		try {
			await this.cache.set(source.url, encodeCacheEntry(fetchedAt, body));
		} catch (error) {
			this.onWarn(`cache unwritable for "${source.name}"`, error);
		}
	}
	async load(force) {
		const merged = /* @__PURE__ */ new Map();
		const loaded = [];
		let oldestFetchedAt = Number.POSITIVE_INFINITY;
		let rescued = false;
		for (const source of this.sources) try {
			const result = await this.fetchSource(source, force);
			const parsed = source.parse(JSON.parse(result.body));
			for (const [key, schedule] of parsed) {
				if (merged.has(key)) continue;
				const normalized = normalizeSchedule(schedule, this.onWarn, key);
				if (normalized) merged.set(key, normalized);
			}
			loaded.push(source.name);
			oldestFetchedAt = Math.min(oldestFetchedAt, result.fetchedAt);
			rescued ||= result.rescued === true;
		} catch (error) {
			this.onWarn(`source "${source.name}" failed to load`, error);
		}
		const complete = loaded.length === this.sources.length && !rescued;
		if (loaded.length === 0) {
			this.status = this.status === "ready" ? "stale" : "missing";
			this.sourceName = "fallback";
			this.failedAt = Date.now();
			this.loadedAt = Date.now();
		} else {
			if (!complete) {
				for (const [key, schedule] of this.remote) if (!merged.has(key)) merged.set(key, schedule);
			}
			this.remote = merged;
			this.status = complete ? "ready" : "stale";
			this.sourceName = loaded.join("+");
			this.failedAt = complete ? 0 : Date.now();
			this.loadedAt = oldestFetchedAt;
		}
		this.resolved.clear();
		this.recomputeLivePatterns();
	}
	state() {
		return {
			status: this.status,
			loadedAt: this.loadedAt,
			source: this.sourceName,
			size: this.remote.size
		};
	}
	getSchedule(model) {
		if (!model) return null;
		const cached = this.resolved.get(model);
		if (cached !== void 0) return cached;
		const resolved = this.resolveSchedule(model);
		const schedule = resolved ? normalizeSchedule(resolved, this.onWarn, model) : null;
		if (this.resolved.size >= RESOLVED_LIMIT) this.resolved.clear();
		this.resolved.set(model, schedule);
		return schedule;
	}
	resolveSchedule(model) {
		const candidates = pricingCandidates(model);
		for (const candidate of candidates) {
			const override = this.overrides[candidate];
			if (override) return override;
		}
		for (const candidate of candidates) {
			const fast = FAST_BY_ID[candidate];
			if (fast) {
				const base = this.getSchedule(fast.base);
				return base ? scaleSchedule(base, fast.multiplier, "Fast") : null;
			}
		}
		let live = null;
		let liveTier = Number.POSITIVE_INFINITY;
		for (const candidate of candidates) {
			const fromRemote = this.remote.get(candidate);
			if (fromRemote && (fromRemote.tier ?? 1) < liveTier) {
				live = fromRemote;
				liveTier = fromRemote.tier ?? 1;
				if (liveTier === 0) break;
			}
		}
		let archived = null;
		let archivedId = "";
		for (const candidate of candidates) {
			const fallback = this.fallback[candidate];
			if (fallback) {
				archived = fallback;
				archivedId = candidate;
				break;
			}
		}
		const resolved = live ? mergeLiveQuote(archived, live, this.archiveObservedAt, archivedId ? [`%${archivedId}%`] : void 0) : archived;
		if (!resolved) return null;
		for (const candidate of candidates) {
			const derived = withDerivedContextTiers(candidate, resolved);
			if (derived !== resolved) return derived;
		}
		return resolved;
	}
	/**
	* The `pricing` block handed back per row, memoised on the rate card so a
	* request pricing thousands of rows against the same card allocates one
	* object rather than thousands. A rate card belongs to exactly one
	* schedule, so its name and provenance can never disagree.
	*/
	priceCards = /* @__PURE__ */ new WeakMap();
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
	lastBlend = /* @__PURE__ */ new WeakMap();
	/**
	* What this row says about the single request behind it — nothing at all
	* unless the caller declared it to be one.
	*
	* `promptTokens` implies `perRequest`: a caller who states the prompt length
	* has necessarily told us the row describes one prompt. `usedReasoning` is
	* always derived, never asserted by the caller, because the counts answer it
	* directly and a producer that reports no reasoning tokens has said as much.
	*/
	factsFor(args, billed) {
		if (args.promptTokens === void 0 && !args.perRequest) return NOTHING_KNOWN;
		let promptTokens;
		if (args.promptTokens === void 0) promptTokens = promptOfBilled(billed);
		else {
			const n = Number(args.promptTokens);
			promptTokens = Number.isFinite(n) && n > 0 ? n : 0;
		}
		return {
			promptTokens,
			usedReasoning: usedReasoning(args)
		};
	}
	ratesForMemo(schedule, args, facts) {
		const window = args.window;
		if (!window || !isTimeSensitive(schedule) || toMs(args.at) !== null) return ratesFor(schedule, args.at, window, Date.now(), facts);
		const a = toMs(window[0]);
		const b = toMs(window[1]);
		if (a === null || b === null) return ratesFor(schedule, args.at, window, Date.now(), facts);
		const from = Math.min(a, b);
		const to = Math.max(a, b);
		const keyed = pricesByRequest(schedule);
		const promptTokens = keyed ? facts.promptTokens : void 0;
		const usedReasoning = keyed ? facts.usedReasoning : void 0;
		const hit = this.lastBlend.get(schedule);
		if (hit && hit.from === from && hit.to === to && hit.promptTokens === promptTokens && hit.usedReasoning === usedReasoning) return hit.resolved;
		const resolved = ratesFor(schedule, void 0, window, Date.now(), facts);
		this.lastBlend.set(schedule, {
			from,
			to,
			promptTokens,
			usedReasoning,
			resolved
		});
		return resolved;
	}
	priceCardFor(schedule, resolved) {
		const cached = this.priceCards.get(resolved.rates);
		if (cached) return cached;
		const card = {
			...resolved.rates,
			displayName: schedule.displayName,
			source: schedule.source,
			providerId: schedule.providerId,
			contextTierAbove: resolved.tierAbove,
			reasoningMode: resolved.reasoningMode
		};
		this.priceCards.set(resolved.rates, card);
		return card;
	}
	/**
	* Resolve a model to the flat rate card that applies at `at` (default: now).
	*
	* `facts` selects a per-request variant, for showing what a request of that
	* shape would be charged — `{ promptTokens }` for a long-context tier,
	* `{ usedReasoning: true }` for thinking mode. Omitted, the base card is
	* returned, which is the right answer for "what does this model cost".
	*/
	getPrice(model, at, facts) {
		const schedule = this.getSchedule(model);
		if (!schedule) return null;
		return this.priceCardFor(schedule, ratesFor(schedule, at ?? Date.now(), void 0, Date.now(), facts));
	}
	/**
	* Price a set of token counts.
	*
	* An unknown model returns cost 0 with `pricing: null` — the pair is what
	* separates "we do not know" from "it was free", and `tokens` records how
	* much usage that $0 is standing in for. Feed the results to
	* `sumEstimates` rather than adding `cost` up by hand, which throws that
	* distinction away along with the basis and the cards.
	*/
	estimate(args) {
		const billed = billedTokens(args);
		const tokens = totalOfBilled(billed);
		const schedule = this.getSchedule(args.model);
		if (!schedule) return {
			cost: 0,
			pricing: null,
			basis: "flat",
			low: 0,
			high: 0,
			tokens
		};
		const resolved = this.ratesForMemo(schedule, args, this.factsFor(args, billed));
		const { rates, basis, cards } = resolved;
		const cost = costFromBilled(rates, billed);
		let low = cost;
		let high = cost;
		if (cards) for (const card of cards) {
			if (card === rates) continue;
			const bound = costFromBilled(card, billed);
			if (bound < low) low = bound;
			if (bound > high) high = bound;
		}
		return {
			cost,
			pricing: this.priceCardFor(schedule, resolved),
			basis,
			low,
			high,
			tokens
		};
	}
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
	estimateFromRow(row, options) {
		return estimateCostFromRow$1(this, row, options);
	}
};
//#endregion
//#region src/total.ts
const EMPTY = {
	cost: 0,
	low: 0,
	high: 0,
	count: 0,
	unpriced: {
		count: 0,
		tokens: 0
	},
	tokens: 0,
	byBasis: {
		flat: 0,
		exact: 0,
		blended: 0
	},
	cards: []
};
/**
* What makes two rate cards the same price: every rate, plus where it came
* from. Provenance is part of it — the same numbers reached through a
* reseller and through the vendor are the same cost but not the same fact,
* and `cards` is read to answer "what was this charged at".
*/
function cardKey(pricing) {
	let key = `${pricing.source}|${pricing.providerId ?? ""}|${pricing.displayName ?? ""}|${pricing.contextTierAbove ?? ""}|${pricing.reasoningMode ?? ""}`;
	for (const rate of RATE_KEYS) key += `|${pricing[rate]}`;
	return key;
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
function sumEstimates(estimates) {
	const total = {
		...EMPTY,
		unpriced: {
			count: 0,
			tokens: 0
		},
		byBasis: {
			flat: 0,
			exact: 0,
			blended: 0
		},
		cards: []
	};
	const cards = /* @__PURE__ */ new Map();
	const seen = /* @__PURE__ */ new Map();
	for (const estimate of estimates) {
		total.count++;
		total.cost += estimate.cost;
		total.low += estimate.low;
		total.high += estimate.high;
		total.byBasis[estimate.basis] += estimate.cost;
		if (!estimate.pricing) {
			total.unpriced.count++;
			total.unpriced.tokens += estimate.tokens;
			continue;
		}
		total.tokens += estimate.tokens;
		let key = seen.get(estimate.pricing);
		if (key === void 0) {
			key = cardKey(estimate.pricing);
			seen.set(estimate.pricing, key);
		}
		const entry = cards.get(key);
		if (entry) {
			entry.cost += estimate.cost;
			entry.count++;
		} else cards.set(key, {
			pricing: estimate.pricing,
			cost: estimate.cost,
			count: 1
		});
	}
	total.cards = [...cards.values()].sort((a, b) => b.cost - a.cost);
	return total;
}
//#endregion
//#region src/index.ts
let defaultOptions = {};
let instance = null;
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
function configureDefaultCatalog(options) {
	if (instance) throw new Error("[llm-pricing] the default catalogue is already in use; configure it before the first call, or construct your own PricingCatalog");
	defaultOptions = options;
	return getDefaultCatalog();
}
/** The shared catalogue, created on first call. */
function getDefaultCatalog() {
	instance ??= new PricingCatalog(defaultOptions);
	return instance;
}
/** See `PricingCatalog#ensureLoaded`. */
function ensurePricingLoaded() {
	return getDefaultCatalog().ensureLoaded();
}
/** See `PricingCatalog#refresh`. */
function refreshPricing() {
	return getDefaultCatalog().refresh();
}
/** See `PricingCatalog#state`. */
function pricingState() {
	return getDefaultCatalog().state();
}
/** See `PricingCatalog#getPrice`. */
function getPriceFor(model, at, facts) {
	return getDefaultCatalog().getPrice(model, at, facts);
}
/** See `PricingCatalog#estimate`. */
function estimateCostUsd(args) {
	return getDefaultCatalog().estimate(args);
}
/** See `PricingCatalog#estimateFromRow`. */
function estimateCostFromRow(row, options) {
	return getDefaultCatalog().estimateFromRow(row, options);
}
/** See `PricingCatalog#timeSensitiveSqlPatterns`. */
function timeSensitiveSqlPatterns() {
	return getDefaultCatalog().timeSensitiveSqlPatterns();
}
//#endregion
export { CACHE_CREATE_1H_INPUT_MULTIPLIER, DEFAULT_PROVIDER_PRIORITY, DEFAULT_ROW_COLUMNS, PRICE_ANCHOR_COLUMN, PricingCatalog, RATE_KEYS, SNAPSHOT_SYNCED_AT, SNAPSHOT_SYNCED_AT_MS, configureDefaultCatalog, costFromRates, ensurePricingLoaded, estimateCostFromRow, estimateCostUsd, getDefaultCatalog, getPriceFor, inferTokenShape, memoryCache, modelsDevSource, openRouterSource, pricingCandidates, pricingState, promptTokensBilled, refreshPricing, sumEstimates, timeSensitiveSqlPatterns, tokensBilled, usedReasoning };
