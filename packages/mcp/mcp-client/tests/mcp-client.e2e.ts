/**
 * End-to-end tests for dsh-mcp-client. Exercises the REAL MCP protocol against:
 * 1. A self-written 2025-era fixture server over stdio (controlled edge cases)
 * 2. A v2 `serveStdio` fixture serving the 2026-07-28 era over stdio
 * 3. @modelcontextprotocol/server-everything (official integration test server)
 * 4. @modelcontextprotocol/server-filesystem (real filesystem operations)
 * 5. An in-process StreamableHTTPServerTransport server over Streamable HTTP
 *
 * No API key needed — all servers are local/keyless.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { ToolCallId, LlmAdapter, LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { apply } from '@deepseek-ai/dsh-mcp-client/src/index.ts'
import { toolListCache } from '@deepseek-ai/dsh-mcp-client/src/cache.ts'
import { publicToolName } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { Config } from '@deepseek-ai/dsh-mcp-client'

const testToolSignal = new AbortController().signal

const fixtureServerPath = fileURLToPath(new URL('./fixture-server.ts', import.meta.url))
const modernFixtureServerPath = fileURLToPath(new URL('./modern-fixture-server.ts', import.meta.url))

// Resolve package-local .bin for pnpm-hoisted MCP server binaries.
const packageDir = fileURLToPath(new URL('..', import.meta.url))
const localBin = join(packageDir, 'node_modules', '.bin')

// ---- Helpers ----

async function mountRegistry(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  return ctx
}

/** Exact-route adapter used to prove real MCP image admission without an API key. */
class ImageAdapter extends LlmAdapter {
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, inputModalities: ['text', 'image'] })
  }

  stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    throw new Error('MCP image e2e never streams')
  }
}

async function mountImageRegistry(dshHome: string): Promise<Context> {
  const ctx = await mountRegistry()
  await ctx.plugin(LocalAttachmentStore, { dshHome })
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['visual'], new ImageAdapter())
  return ctx
}

/** Calling-agent stand-in pinned to the keyless image-capable route. */
function imageAgent(): object {
  return {
    options: { provider: 'visual', model: 'vision' },
    session: { requestHeader: () => undefined },
  }
}

function sleep(ms: number): Promise<void> {
  const gate: PromiseWithResolvers<void> = Promise.withResolvers()
  setTimeout(gate.resolve, ms)
  return gate.promise
}

/** Narrow a result content block to its text, failing the test on any other shape. */
function textOf(block: unknown): string {
  if (block && typeof block === 'object' && 'text' in block && typeof block.text === 'string') {
    return block.text
  }
  throw new Error(`expected a text content block, got ${JSON.stringify(block)}`)
}

let callSeq = 0
function nextCallId(): ToolCallId {
  return ToolCallId(`e2e-${++callSeq}`)
}

// ---- Fixture server tests ----

describe('fixture server — controlled scenarios', () => {
  let ctx: Context
  let home: string

  const fixtureConfig: Config = {
    transport: 'stdio',
    serverName: 'fixture',
    command: process.execPath,
    args: [fixtureServerPath],
    env: {},
    cwd: packageDir,
    toolCallTimeoutMs: 15_000,
    failOnStartupError: false,
  }

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'mcp-image-e2e-'))
    ctx = await mountImageRegistry(home)
    await apply(ctx, fixtureConfig)
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(200)
    await rm(home, { recursive: true, force: true })
  })

  it('discovers all fixture tools under the server namespace', () => {
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('mcp__fixture__add')
    expect(names).toContain('mcp__fixture__greet')
    expect(names).toContain('mcp__fixture__fail')
    expect(names).toContain('mcp__fixture__image')
    // Raw names are not registered.
    expect(names).not.toContain('add')
  })

  it('normalizes the dotted tool name with a deterministic hash suffix', () => {
    const publicName = publicToolName('fixture', 'admin.reset')
    expect(publicName).toMatch(/^mcp__fixture__admin_reset_[0-9a-f]{12}$/)
    expect(ctx.tools.get(publicName)).toBeDefined()
  })

  it('executes the dotted tool via its normalized public name', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: publicToolName('fixture', 'admin.reset'), arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'reset done' })
  })

  it('executes add(2, 3) → "5"', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__fixture__add', arguments: { a: 2, b: 3 },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: '5' })
  })

  it('executes greet("World") → "Hello, World!"', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__fixture__greet', arguments: { name: 'World' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Hello, World!' })
  })

  it('executes fail() → isError result', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__fixture__fail', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]).toMatchObject({ type: 'text' })
  })

  it('executes image() → ordered durable image content', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal, agent: imageAgent() as never,
      callId: nextCallId(), name: 'mcp__fixture__image', arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(result.content).toHaveLength(3)
    expect(result.content[0]).toEqual({ type: 'text', text: 'Here is an image:' })
    expect(result.content[2]).toEqual({ type: 'text', text: 'End of image.' })
    const image = result.content[1]
    if (image?.type !== 'image') throw new Error(`expected an image block, got ${JSON.stringify(image)}`)
    expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1 })
    const stored = await ctx.attachments.readImage(image.attachment)
    expect(stored.data.byteLength).toBe(image.attachment.bytes)
    if (result.isError) throw new Error('expected MCP image success')
    expect(JSON.stringify(result.value)).toContain('iVBORw0KGgo')
    expect(JSON.stringify(result.content)).not.toContain('iVBORw0KGgo')
  })
})

