/**
 * v2 fixture server for the 2026-07-28 protocol era, served over stdio by
 * `serveStdio` from one factory so the same tool registrations answer a
 * 2025-era `initialize` handshake and a modern `server/discover` opening
 * alike.
 *
 * Tools are deliberately era-independent, so a client's modern and legacy
 * tool names can be compared directly. The multi-round-trip tools return
 * `inputRequired(...)`, which the v2 SDK fulfils through the client on a
 * modern connection and through its legacy shim on a 2025-era one.
 *
 * `DSH_MCP_FIXTURE_EXTRA_FILE` makes every process that finds that file
 * register an extra `later` tool. The descriptor-cache e2e creates the file
 * between connections, so a connection that re-lists must surface the extra
 * tool while one served from the cached descriptors cannot.
 */
import { existsSync } from 'node:fs'
import { McpServer, acceptedContent, inputRequired } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { z } from 'zod'

const extraFile = process.env.DSH_MCP_FIXTURE_EXTRA_FILE
const extraTool = extraFile !== undefined && extraFile !== '' && existsSync(extraFile)

/** Freshness window the server declares for `tools/list` on the modern era. */
const TOOL_LIST_TTL_MS = 60_000

serveStdio(() => {
  const server = new McpServer(
    { name: 'dsh-modern-fixture', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
      cacheHints: { 'tools/list': { ttlMs: TOOL_LIST_TTL_MS, cacheScope: 'private' } },
    },
  )

  server.registerTool(
    'echo',
    { description: 'Echo a message', inputSchema: z.object({ message: z.string() }) },
    ({ message }) => ({ content: [{ type: 'text', text: `Echo: ${message}` }] }),
  )

  server.registerTool(
    'add',
    { description: 'Add two numbers', inputSchema: z.object({ a: z.number(), b: z.number() }) },
    ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  )

  const nameSchema = z.object({ name: z.string().describe('The name to greet') })
  server.registerTool(
    'greet',
    { description: 'Greet a human after asking for their name', inputSchema: z.object({}) },
    (_args, ctx) => {
      const accepted = acceptedContent(ctx.mcpReq.inputResponses, 'name', nameSchema)
      if (accepted === undefined) {
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: 'Which name should the greeting use?',
              requestedSchema: nameSchema,
            }),
          },
        })
      }
      return { content: [{ type: 'text', text: `Hello, ${accepted.name}` }] }
    },
  )

  server.registerTool(
    'use-sampling',
    { description: 'Ask the client to complete a prompt', inputSchema: z.object({}) },
    () => inputRequired({
      inputRequests: {
        sample: inputRequired.createMessage({
          messages: [{ role: 'user', content: { type: 'text', text: 'Say hi' } }],
          maxTokens: 16,
        }),
      },
    }),
  )

  server.registerTool(
    'use-roots',
    { description: 'Ask the client for its roots', inputSchema: z.object({}) },
    () => inputRequired({ inputRequests: { roots: inputRequired.listRoots() } }),
  )

  let dynamicAdded = false
  server.registerTool(
    'add-tool',
    { description: 'Register one more tool and announce the list change', inputSchema: z.object({}) },
    () => {
      if (!dynamicAdded) {
        dynamicAdded = true
        server.registerTool(
          'dynamic',
          { description: 'Registered at runtime', inputSchema: z.object({}) },
          () => ({ content: [{ type: 'text', text: 'dynamic ready' }] }),
        )
        server.sendToolListChanged()
      }
      return { content: [{ type: 'text', text: 'added' }] }
    },
  )

  if (extraTool) {
    server.registerTool(
      'later',
      { description: 'Registered only while the extra-tool file exists', inputSchema: z.object({}) },
      () => ({ content: [{ type: 'text', text: 'later' }] }),
    )
  }

  return server
})
