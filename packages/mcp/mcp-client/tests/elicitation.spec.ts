/**
 * Tests for the elicitation bridge: form-mode property mapping, answer
 * encoding, agent attribution through the in-flight execution broker, and the
 * registered `elicitation/create` handler.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { UserQuestionError, UserQuestionService } from '@deepseek-ai/dsh-user-questions'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions'
import {
  ElicitationBroker, answerElicitation, registerElicitation,
} from '@deepseek-ai/dsh-mcp-client/src/elicitation.ts'
import { syncTools } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'
import type { ToolBridgeOptions } from '@deepseek-ai/dsh-mcp-client/src/tools.ts'

// ---- Helpers ----

type Agent = NonNullable<ToolExecution['agent']>

const testToolSignal = new AbortController().signal

function agentOf(id: string): Agent {
  return { id } as unknown as Agent
}

function executionOf(agent?: Agent): ToolExecution {
  return { agent } as unknown as ToolExecution
}

/** Build a form-mode elicitation request from raw property schemas. */
function formRequest(
  properties: Record<string, unknown>,
  message = 'Please provide details',
) {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message, requestedSchema: { type: 'object', properties } },
  } as never
}

async function mountUserQuestions(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(UserQuestionService)
  return ctx
}

/** Answer `ask` with one canned response and return the spy. */
function answerWith(ctx: Context, answer: AskUserQuestionAnswer) {
  return vi.spyOn(ctx.userQuestions, 'ask').mockResolvedValue(answer)
}

// ---- Broker attribution ----

describe('ElicitationBroker', () => {
  it('reports no agent while nothing is in flight', () => {
    expect(new ElicitationBroker().attribution()).toEqual({ kind: 'agent', agent: undefined })
  })

  it('attributes the one agent whose executions are in flight', () => {
    const broker = new ElicitationBroker()
    const agent = agentOf('a')
    broker.enter(executionOf(agent))
    broker.enter(executionOf(agent))
    expect(broker.attribution()).toEqual({ kind: 'agent', agent })
  })

  it('ignores agent-less executions beside one attributed agent', () => {
    const broker = new ElicitationBroker()
    const agent = agentOf('a')
    broker.enter(executionOf())
    broker.enter(executionOf(agent))
    expect(broker.attribution()).toEqual({ kind: 'agent', agent })
  })

  it('reports ambiguity for two distinct in-flight agents', () => {
    const broker = new ElicitationBroker()
    broker.enter(executionOf(agentOf('a')))
    broker.enter(executionOf(agentOf('b')))
    expect(broker.attribution()).toEqual({ kind: 'ambiguous' })
  })

  it('forgets an execution once it exits', () => {
    const broker = new ElicitationBroker()
    const first = executionOf(agentOf('a'))
    const second = executionOf(agentOf('b'))
    broker.enter(first)
    broker.enter(second)
    expect(broker.attribution()).toEqual({ kind: 'ambiguous' })
    broker.exit(first)
    expect(broker.attribution()).toEqual({ kind: 'agent', agent: agentOf('b') })
  })

  it('does not mistake an exited execution for a live one', () => {
    const broker = new ElicitationBroker()
    const execution = executionOf(agentOf('a'))
    broker.exit(execution)
    expect(broker.attribution()).toEqual({ kind: 'agent', agent: undefined })
  })
})

// ---- Form mapping and answer encoding ----