describe('fixture server — duplicate serverName', () => {
  it('rejects a second instance with the same serverName on one root', async () => {
    const ctx = await mountRegistry()
    const config: Config = {
      transport: 'stdio',
      serverName: 'dup',
      command: process.execPath,
      args: [fixtureServerPath],
      env: {},
      cwd: packageDir,
      toolCallTimeoutMs: 15_000,
      failOnStartupError: false,
    }
    await apply(ctx, config)

    await expect(apply(ctx, config)).rejects.toThrow(/serverName "dup" is already in use/)

    await ctx.fiber.dispose()
    await sleep(200)
  }, 30_000)
})

describe('fixture server — disposal', () => {
  it('disposes cleanly without error', async () => {
    const ctx = await mountRegistry()
    await apply(ctx, {
      transport: 'stdio',
      serverName: 'fixture',
      command: process.execPath,
      args: [fixtureServerPath],
      env: {},
      cwd: packageDir,
      toolCallTimeoutMs: 15_000,
      failOnStartupError: false,
    })

    // Tools are registered before dispose.
    expect(ctx.tools.get('mcp__fixture__add')).toBeDefined()
    expect(ctx.tools.schemas().length).toBeGreaterThanOrEqual(4)

    // Dispose should complete without throwing.
    await ctx.fiber.dispose()
    await sleep(200)
  }, 30_000)
})

describe('fixture server — crash recovery', () => {
  function crashConfig(serverName: string, reconnect: NonNullable<Config['reconnect']>): Config {
    return {
      transport: 'stdio',
      serverName,
      command: process.execPath,
      args: [fixtureServerPath],
      env: {},
      cwd: packageDir,
      toolCallTimeoutMs: 15_000,
      failOnStartupError: false,
      reconnect,
    }
  }

  it('auto-reconnects after a stdio crash and serves tool calls again', async () => {
    const ctx = await mountRegistry()
    await apply(ctx, crashConfig('crashy', { initialDelayMs: 50, maxDelayMs: 500, maxAttempts: 40 }))

    const before = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__crashy__add', arguments: { a: 2, b: 3 },
    })
    expect(textOf(before.content[0])).toBe('5')

    // The crash tool replies, then kills the real child process.
    const crash = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__crashy__crash', arguments: {},
    })
    expect(crash.isError).toBe(false)

    // Recovery is proven by the world: a post-crash call round-trips through
    // the respawned server process.
    await vi.waitFor(async () => {
      const after = await ctx.tools.execute({
        signal: testToolSignal,
        callId: nextCallId(), name: 'mcp__crashy__add', arguments: { a: 20, b: 22 },
      })
      expect(after.isError).toBe(false)
      expect(textOf(after.content[0])).toBe('42')
    }, { timeout: 15_000, interval: 250 })

    // The recovered generation replaced the dead one: no duplicates, no leak.
    const addEntries = ctx.tools.schemas().map(s => s.name).filter(name => name === 'mcp__crashy__add')
    expect(addEntries).toHaveLength(1)

    await ctx.fiber.dispose()
    await sleep(200)
  }, 30_000)

  it('plugin unload during an outage stops reconnection and unregisters tools', async () => {
    const ctx = await mountRegistry()
    const fiber = ctx.plugin(
      { name: 'mcp-client', inject: ['tools'], apply },
      crashConfig('ephemeral', { initialDelayMs: 8_000, maxDelayMs: 8_000, maxAttempts: 5 }),
    )
    // Cordis awaits async apply() as startup work; wait for it.
    await vi.waitFor(() => { expect(ctx.tools.get('mcp__ephemeral__add')).toBeDefined() }, { timeout: 20_000 })

    const crash = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__ephemeral__crash', arguments: {},
    })
    expect(crash.isError).toBe(false)

    // Give the transport close a moment to land the supervisor in its 8s
    // backoff wait, then unload: disposal must not sit out the backoff.
    await sleep(300)
    const started = Date.now()
    await fiber.dispose()
    expect(Date.now() - started).toBeLessThan(4_000)

    expect(ctx.tools.get('mcp__ephemeral__add')).toBeUndefined()
    await sleep(200)
    expect(ctx.tools.get('mcp__ephemeral__add')).toBeUndefined()

    await ctx.fiber.dispose()
  }, 30_000)
})

