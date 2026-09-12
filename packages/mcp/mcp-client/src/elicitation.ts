/**
 * Elicitation bridge: fulfils the `2026-07-28` multi-round-trip
 * `elicitation/create` requests the MCP client's auto-fulfilment driver
 * dispatches, through the harness `ctx.userQuestions` capability seam.
 *
 * Only form mode is declared, and only when `ctx.userQuestions` is mounted:
 * URL mode needs a consent and navigation surface no CLI or Web plugin
 * implements, so the bridge never advertises `elicitation.url`.
 *
 * Attribution: the SDK dispatches an embedded request to one
 * connection-scoped handler with no originating-call identity, so the
 * {@link ElicitationBroker} resolves the asking agent from the tool
 * executions currently in flight on this connection. One distinct agent is
 * unambiguous; two different agents in flight are not, and the bridge cancels
 * rather than delivering one agent's question to another's UI.
 *
 * @module
 */

import type {
  Client, ElicitRequest, ElicitRequestFormParams, ElicitResult,
} from '@modelcontextprotocol/client'
import type { Context } from '@deepseek-ai/cordis'
import { UserQuestionError } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem,
} from '@deepseek-ai/dsh-user-questions/types'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

/** The asking agent resolved for one elicitation, or an unresolvable overlap. */
export type ElicitationAttribution =
  | { readonly kind: 'agent'; readonly agent: NonNullable<ToolExecution['agent']> | undefined }
  | { readonly kind: 'ambiguous' }

/**
 * Tracks the `tools/call` executions in flight on one MCP connection so an
 * embedded elicitation can be attributed to the agent that caused it.
 *
 * A server can only elicit while it is processing a request, so when every
 * in-flight execution shares one agent the attribution is certain. Executions
 * without an agent express no opinion; only two or more distinct agents are
 * ambiguous.
 */
export class ElicitationBroker {
  private readonly active = new Set<ToolExecution>()

  /**
   * Record one execution as in flight for the length of its tool call.
   *
   * @param execution - The executing tool call.
   */
  enter(execution: ToolExecution): void {
    this.active.add(execution)
  }

  /**
   * Forget an execution once its tool call has settled.
   *
   * @param execution - The settled tool call.
   */
  exit(execution: ToolExecution): void {
    this.active.delete(execution)
  }

  /**
   * Resolve the agent an incoming elicitation belongs to.
   *
   * @returns The single distinct in-flight agent (possibly `undefined`), or
   *   `ambiguous` when in-flight calls belong to different agents.
   */
  attribution(): ElicitationAttribution {
    const agents = new Set<NonNullable<ToolExecution['agent']>>()
    for (const execution of this.active) {
      if (execution.agent !== undefined) agents.add(execution.agent)
    }
    if (agents.size > 1) return { kind: 'ambiguous' }
    return { kind: 'agent', agent: agents.values().next().value }
  }
}

/** One elicitation form property, with the answer encoding it needs. */
interface FormField {
  /** Property key, used as the question id and the content member name. */
  id: string
  /** Question presented through `ctx.userQuestions`. */
  question: AskUserQuestionItem
  /** Value kind governing answer parsing. */
  kind: 'text' | 'number' | 'integer' | 'boolean' | 'enum'
  /** Label-to-wire-value mapping for enum and boolean fields. */
  options?: ReadonlyArray<{ label: string; value: string | number | boolean }>
  /** Whether the property accepts multiple values. */
  multiSelect: boolean
}

/** Whether a value is a plain record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A present string member, or undefined. */
function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the closed enum options a form property declares, covering the
 * untitled (`enum`/`enumNames`) and titled (`oneOf`/`anyOf`) single- and
 * multi-select shapes.
 *
 * @param schema - Property schema or the array `items` schema.
 * @returns Label/value options, or undefined when the schema declares none.
 */
function enumOptionsOf(
  schema: Record<string, unknown>,
): Array<{ label: string; value: string | number | boolean }> | undefined {
  const oneOf = schema.oneOf ?? schema.anyOf
  if (Array.isArray(oneOf)) {
    const options = oneOf.flatMap((entry) => {
      /* v8 ignore start -- the SDK's form schema requires every oneOf entry to be an object with a string const and a title */
      if (!isRecord(entry)) return []
      const value = entry.const
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return []
      return [{ label: stringOf(entry.title) ?? String(value), value }]
      /* v8 ignore stop */
    })
    return options.length > 0 ? options : undefined
  }
  const values = schema.enum
  if (Array.isArray(values)) {
    const names = Array.isArray(schema.enumNames) ? schema.enumNames : []
    const options = values.flatMap((value, index) => {
      /* v8 ignore next -- the SDK's form schema types every enum member as a string */
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return []
      return [{ label: stringOf(names[index]) ?? String(value), value }]
    })
    return options.length > 0 ? options : undefined
  }
  return undefined
}

