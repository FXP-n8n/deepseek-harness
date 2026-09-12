/**
 * Cache for aggregated `tools/list` descriptors, keyed by server namespace and
 * authorization context.
 *
 * Modern (`2026-07-28`) list results carry `ttlMs` and `cacheScope`; the
 * bridge serves a cached generation for that freshness window instead of
 * re-draining pagination on every synchronization. The key always includes an
 * authorization digest, so a result is never shared between two
 * authorization contexts — a server's `public` grant is honored as
 * "cacheable", never widened into cross-tenant reuse, because the bridge
 * cannot verify a server's authorization-independence claim.
 *
 * Entries hold raw wire descriptors, not client-bound `ToolDefinition`s: a
 * reconnect reuses the descriptors and rebuilds definitions against the new
 * client generation.
 *
 * @module
 */

import { createHash } from 'node:crypto'
import type { Config } from './index.ts'

/** One server-advertised tool as it arrived on the wire, stripped of client binding. */
export interface CachedTool {
  /** MCP wire tool name. */
  name: string
  /** Server-provided description, when present. */
  description: string | undefined
  /** Advertised input schema. */
  inputSchema: Record<string, unknown>
  /** Advertised structured-output schema, when present, in its raw wire form. */
  outputSchema: unknown
  /** Whether the tool declares that task-based execution is required. */
  taskSupportRequired: boolean
}

/** One cached generation of a server's tool list. */
export interface CachedToolList {
  /** Ordered descriptors of the aggregated list. */
  tools: CachedTool[]
  /** Epoch milliseconds after which the entry is stale. */
  expiresAt: number
  /** Server-declared sharing scope, normalized to the spec's closed set. */
  cacheScope: 'public' | 'private'
}

/**
 * Resource bound on the process-wide store. Keys are configuration-derived
 * `(serverName, authorization)` pairs, so this cap is a memory guard against
 * HMR or credential churn, not a deployment-varying policy.
 */
const MAX_ENTRIES = 64

/**
 * Digest one transport configuration's credential-bearing identity. Hashing
 * keeps raw headers and environment values out of the cache while still
 * separating two authorization contexts on the same server namespace.
 *
 * @param config - Resolved plugin config.
 * @returns A stable hex digest of the transport's identity material.
 */
export function authorizationDigest(config: Config): string {
  // Key order must not change the digest; a record cannot repeat a key, so the
  // comparator never sees equal keys.
  const entries = (record: Record<string, string>): string[][] =>
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1))
  const material = config.transport === 'stdio'
    ? JSON.stringify(['stdio', config.command, config.args, config.cwd, entries(config.env)])
    : JSON.stringify(['streamable-http', config.url, entries(config.headers)])
  return createHash('sha256').update(material).digest('hex')
}

/**
 * Normalize a server-declared `cacheScope`. Anything other than the spec's
 * `public` reads as `private`, the conservative default.
 *
 * @param value - Untrusted value read off the wire result.
 * @returns The normalized scope.
 */
export function normalizeCacheScope(value: unknown): 'public' | 'private' {
  return value === 'public' ? 'public' : 'private'
}

/**
 * Normalize a server-declared `ttlMs`. Absent, non-integer, or non-positive
 * values are the spec's "immediately stale" and disable serving.
 *
 * @param value - Untrusted value read off the wire result.
 * @returns The freshness window in milliseconds, or 0 when not cacheable.
 */
export function normalizeCacheTtlMs(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0
}

/**
 * Process-wide store shared by every mcp-client instance, so two Agent scopes
 * configured for the same server namespace reuse within one authorization and
 * never leak across authorizations. Keys embed both dimensions; a server
 * cannot craft a namespace that collides with another's because the key is a
 * fixed-length digest joined to the validated `serverName`.
 */
class ToolListCache {
  private readonly entries = new Map<string, CachedToolList>()

  /**
   * Serve a still-fresh generation.
   *
   * @param serverName - Validated plugin namespace.
   * @param authorization - Digest from {@link authorizationDigest}.
   * @param now - Current epoch milliseconds.
   * @returns The fresh entry, or undefined when absent or stale.
   */
  read(serverName: string, authorization: string, now: number): CachedToolList | undefined {
    const entry = this.entries.get(entryKey(serverName, authorization))
    if (entry === undefined || entry.expiresAt <= now) return undefined
    return entry
  }

  /**
   * Store one generation for its server-stated freshness window. A
   * non-positive `ttlMs` stores nothing.
   *
   * @param serverName - Validated plugin namespace.
   * @param authorization - Digest from {@link authorizationDigest}.
   * @param tools - Aggregated descriptors.
   * @param ttlMs - Normalized server freshness window.
   * @param cacheScope - Normalized server sharing scope.
   * @param now - Current epoch milliseconds.
   */
  write(
    serverName: string,
    authorization: string,
    tools: CachedTool[],
    ttlMs: number,
    cacheScope: 'public' | 'private',
    now: number,
  ): void {
    if (ttlMs <= 0) return
    const key = entryKey(serverName, authorization)
    // Re-insert to refresh insertion order for the FIFO bound.
    this.entries.delete(key)
    this.entries.set(key, { tools, expiresAt: now + ttlMs, cacheScope })
    const excess = this.entries.size - MAX_ENTRIES
    for (const oldest of [...this.entries.keys()].slice(0, excess)) this.entries.delete(oldest)
  }

  /**
   * Drop every cached authorization context of one server namespace, after a
   * list change or a disconnect.
   *
   * @param serverName - Validated plugin namespace.
   */
  evictServer(serverName: string): void {
    const prefix = `${serverName}\0`
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key)
    }
  }

  /** Drop every entry; used by tests to isolate cases. */
  clear(): void {
    this.entries.clear()
  }
}

/** Compose the two-dimensional key without letting either part forge the separator. */
function entryKey(serverName: string, authorization: string): string {
  return `${serverName}\0${authorization}`
}

/** The process-wide tool-list cache. */
export const toolListCache = new ToolListCache()