// ---- @modelcontextprotocol/server-everything ----

describe('server-everything — official test server', () => {
  let ctx: Context

  const config: Config = {
    transport: 'stdio',
    serverName: 'everything',
    command: join(localBin, 'mcp-server-everything'),
    args: ['stdio'],
    env: {},
    cwd: '',
    toolCallTimeoutMs: 30_000,
    failOnStartupError: false,
  }

  beforeAll(async () => {
    ctx = await mountRegistry()
    await apply(ctx, config)
  }, 60_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(500)
  })

  it('discovers tools from server-everything', () => {
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('mcp__everything__echo')
    expect(names).toContain('mcp__everything__get-sum')
    expect(names).toContain('mcp__everything__get-tiny-image')
    expect(names.length).toBeGreaterThanOrEqual(8)
  })

  it('executes echo({ message: "hello" }) → "Echo: hello"', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__everything__echo', arguments: { message: 'hello' },
    })
    expect(result.isError).toBe(false)
    expect(textOf(result.content[0])).toBe('Echo: hello')
  })

  it('executes get-sum({ a: 3, b: 7 }) → contains "10"', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__everything__get-sum', arguments: { a: 3, b: 7 },
    })
    expect(result.isError).toBe(false)
    expect(textOf(result.content[0])).toContain('10')
  })

  it('executes get-tiny-image → explicit refusal without a durable route', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__everything__get-tiny-image', arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('\n'))
      .toContain('[image unavailable: image/png; no attachment store is mounted;')
  })
})

// ---- @modelcontextprotocol/server-filesystem ----

describe('server-filesystem — real filesystem operations', () => {
  let ctx: Context
  let tempDir: string

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'mcp-fs-e2e-'))

    ctx = await mountRegistry()
    const config: Config = {
      transport: 'stdio',
      serverName: 'filesystem',
      command: join(localBin, 'mcp-server-filesystem'),
      args: [tempDir],
      env: {},
      cwd: '',
      toolCallTimeoutMs: 30_000,
      failOnStartupError: false,
    }
    await apply(ctx, config)
  }, 60_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(500)
    await rm(tempDir, { recursive: true, force: true })
  })

  it('discovers filesystem tools', () => {
    const schemas = ctx.tools.schemas()
    const names = schemas.map(s => s.name)
    expect(names).toContain('mcp__filesystem__read_file')
    expect(names).toContain('mcp__filesystem__write_file')
    expect(names).toContain('mcp__filesystem__list_directory')
  })

  it('write_file + read_file round-trip', async () => {
    const filePath = join(tempDir, 'test.txt')
    const content = 'Hello from MCP e2e test!'

    const writeResult = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__filesystem__write_file', arguments: { path: filePath, content },
    })
    expect(writeResult.isError).toBe(false)

    // Assert the filesystem effect independently of the tool result.
    const onDisk = await readFile(filePath, 'utf8')
    expect(onDisk).toBe(content)

    const readResult = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__filesystem__read_file', arguments: { path: filePath },
    })
    expect(readResult.isError).toBe(false)
    expect(textOf(readResult.content[0])).toContain(content)
  })

  it('list_directory shows written file', async () => {
    await writeFile(join(tempDir, 'listed.txt'), 'listed')

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__filesystem__list_directory', arguments: { path: tempDir },
    })
    expect(result.isError).toBe(false)
    expect(textOf(result.content[0])).toContain('listed.txt')
  })
})

// ---- Streamable HTTP transport ----

