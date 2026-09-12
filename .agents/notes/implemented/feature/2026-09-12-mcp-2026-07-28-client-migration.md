# Agent Note: Migrate the MCP client bridge to protocol revision 2026-07-28

Status: implemented

English | [中文](2026-09-12-mcp-2026-07-28-client-migration.zh.md)

## Problem

`@deepseek-ai/dsh-mcp-client` attaches external Model Context Protocol servers so their tools are callable as native tools. The CLI ships it as a dependency for patch layers; nothing enables a server by default.

It was pinned to `@modelcontextprotocol/sdk@^1.12.0` (1.29.0 resolved), the handshake-era SDK. That SDK speaks the protocol the way it existed through `2025-11-25`: an `initialize` handshake establishes a session, capabilities are negotiated once per connection, and servers may open server-to-client requests over the connection.

Protocol revision `2026-07-28` removes all three mechanisms. Every request carries its own protocol version and client capabilities in `_meta`; `server/discover` replaces the capability exchange; and server-initiated requests are replaced by Multi Round-Trip Requests (MRTR), where a server answers `tools/call` with `resultType: "input_required"` and the client retries with `inputResponses`. The same revision deprecates Roots, Sampling, Logging, and Dynamic Client Registration, and replaces `resources/subscribe` and the HTTP GET endpoint with a single `subscriptions/listen` stream.

Consequently the bridge could not serve a modern-only server, could not take advantage of stateless deployment, and silently depended on three capabilities the specification scheduled for removal.

## Current state

The bridge depends on `@modelcontextprotocol/client@2` with the `@modelcontextprotocol/core` substrate it re-exports, and on `@modelcontextprotocol/server@2` as a devDependency for the modern fixture server. The v1 SDK stays a devDependency because the older fixture servers are v1, and they are exactly the 2025-era peers the dual-era path must keep serving. Because v2's `versionNegotiation` defaults to the legacy handshake, a connection without `protocolEra` still sends the traffic the previous bridge sent, byte for byte; opting into the modern revision is a validated `Config` field, never a constant.

Two bridge-owned request paths stay deliberate. `tools/list` uses v2's typed request overload, which resolves the protocol result schema from the method name and never writes the SDK response cache. `tools/call` passes the bridge's own permissive zod result schema instead, because servers in the wild return content arrays that violate the protocol schema, and `extractText` already reports each unrecognized block; the protocol schema would reject the whole result before the bridge could describe what arrived.

## Decision

Era negotiation is configuration. `protocolEra` accepts `'legacy'` (the default), `'auto'`, or `{ pin: '2026-07-28' }`; `resolveProtocolEra` validates it in `apply` before any effect registers, so an unsupported pin fails at load rather than at connect. The v2 client then negotiates the era (`versionNegotiation`, `ProtocolEra`), attaches the reserved per-request `_meta` envelope on a modern connection, and falls back to the legacy handshake for `2025-11-25` servers. The bridge supplies its identity and capabilities at construction and never hand-builds the envelope.

MRTR is fulfilled through existing harness seams. The v2 client auto-fulfils `input_required` results by routing each embedded request through the handler registered for its method, retrying the original call with `inputResponses` and a byte-exact echo of `requestState`, up to `maxRounds` (a validated field, default 10). The bridge therefore registers handlers rather than implementing a retry loop:

| Embedded request | Registration |
|---|---|
| `elicitation/create` | Registered; form mode maps to `ctx.userQuestions` |
| `sampling/createMessage` | Not registered — deprecated; the tool call fails visibly |
| `roots/list` | Not registered — deprecated; workspace paths are passed explicitly instead |

Capabilities are derived from the mounted seams, never hardcoded. The bridge declares `elicitation: { form: {} }` only when `ctx.userQuestions` is present, registers its elicitation handler before connecting when that seam exists, and never declares `url` mode, because no CLI or Web surface implements the consent UX that URL-mode elicitation requires. It also declares none of the deprecated sampling, roots, or logging capabilities, so a server requesting them receives `MissingRequiredClientCapabilityError` (`-32021`) and the tool call fails visibly instead of hanging.

List changes move to the listen stream. The bridge passes the SDK's `listChanged` option with `autoRefresh: false`, so the SDK installs the handler and, on the modern era, opens the `subscriptions/listen` stream itself when the server advertises the capability. The handler evicts the cached tool list and queues a re-sync through the supervisor's single queue; a server that changes its list without advertising the capability is picked up on the next reconnect or reload.

List results are cacheable. Modern `tools/list` results carry `ttlMs` and `cacheScope`; the bridge stores the aggregated descriptors — never client-bound definitions — in `ToolListCache` keyed by `(serverName, authorization digest)`, serves them inside the freshness window, and evicts the entry on a list change and on disposal. An absent or unknown scope counts as `private`, and the digest is always part of the key, so a `public` result is never widened into cross-authorization reuse.