describe('answerElicitation', () => {
  let ctx: Context

  beforeEach(async () => {
    ctx = await mountUserQuestions()
  })

  it('presents a free-text property as a question with the server message as detail', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'name', selected: [], custom: 'octocat' }] })

    const result = await answerElicitation(
      ctx,
      formRequest({ name: { type: 'string', title: 'GitHub username', description: 'The account to query' } }),
      testToolSignal,
      undefined,
    )

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({
      questions: [{
        id: 'name',
        question: 'GitHub username',
        detail: 'Please provide details\n\nThe account to query',
      }],
    }))
    expect(result).toEqual({ action: 'accept', content: { name: 'octocat' } })
  })

  it('maps an untitled enum to labelled options and back to its wire values', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'color', selected: ['Red'] }] })

    const result = await answerElicitation(
      ctx,
      formRequest({ color: { type: 'string', enum: ['red', 'blue'], enumNames: ['Red', 'Blue'] } }),
      testToolSignal,
      undefined,
    )

    expect(ask.mock.calls[0]![0].questions[0]!.options).toEqual([{ label: 'Red' }, { label: 'Blue' }])
    expect(result).toEqual({ action: 'accept', content: { color: 'red' } })
  })

  it('maps a titled enum to its constant values and keeps the property title', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'env', selected: ['Staging'] }] })

    const result = await answerElicitation(
      ctx,
      formRequest({
        env: {
          type: 'string',
          title: 'Environment',
          oneOf: [
            { const: 'prod', title: 'Production', description: 'Live traffic' },
            { const: 'stage', title: 'Staging' },
          ],
        },
      }),
      testToolSignal,
      undefined,
    )

    expect(ask.mock.calls[0]![0].questions[0]).toMatchObject({
      id: 'env',
      question: 'Environment',
      options: [{ label: 'Production' }, { label: 'Staging' }],
    })
    expect(result).toEqual({ action: 'accept', content: { env: 'stage' } })
  })

  it('marks an enum array as multi-select and encodes every selected label', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'tags', selected: ['Alpha', 'Beta'] }] })

    const result = await answerElicitation(
      ctx,
      formRequest({ tags: { type: 'array', items: { type: 'string', oneOf: [
        { const: 'a', title: 'Alpha' },
        { const: 'b', title: 'Beta' },
        { const: 'c', title: 'Gamma' },
      ] } } }),
      testToolSignal,
      undefined,
    )

    expect(ask.mock.calls[0]![0].questions[0]).toMatchObject({ id: 'tags', multiSelect: true })
    expect(result).toEqual({ action: 'accept', content: { tags: ['a', 'b'] } })
  })

  it('appends custom text to a multi-select answer', async () => {
    answerWith(ctx, { answers: [{ id: 'tags', selected: ['a'], custom: 'delta' }] })

    const result = await answerElicitation(
      ctx,
      formRequest({ tags: { type: 'array', items: { type: 'string', enum: ['a'] } } }),
      testToolSignal,
      undefined,
    )

    expect(result).toEqual({ action: 'accept', content: { tags: ['a', 'delta'] } })
  })

  it('encodes a boolean property from either a label or custom text', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'on', selected: ['true'] }] })

    const fromLabel = await answerElicitation(ctx, formRequest({ on: { type: 'boolean' } }), testToolSignal, undefined)
    expect(fromLabel).toEqual({ action: 'accept', content: { on: true } })

    ask.mockResolvedValueOnce({ answers: [{ id: 'on', selected: [], custom: 'FALSE' }] })
    const fromCustom = await answerElicitation(ctx, formRequest({ on: { type: 'boolean' } }), testToolSignal, undefined)
    expect(fromCustom).toEqual({ action: 'accept', content: { on: false } })
  })

  it('encodes numeric and integer properties, refusing a malformed number', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'count', selected: [], custom: '42' }] })

    expect(await answerElicitation(ctx, formRequest({ count: { type: 'number' } }), testToolSignal, undefined))
      .toEqual({ action: 'accept', content: { count: 42 } })

    ask.mockResolvedValueOnce({ answers: [{ id: 'count', selected: [], custom: '4.5' }] })
    expect(await answerElicitation(ctx, formRequest({ count: { type: 'integer' } }), testToolSignal, undefined))
      .toEqual({ action: 'decline' })

    ask.mockResolvedValueOnce({ answers: [{ id: 'count', selected: [], custom: 'many' }] })
    expect(await answerElicitation(ctx, formRequest({ count: { type: 'number' } }), testToolSignal, undefined))
      .toEqual({ action: 'decline' })
  })

  it('declines when the human skipped every question', async () => {
    answerWith(ctx, { answers: [{ id: 'name', selected: [] }] })
    expect(await answerElicitation(ctx, formRequest({ name: { type: 'string' } }), testToolSignal, undefined))
      .toEqual({ action: 'decline' })
  })

  it('passes the attributed agent through to the answerer', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'name', selected: [], custom: 'x' }] })
    const agent = agentOf('a')

    await answerElicitation(ctx, formRequest({ name: { type: 'string' } }), testToolSignal, agent)

    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ agent }))
  })

  it('cancels a URL-mode request without asking the human', async () => {
    const ask = answerWith(ctx, { answers: [] })

    const result = await answerElicitation(
      ctx,
      { method: 'elicitation/create', params: { mode: 'url', message: 'Open this', url: 'https://example.com' } } as never,
      testToolSignal,
      undefined,
    )

    expect(result).toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
  })

  it('cancels when the human cancels or the call is aborted', async () => {
    for (const code of ['ASK_CANCELLED', 'ASK_ABORTED']) {
      const fresh = await mountUserQuestions()
      vi.spyOn(fresh.userQuestions, 'ask').mockRejectedValue(new UserQuestionError('cancelled', code))
      expect(await answerElicitation(fresh, formRequest({ name: { type: 'string' } }), testToolSignal, undefined))
        .toEqual({ action: 'cancel' })
    }
  })

  it('fails the call visibly when no answerer accepted the request', async () => {
    vi.spyOn(ctx.userQuestions, 'ask').mockRejectedValue(
      new UserQuestionError('no user-questions answerer accepted the request', 'NO_PROVIDER'),
    )

    await expect(answerElicitation(ctx, formRequest({ name: { type: 'string' } }), testToolSignal, undefined))
      .rejects.toThrow('no user-questions answerer accepted the request')
  })

  it('treats an empty enum declaration as free text', async () => {
    const ask = answerWith(ctx, { answers: [
      { id: 'color', selected: [], custom: 'mauve' },
      { id: 'tags', selected: [], custom: 'one' },
      { id: 'env', selected: [], custom: 'dev' },
    ] })

    const result = await answerElicitation(
      ctx,
      formRequest({
        color: { type: 'string', enum: [] },
        tags: { type: 'array', items: { type: 'string', enum: [] } },
        env: { type: 'string', oneOf: [] },
      }),
      testToolSignal,
      undefined,
    )

    expect(ask.mock.calls[0]![0].questions.every(question => question.options === undefined)).toBe(true)
    expect(result).toEqual({ action: 'accept', content: { color: 'mauve', tags: 'one', env: 'dev' } })
  })

  it('omits question detail when neither the message nor the description has text', async () => {
    const ask = answerWith(ctx, { answers: [{ id: 'name', selected: [], custom: 'x' }] })

    await answerElicitation(ctx, formRequest({ name: { type: 'string' } }, ''), testToolSignal, undefined)

    expect(ask.mock.calls[0]![0].questions[0]).toEqual({ id: 'name', question: 'name' })
  })

  it('declines a property the answerer left out of its response', async () => {
    answerWith(ctx, { answers: [] })

    expect(await answerElicitation(ctx, formRequest({ name: { type: 'string' } }), testToolSignal, undefined))
      .toEqual({ action: 'decline' })
  })

  it('declines numeric and integer properties answered with no usable text', async () => {
    answerWith(ctx, { answers: [{ id: 'count', selected: [] }, { id: 'total', selected: [] }] })

    expect(await answerElicitation(
      ctx,
      formRequest({ count: { type: 'number' }, total: { type: 'integer' } }),
      testToolSignal,
      undefined,
    )).toEqual({ action: 'decline' })
  })

  it('encodes an integer-valued answer for an integer property', async () => {
    answerWith(ctx, { answers: [{ id: 'count', selected: [], custom: '42' }] })

    expect(await answerElicitation(ctx, formRequest({ count: { type: 'integer' } }), testToolSignal, undefined))
      .toEqual({ action: 'accept', content: { count: 42 } })
  })

  it('declines a boolean answered with anything but true or false', async () => {
    answerWith(ctx, { answers: [{ id: 'on', selected: [], custom: 'yes' }] })

    expect(await answerElicitation(ctx, formRequest({ on: { type: 'boolean' } }), testToolSignal, undefined))
      .toEqual({ action: 'decline' })
  })

  it('declines a multi-select with nothing selected', async () => {
    answerWith(ctx, { answers: [{ id: 'tags', selected: [] }] })

    expect(await answerElicitation(
      ctx,
      formRequest({ tags: { type: 'array', items: { type: 'string', enum: ['a'] } } }),
      testToolSignal,
      undefined,
    )).toEqual({ action: 'decline' })
  })

  it('accepts custom text for a single-select enum instead of a listed option', async () => {
    answerWith(ctx, { answers: [{ id: 'color', selected: [], custom: 'mauve' }] })

    expect(await answerElicitation(
      ctx,
      formRequest({ color: { type: 'string', enum: ['red', 'blue'] } }),
      testToolSignal,
      undefined,
    )).toEqual({ action: 'accept', content: { color: 'mauve' } })
  })

  it('declines an enum answer that names no listed option', async () => {
    answerWith(ctx, { answers: [{ id: 'color', selected: ['Mauve'] }] })

    expect(await answerElicitation(
      ctx,
      formRequest({ color: { type: 'string', enum: ['red', 'blue'] } }),
      testToolSignal,
      undefined,
    )).toEqual({ action: 'decline' })
  })
})

