import { t as PricingCache } from "./cache-Cko_DKwP.mjs";
//#region src/node.d.ts
/**
 * A catalogue cache backed by files on disk.
 *
 * Survives restarts, and is shared by every process pointed at the same
 * directory — a PM2 cluster downloads the catalogue once rather than once
 * per worker.
 *
 * Writes are atomic (write to a temp name, then rename), so a process
 * killed mid-write leaves the previous entry intact rather than a
 * truncated one. A missing, unreadable or corrupt file is a cache miss.
 */
declare function fileCache(dir?: string): PricingCache;
//#endregion
export { fileCache };