/**
 * Build the presented question and answer encoding for one form property.
 *
 * @param id - Property key.
 * @param schema - Property schema.
 * @param message - The server's human-readable request message, repeated as
 *   per-question supporting detail because the harness presents one question
 *   at a time.
 * @returns The field, or undefined when the property is not a record.
 */
function formFieldOf(id: string, schema: unknown, message: string): FormField | undefined {
  /* v8 ignore next -- the SDK's form schema types every property as an object */
  if (!isRecord(schema)) return undefined
  const title = stringOf(schema.title)
  const description = stringOf(schema.description)
  const detail = [message, description].filter((part): part is string => part !== undefined).join('\n\n')
  const question: AskUserQuestionItem = {
    id,
    question: title ?? id,
    ...detail === '' ? {} : { detail },
  }
  const withOptions = (
    kind: FormField['kind'],
    options: FormField['options'],
    multiSelect: boolean,
  ): FormField => ({
    id,
    kind,
    ...options === undefined ? {} : { options },
    multiSelect,
    question: {
      ...question,
      ...options === undefined ? {} : { options: options.map(option => ({ label: option.label })) },
      ...multiSelect ? { multiSelect: true } : {},
    },
  })

  if (schema.type === 'array') {
    /* v8 ignore next -- the SDK's form schema types array items as an object */
    const options = isRecord(schema.items) ? enumOptionsOf(schema.items) : undefined
    return withOptions(options === undefined ? 'text' : 'enum', options, true)
  }
  const options = enumOptionsOf(schema)
  if (options !== undefined) return withOptions('enum', options, false)
  switch (schema.type) {
    case 'boolean':
      return withOptions('boolean', [{ label: 'true', value: true }, { label: 'false', value: false }], false)
    case 'number':
      return withOptions('number', undefined, false)
    case 'integer':
      return withOptions('integer', undefined, false)
    default:
      return withOptions('text', undefined, false)
  }
}

/**
 * Translate a form-mode elicitation request into harness questions.
 *
 * @param params - Validated form-mode elicitation parameters.
 * @returns One field per declared property, in schema order.
 */
function formFieldsOf(params: ElicitRequestFormParams): FormField[] {
  const requestedSchema = params.requestedSchema
  /* v8 ignore next -- the SDK's form schema requires requestedSchema.properties to be a record */
  if (!isRecord(requestedSchema) || !isRecord(requestedSchema.properties)) return []
  const message = stringOf(params.message) ?? ''
  return Object.entries(requestedSchema.properties).flatMap(([id, schema]) => {
    const field = formFieldOf(id, schema, message)
    /* v8 ignore next -- formFieldOf only returns undefined for a non-object property schema */
    return field === undefined ? [] : [field]
  })
}

/** Read the free-text value of one answer, if the human supplied one. */
function textOfAnswer(answer: AskUserQuestionAnswer['answers'][number]): string | undefined {
  return stringOf(answer.custom) ?? stringOf(answer.selected[0])
}

/** Wire value an elicitation form property may accept back. */
type ElicitContentValue = string | number | boolean | string[]

/**
 * Encode one field's answer as its wire value.
 *
 * @param field - The field the answer belongs to.
 * @param answer - The matching answer, when the human answered the question.
 * @returns The wire value, or undefined when nothing usable was answered.
 */