describe('streamable-http — in-process MCP server', () => {
  let ctx: Context
  let httpServer: Server
  let baseUrl: string
  /** Authorization header values observed by the HTTP server, in arrival order. */
  const seenAuth: Array<string | undefined> = []

  /**
   * Stateless Streamable HTTP endpoint: a fresh McpServer + server transport
   * per request (the SDK's documented stateless pattern — no session id, no
   * SSE stream to keep). The tool set mirrors a minimal fixture server.
   */
  async function handleMcpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    seenAuth.push(req.headers.authorization)
    const server = new McpServer(
      { name: 'http-fixture', version: '1.0.0' },
      { capabilities: { tools: {} } },
    )
    server.registerTool('ping', {
      description: 'Replies pong.',
      inputSchema: {},
    }, async () => ({
      content: [{ type: 'text', text: 'pong' }],
    }))
    server.registerTool('shout', {
      description: 'Upper-cases a message.',
      inputSchema: { message: z.string().describe('Message to upper-case') },
    }, async args => ({
      content: [{ type: 'text', text: args.message.toUpperCase() }],
    }))
    // Stateless mode: sessionIdGenerator ABSENT (the runtime treats absent and
    // explicit-undefined identically; exactOptionalPropertyTypes forbids the
    // SDK-documented explicit `sessionIdGenerator: undefined` spelling).
    const transport = new StreamableHTTPServerTransport({})
    res.on('close', () => { void transport.close(); void server.close() })
    // Same exactOptionalPropertyTypes mismatch the client transport factory
    // documents (src/transport.ts): the SDK types optional callbacks without
    // `| undefined`. The SDK constructed the object; the cast is safe.
    await server.connect(transport as Transport)
    await transport.handleRequest(req, res)
  }

  beforeAll(async () => {
    httpServer = createServer((req, res) => {
      handleMcpRequest(req, res).catch((error: unknown) => {
        res.writeHead(500).end(String(error))
      })
    })
    const listening: PromiseWithResolvers<void> = Promise.withResolvers()
    httpServer.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const address = httpServer.address()
    if (address === null || typeof address === 'string') throw new Error(`expected a TCP AddressInfo, got ${String(address)}`)
    baseUrl = `http://127.0.0.1:${address.port}/mcp`

    ctx = await mountRegistry()
    const config: Config = {
      transport: 'streamable-http',
      serverName: 'web',
      url: baseUrl,
      headers: { Authorization: 'Bearer e2e-test-token' },
      toolCallTimeoutMs: 15_000,
      failOnStartupError: false,
    }
    await apply(ctx, config)
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(200)
    const closed: PromiseWithResolvers<void> = Promise.withResolvers()
    httpServer.close(() => { closed.resolve() })
    await closed.promise
  })

  it('discovers tools under the server namespace over HTTP', () => {
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('mcp__web__ping')
    expect(names).toContain('mcp__web__shout')
  })

  it('executes ping() → "pong" over HTTP', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__web__ping', arguments: {},
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'pong' })
  })

  it('executes shout({ message }) with args over HTTP', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__web__shout', arguments: { message: 'quiet' },
    })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'QUIET' })
  })

  it('sends configured headers on every HTTP request', () => {
    expect(seenAuth.length).toBeGreaterThan(0)
    for (const auth of seenAuth) expect(auth).toBe('Bearer e2e-test-token')
  })
})

// ---- 2026-07-28 era: the v2 stdio fixture ----

/** stdio config for the v2 fixture; omission of `protocolEra` keeps the legacy handshake. */
function modernFixtureConfig(serverName: string, env: Record<string, string> = {}): Config {
  return {
    transport: 'stdio',
    serverName,
    command: process.execPath,
    args: [modernFixtureServerPath],
    env,
    cwd: packageDir,
    toolCallTimeoutMs: 15_000,
    failOnStartupError: false,
  }
}

