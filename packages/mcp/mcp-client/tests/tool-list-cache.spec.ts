/**
 * Tests for the `tools/list` descriptor cache: the `(serverName,
 * authorization)` partition, server-stated freshness and scope normalization,
 * the store's bounds, and `syncTools` reuse across client generations.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { Config } from '@deepseek-ai/dsh-mcp-client'
import {
  authorizationDigest, normalizeCacheScope, normalizeCacheTtlMs, toolListCache,
} from '@deepseek-ai/dsh-mcp-client/src/cache.ts'
import type { CachedTool } from '@deepseek-ai/dsh-mcp-client/src/cache.ts'
import { syncTools } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

// ---- Helpers ----

function httpConfig(): Config {
  return {
    transport: 'streamable-http',
    serverName: 'srv',
    url: 'https://example.com/mcp',
    headers: {},
    toolCallTimeoutMs: 60_000,
    failOnStartupError: false,
  }
}

const TOOLS: CachedTool[] = [{
  name: 'remote',
  description: 'A remote tool',
  inputSchema: { type: 'object' },
  outputSchema: undefined,
  taskSupportRequired: false,
}]

const OPTS: ToolBridgeOptions = {
  registrationFailure: 'contain',
  serverName: 'srv',
  toolCallTimeoutMs: 60_000,
  authorization: 'auth',
}

async function mountTools(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** A client whose `tools/list` counts calls and declares a freshness window. */
function listClient(ttlMs: number, cacheScope = 'private') {
  const list = vi.fn(async () => ({
    tools: TOOLS.map(tool => ({ ...tool, outputSchema: undefined })),
    nextCursor: undefined,
    ttlMs,
    cacheScope,
  }))
  return {
    list,
    request: vi.fn(async (request: { method: string }) => {
      if (request.method === 'tools/list') return await list()
      return { content: [{ type: 'text', text: 'ok' }] }
    }),
  }
}

// ---- Authorization identity ----

describe('authorizationDigest', () => {
  it('separates two authorization contexts and is stable across header order', () => {
    const first = { ...httpConfig(), headers: { Authorization: 'Bearer a' } }
    const second = { ...httpConfig(), headers: { Authorization: 'Bearer b' } }
    const reordered = { ...httpConfig(), headers: { 'X-Trace': '2', Authorization: 'Bearer a', 'X-Extra': '3' } }
    const ordered = { ...httpConfig(), headers: { Authorization: 'Bearer a', 'X-Extra': '3', 'X-Trace': '2' } }

    expect(authorizationDigest(first)).not.toBe(authorizationDigest(second))
    expect(authorizationDigest(reordered)).toBe(authorizationDigest(ordered))
  })

  it('separates two stdio environments', () => {
    const base: Config = {
      transport: 'stdio',
      serverName: 'srv',
      command: 'node',
      args: ['server.js'],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 60_000,
      failOnStartupError: false,
    }
    expect(authorizationDigest(base))
      .not.toBe(authorizationDigest({ ...base, env: { TOKEN: 'x' } }))
  })
})

// ---- Server-declared metadata ----

describe('cache metadata normalization', () => {
  it('treats only the spec public scope as public', () => {
    expect(normalizeCacheScope('public')).toBe('public')
    expect(normalizeCacheScope('private')).toBe('private')
    expect(normalizeCacheScope('shared')).toBe('private')
    expect(normalizeCacheScope(undefined)).toBe('private')
  })

  it('treats a non-positive or malformed ttl as immediately stale', () => {
    expect(normalizeCacheTtlMs(1000)).toBe(1000)
    expect(normalizeCacheTtlMs(0)).toBe(0)
    expect(normalizeCacheTtlMs(-1)).toBe(0)
    expect(normalizeCacheTtlMs(1.5)).toBe(0)
    expect(normalizeCacheTtlMs('1000')).toBe(0)
    expect(normalizeCacheTtlMs(undefined)).toBe(0)
  })
})