// ---- Handler registration ----

describe('registerElicitation', () => {
  it('registers only the elicitation request and answers through it', async () => {
    const ctx = await mountUserQuestions()
    answerWith(ctx, { answers: [{ id: 'name', selected: [], custom: 'octocat' }] })
    const handlers = new Map<string, (request: unknown, context: unknown) => Promise<unknown>>()
    const client = {
      setRequestHandler: (method: string, handler: (request: unknown, context: unknown) => Promise<unknown>) => {
        handlers.set(method, handler)
      },
    } as never

    registerElicitation(client, ctx, new ElicitationBroker(), 'mcp-client(srv)')

    expect([...handlers.keys()]).toEqual(['elicitation/create'])
    const handler = handlers.get('elicitation/create')!
    await expect(handler(
      formRequest({ name: { type: 'string' } }),
      { mcpReq: { signal: testToolSignal } },
    )).resolves.toEqual({ action: 'accept', content: { name: 'octocat' } })
  })

  it('refuses an elicitation whose asking agent is ambiguous', async () => {
    const ctx = await mountUserQuestions()
    const ask = answerWith(ctx, { answers: [] })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const broker = new ElicitationBroker()
    broker.enter(executionOf(agentOf('a')))
    broker.enter(executionOf(agentOf('b')))
    const handlers = new Map<string, (request: unknown, context: unknown) => Promise<unknown>>()
    const client = {
      setRequestHandler: (method: string, handler: (request: unknown, context: unknown) => Promise<unknown>) => {
        handlers.set(method, handler)
      },
    } as never

    registerElicitation(client, ctx, broker, 'mcp-client(srv)')

    await expect(handlers.get('elicitation/create')!(
      formRequest({ name: { type: 'string' } }),
      { mcpReq: { signal: testToolSignal } },
    )).resolves.toEqual({ action: 'cancel' })
    expect(ask).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('different agents are in flight'))
  })
})

// ---- Executor registration ----

describe('tool execution attribution', () => {
  it('keeps the execution registered with the broker for the whole call', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    const broker = new ElicitationBroker()
    const agent = agentOf('a')
    let duringCall: unknown
    const client = {
      request: vi.fn(async (request: { method: string }) => {
        if (request.method === 'tools/list') {
          return { tools: [{ name: 'remote', inputSchema: { type: 'object' } }], nextCursor: undefined }
        }
        duringCall = broker.attribution()
        return { content: [{ type: 'text', text: 'ok' }] }
      }),
    }
    const opts: ToolBridgeOptions = {
      registrationFailure: 'contain',
      serverName: 'srv',
      toolCallTimeoutMs: 60_000,
      authorization: 'test',
      elicitation: broker,
    }

    await syncTools(client as never, ctx, opts, new Map())
    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('c1'),
      name: 'mcp__srv__remote',
      arguments: {},
      agent,
    })

    expect(duringCall).toEqual({ kind: 'agent', agent })
    // Exited with the call: the broker must not retain settled executions.
    expect(broker.attribution()).toEqual({ kind: 'agent', agent: undefined })
  })
})