describe('2026-07-28 era — v2 fixture server', () => {
  let ctx: Context

  beforeAll(async () => {
    ctx = await mountRegistry()
    // Mounted before apply: the bridge derives its advertised capabilities and
    // its elicitation handler from the seams present at connect time.
    await ctx.plugin(UserQuestionService)
    await apply(ctx, { ...modernFixtureConfig('modern'), protocolEra: 'auto' })
  }, 30_000)

  afterAll(async () => {
    if (ctx) await ctx.fiber.dispose()
    await sleep(200)
  })

  it('discovers the fixture tools over the modern era', () => {
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('mcp__modern__echo')
    expect(names).toContain('mcp__modern__add')
    expect(names).toContain('mcp__modern__greet')
  })

  it('executes a tool call over the modern era', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__modern__add', arguments: { a: 2, b: 3 },
    })
    expect(result.isError).toBe(false)
    expect(textOf(result.content[0])).toBe('5')
  })

  it('fulfils a multi-round-trip elicitation through ctx.userQuestions', async () => {
    const asked: AskUserQuestionRequest[] = []
    const ask = vi.spyOn(ctx.userQuestions, 'ask').mockImplementation(async (request) => {
      asked.push(request)
      return { answers: [{ id: 'name', selected: [], custom: 'Ada' }] }
    })

    try {
      const result = await ctx.tools.execute({
        signal: testToolSignal,
        callId: nextCallId(), name: 'mcp__modern__greet', arguments: {},
      })
      expect(result.isError).toBe(false)
      expect(textOf(result.content[0])).toBe('Hello, Ada')
      expect(asked).toHaveLength(1)
      expect(asked[0]!.questions[0]!.id).toBe('name')
      expect(asked[0]!.questions[0]!.detail ?? '').toContain('Which name should the greeting use?')
    } finally {
      ask.mockRestore()
    }
  })

  it('fails a sampling request visibly instead of answering it', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__modern__use-sampling', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(textOf(result.content[0]).toLowerCase()).toContain('sampling')
  })

  it('fails a roots request visibly instead of answering it', async () => {
    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__modern__use-roots', arguments: {},
    })
    expect(result.isError).toBe(true)
    expect(textOf(result.content[0]).toLowerCase()).toContain('roots')
  })

  it('re-syncs tools after the server announces a list change', async () => {
    expect(ctx.tools.get('mcp__modern__dynamic')).toBeUndefined()

    const added = await ctx.tools.execute({
      signal: testToolSignal,
      callId: nextCallId(), name: 'mcp__modern__add-tool', arguments: {},
    })
    expect(added.isError).toBe(false)

    // The announcement reaches the bridge only through the client's open
    // subscription, and the re-sync must evict the cached list to see it.
    await vi.waitFor(() => {
      expect(ctx.tools.get('mcp__modern__dynamic')).toBeDefined()
    }, { timeout: 15_000, interval: 100 })
  }, 30_000)
})

describe('2026-07-28 era — one factory, both eras', () => {
  it('advertises identical tool names under the legacy and modern handshakes', async () => {
    const legacy = await mountRegistry()
    const modern = await mountRegistry()
    try {
      await apply(legacy, modernFixtureConfig('eras'))
      await apply(modern, { ...modernFixtureConfig('eras'), protocolEra: 'auto' })

      const legacyNames = legacy.tools.schemas().map(s => s.name)
      expect(legacyNames).toContain('mcp__eras__echo')
      expect(modern.tools.schemas().map(s => s.name)).toEqual(legacyNames)
    } finally {
      await legacy.fiber.dispose()
      await modern.fiber.dispose()
    }
  }, 60_000)
})

describe('2026-07-28 era — tool list descriptor cache', () => {
  it('serves a fresh cached list to a second connection instead of re-listing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'mcp-cache-e2e-'))
    const extraFile = join(home, 'extra-tool')
    const config: Config = {
      ...modernFixtureConfig('cached', { DSH_MCP_FIXTURE_EXTRA_FILE: extraFile }),
      protocolEra: { pin: '2026-07-28' },
    }
    const first = await mountRegistry()
    const second = await mountRegistry()
    const third = await mountRegistry()
    try {
      await apply(first, config)
      expect(first.tools.get('mcp__cached__echo')).toBeDefined()
      expect(first.tools.get('mcp__cached__later')).toBeUndefined()

      // Every server process started from now on does advertise `later`, so a
      // second connection that re-listed would surface it. Its absence shows
      // the bridge served the first connection's descriptors for the
      // server-declared freshness window.
      await writeFile(extraFile, '')
      await apply(second, config)
      expect(second.tools.get('mcp__cached__echo')).toBeDefined()
      expect(second.tools.get('mcp__cached__later')).toBeUndefined()

      // Eviction is the other half: once the entry is gone, the same config
      // re-lists and does see the extra tool.
      toolListCache.evictServer('cached')
      await apply(third, config)
      expect(third.tools.get('mcp__cached__later')).toBeDefined()
    } finally {
      await first.fiber.dispose()
      await second.fiber.dispose()
      await third.fiber.dispose()
      await sleep(200)
      await rm(home, { recursive: true, force: true })
    }
  }, 60_000)
})