Elicitation is attributed to an agent by in-flight call. The SDK's elicitation handler is connection-scoped and carries no call identity, so `ElicitationBroker` tracks the tool executions in flight and resolves the agent from them: a single distinct agent is certain because a server can only elicit inside a request it is processing, an agent-less execution expresses no opinion, and two or more distinct agents cancel the question rather than show it to the wrong agent.

## Verified SDK state

Checked against the published `@modelcontextprotocol/client@2.0.0` package: it is ESM-only (`"type": "module"`) and requires Node `>=20`, both satisfied by this repository's `^22.19 || >=24` engine range and ESM-everywhere convention. Its types export `ProtocolEra`, `SUPPORTED_PROTOCOL_VERSIONS`, `withInputRequired`, `InputRequiredOptions`, `SubscriptionsListenRequest`, `SubscriptionFilter`, `DiscoverRequest`, `DiscoverResult`, `RequestStateAccessor`, and the task types. Its documentation states that on a modern connection the per-request `_meta` envelope is attached automatically, that MRTR is auto-fulfilled through registered handlers by default, and that the `roots/list` and `sampling/createMessage` handler surfaces are deprecated as of `2026-07-28`.

The v2 client therefore implements the three mechanisms this note's Problem identified as missing. The bridge's work was dependency, configuration, handler registration, and cache and subscription wiring, not protocol implementation.

## Non-goals

Serving MCP from this harness. The mcp-client Agent Note records that ACP already covers exposing the harness as an agent, and that decision is not revisited here. Bridging MCP resources and prompts remains deferred. Adopting the Tasks, MCP Apps, or Enterprise-Managed Authorization extensions is out of scope; `extensions` is left empty so a server sees no support it would not get.

## Alternatives considered

**Stay on the v1 SDK and implement the revision by hand.** Rejected: it reimplements era negotiation, the `_meta` envelope, MRTR round management, and subscription demultiplexing — the exact machinery the maintained client already ships, contrary to the dependencies-over-hand-rolling policy.

**Write a minimal MCP client with no SDK dependency.** Rejected for the same reason, with the added cost of owning conformance to a specification that is still moving.

**Implement sampling and roots alongside elicitation.** Rejected: both are deprecated with dated removal windows, sampling would require a deliberate decision about a second model request becoming model-visible and logged, and roots would disclose workspace paths to a third-party server for a capability the specification is retiring.

**Upgrade `subagent-claude-code` in the same change.** Rejected as unnecessary: it does not import the SDK in its source, and v2's distinct package names mean the two can coexist. Touching it would widen the diff without changing behavior.

**Wait for MCP servers to migrate before changing the client.** Rejected: the revision's compatibility model expects clients to lead, and a dual-era bridge serves both populations with one code path.

**Enable era negotiation unconditionally.** Rejected: `'auto'` probes a server with `server/discover` before it sends an `initialize` handshake, and a server that fails for an unrelated reason can be misread as `2025-11-25`. The default stays `'legacy'` so no existing entry changes what it sends, and `{ pin }` is available where the heuristic is unwelcome.

## Consequences

- Dual-era operation is real rather than a replacement: one fixture factory serves both eras and registers identical tool names, and `2025-11-25` servers keep working through the unchanged handshake.
- The default path is unchanged, so existing deployments stay byte-identical on the wire and the recorded-session snapshots do not move.
- Refusing deprecated capabilities is a visible behavior change: a server that only offers roots or sampling now produces a capability error where the old bridge attempted the interaction. The package README states this.
- Auto-fulfilment re-executes the server's work once per MRTR round, so `maxRounds` bounds a call and the existing per-call timeout covers every round; a server with side-effecting tools must tolerate re-execution, a property the bridge cannot verify.
- stdio era detection has no status code, so `'auto'` keys the fallback on an unrecognized error and `{ pin }` avoids the heuristic where that matters.
- Cache scope is a correctness hazard the bridge resolves conservatively: unknown scope is `private`, and the authorization digest can never be dropped from the key, at the cost of a cache entry per authorization.
- Sampling and roots remain unimplemented rather than degraded, which gives up server-initiated model calls and root disclosure until a separate decision covers them.
- SDK v2 is young and era negotiation, auto-fulfilment, and list-changed handling are load-bearing for this migration.

## Verification

- `tests/elicitation.spec.ts` maps every elicitation form field, encodes answers, and pins the broker's sole-agent and ambiguous attribution.
- `tests/tool-list-cache.spec.ts` pins digest partitioning, scope and TTL normalization, the freshness boundary, eviction, and the bounded entry count.
- `tests/apply.spec.ts` pins the era and round defaults, rejection of an unsupported pin, capability and handler registration only when the question service is mounted, and the re-sync path.
- `tests/mcp-client.e2e.ts` runs the v2 fixture over both eras: identical tool names, an MRTR elicitation answered through `ctx.userQuestions`, visible failures for sampling and roots, a list change delivered over the subscription, and descriptor reuse followed by eviction.
- `apps/cli/tests/memory-mcp-configs.spec.ts` and the recorded-session snapshots stay green, pinning that the legacy default and its model-visible output are unchanged.
