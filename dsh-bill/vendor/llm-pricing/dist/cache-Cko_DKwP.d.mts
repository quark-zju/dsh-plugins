//#region src/cache.d.ts
/**
 * Somewhere to keep a fetched catalogue between process lifetimes.
 *
 * Deliberately a two-method string store, so a filesystem, Redis, a
 * Cloudflare KV namespace or a test double all satisfy it without an
 * adapter. TTL is handled by the catalogue, not the store — entries carry
 * their own timestamp — so a dumb `Map` is a complete implementation.
 *
 * Keys are source URLs. Values are opaque; do not parse them.
 */
interface PricingCache {
  get: (key: string) => Promise<string | null | undefined> | string | null | undefined;
  set: (key: string, value: string) => Promise<void> | void;
}
/**
 * An in-process cache. Useful for tests and for sharing one download
 * between several `PricingCatalog` instances in the same process; it buys
 * nothing across restarts — use a file or KV store for that.
 */
declare function memoryCache(store?: Map<string, string>): PricingCache;
//#endregion
export { memoryCache as n, PricingCache as t };