function valueOfField(field: FormField, answer: AskUserQuestionAnswer['answers'][number] | undefined): ElicitContentValue | undefined {
  if (answer === undefined) return undefined
  switch (field.kind) {
    case 'text':
      return textOfAnswer(answer)
    case 'number': {
      const text = textOfAnswer(answer)
      if (text === undefined) return undefined
      const value = Number(text)
      return Number.isFinite(value) ? value : undefined
    }
    case 'integer': {
      const text = textOfAnswer(answer)
      if (text === undefined) return undefined
      const value = Number(text)
      return Number.isInteger(value) ? value : undefined
    }
    case 'boolean': {
      const text = textOfAnswer(answer)?.trim().toLowerCase()
      if (text === 'true') return true
      if (text === 'false') return false
      return undefined
    }
    case 'enum': {
      const labelOf = (value: string): string | number | boolean | undefined =>
        field.options?.find(option => option.label === value)?.value
      if (field.multiSelect) {
        const values = answer.selected.flatMap((label) => {
          const value = labelOf(label)
          /* v8 ignore next -- the SDK's form schema types every multi-select enum member as a string */
          return typeof value === 'string' ? [value] : []
        })
        const custom = stringOf(answer.custom)
        if (custom !== undefined) values.push(custom)
        return values.length === 0 ? undefined : values
      }
      const selected = answer.selected[0]
      if (selected !== undefined) {
        const value = labelOf(selected)
        if (value !== undefined) return value
      }
      return stringOf(answer.custom)
    }
  }
}

/**
 * Build the elicitation result from one harness answer.
 *
 * A fully unanswered submission encodes as `decline`, matching the spec's
 * three-action model; the harness UI's skip and cancel paths both surface as
 * an answer with no values.
 *
 * @param fields - Fields the request declared.
 * @param answer - The human's answer.
 * @returns The wire result for the embedded request.
 */
function resultOfAnswer(fields: readonly FormField[], answer: AskUserQuestionAnswer): ElicitResult {
  const content: Record<string, ElicitContentValue> = {}
  for (const field of fields) {
    const value = valueOfField(field, answer.answers.find(item => item.id === field.id))
    if (value !== undefined) content[field.id] = value
  }
  return Object.keys(content).length === 0
    ? { action: 'decline' }
    : { action: 'accept', content }
}

/** Narrow a validated elicitation request to its form-mode parameters. */
function formParamsOf(request: ElicitRequest): ElicitRequestFormParams | undefined {
  return 'requestedSchema' in request.params ? request.params : undefined
}

/**
 * Fulfil one elicitation request through `ctx.userQuestions`.
 *
 * @param ctx - Active plugin context owning the `userQuestions` seam.
 * @param request - The embedded elicitation request.
 * @param signal - Cancellation lifetime chained from the originating call.
 * @param agent - The attributed asking agent, when known.
 * @returns The wire result the client retries with.
 * @throws {UserQuestionError} For every failure other than a user cancel or
 *   an aborted lifetime, so the tool call fails visibly instead of silently
 *   declining a request the human never saw.
 */
export async function answerElicitation(
  ctx: Context,
  request: ElicitRequest,
  signal: AbortSignal,
  agent: NonNullable<ToolExecution['agent']> | undefined,
): Promise<ElicitResult> {
  const params = formParamsOf(request)
  if (params === undefined) return { action: 'cancel' }
  const fields = formFieldsOf(params)
  try {
    const answer = await ctx.userQuestions.ask({
      questions: fields.map(field => field.question),
      ...agent === undefined ? {} : { agent },
      signal,
    })
    return resultOfAnswer(fields, answer)
  } catch (error) {
    if (error instanceof UserQuestionError
      && (error.code === 'ASK_ABORTED' || error.code === 'ASK_CANCELLED')) {
      return { action: 'cancel' }
    }
    throw error
  }
}

/**
 * Register the form-mode elicitation handler for one client generation.
 *
 * The caller must register only when `ctx.userQuestions` is mounted and the
 * matching capability is declared; the SDK rejects a handler whose capability
 * is absent.
 *
 * @param client - The connected client generation.
 * @param ctx - Active plugin context owning the `userQuestions` seam.
 * @param broker - In-flight execution registry for agent attribution.
 * @param label - Diagnostic prefix for attributed-overlap warnings.
 */
export function registerElicitation(
  client: Client,
  ctx: Context,
  broker: ElicitationBroker,
  label: string,
): void {
  client.setRequestHandler('elicitation/create', async (request, requestContext) => {
    const attribution = broker.attribution()
    if (attribution.kind === 'ambiguous') {
      ctx.logger.warn(
        `${label}: refusing elicitation/create while tool calls for different agents are in flight; `
        + 'the asking agent cannot be identified',
      )
      return { action: 'cancel' }
    }
    return await answerElicitation(ctx, request, requestContext.mcpReq.signal, attribution.agent)
  })
}