// ---- Store ----

describe('toolListCache', () => {
  beforeEach(() => {
    toolListCache.clear()
  })

  it('serves a fresh entry and drops it at the freshness boundary', () => {
    toolListCache.write('srv', 'auth', TOOLS, 1000, 'private', 0)
    expect(toolListCache.read('srv', 'auth', 999)?.tools).toEqual(TOOLS)
    expect(toolListCache.read('srv', 'auth', 1000)).toBeUndefined()
  })

  it('stores nothing for a non-positive ttl', () => {
    toolListCache.write('srv', 'auth', TOOLS, 0, 'private', 0)
    expect(toolListCache.read('srv', 'auth', 0)).toBeUndefined()
  })

  it('never shares an entry across authorization contexts, even when public', () => {
    toolListCache.write('srv', 'auth-a', TOOLS, 1000, 'public', 0)
    expect(toolListCache.read('srv', 'auth-b', 1)).toBeUndefined()
    expect(toolListCache.read('srv', 'auth-a', 1)?.cacheScope).toBe('public')
  })

  it('evicts every authorization context of one server only', () => {
    toolListCache.write('srv', 'auth-a', TOOLS, 1000, 'private', 0)
    toolListCache.write('srv', 'auth-b', TOOLS, 1000, 'private', 0)
    toolListCache.write('other', 'auth-a', TOOLS, 1000, 'private', 0)

    toolListCache.evictServer('srv')

    expect(toolListCache.read('srv', 'auth-a', 1)).toBeUndefined()
    expect(toolListCache.read('srv', 'auth-b', 1)).toBeUndefined()
    expect(toolListCache.read('other', 'auth-a', 1)).toBeDefined()
  })

  it('bounds the store and drops the least recently written entry', () => {
    for (let index = 0; index < 65; index += 1) {
      toolListCache.write(`server-${index}`, 'auth', TOOLS, 1000, 'private', 0)
    }

    expect(toolListCache.read('server-0', 'auth', 1)).toBeUndefined()
    expect(toolListCache.read('server-64', 'auth', 1)).toBeDefined()
  })
})

// ---- syncTools integration ----

describe('syncTools caching', () => {
  let ctx: Context

  beforeEach(async () => {
    toolListCache.clear()
    ctx = await mountTools()
  })

  it('reuses fresh descriptors for a later generation without listing again', async () => {
    const first = listClient(5000)
    const disposers = await syncTools(first as never, ctx, OPTS, new Map())
    expect(first.list).toHaveBeenCalledTimes(1)
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()

    // A reconnected generation reuses the cached descriptors and rebuilds the
    // registrations against the new client.
    const second = listClient(5000)
    const secondDisposers = await syncTools(second as never, ctx, OPTS, disposers)

    expect(second.list).not.toHaveBeenCalled()
    expect(ctx.tools.get('mcp__srv__remote')).toBeDefined()
    for (const dispose of secondDisposers.values()) dispose()
  })

  it('refetches once a list change evicts the entry', async () => {
    const first = listClient(5000)
    const disposers = await syncTools(first as never, ctx, OPTS, new Map())

    toolListCache.evictServer('srv')

    const second = listClient(5000)
    const secondDisposers = await syncTools(second as never, ctx, OPTS, disposers)

    expect(second.list).toHaveBeenCalledTimes(1)
    for (const dispose of secondDisposers.values()) dispose()
  })

  it('does not cache a list the server declared immediately stale', async () => {
    const first = listClient(0)
    const disposers = await syncTools(first as never, ctx, OPTS, new Map())

    const second = listClient(0)
    const secondDisposers = await syncTools(second as never, ctx, OPTS, disposers)

    expect(first.list).toHaveBeenCalledTimes(1)
    expect(second.list).toHaveBeenCalledTimes(1)
    for (const dispose of secondDisposers.values()) dispose()
  })
})
