# Agent Note: 将 MCP 客户端桥接迁移到协议修订版 2026-07-28

Status: implemented

[English](2026-09-12-mcp-2026-07-28-client-migration.md) | 中文

## 问题

`@deepseek-ai/dsh-mcp-client` 挂载外部 Model Context Protocol 服务器，使其工具可作为原生工具调用。CLI 将其作为 patch 层的依赖随附；默认不启用任何服务器。

该包曾固定使用 `@modelcontextprotocol/sdk@^1.12.0`（解析为 1.29.0），即握手时代的 SDK。该 SDK 表述的是 `2025-11-25` 及之前的协议形态：`initialize` 握手建立会话，能力在连接建立时协商一次，服务器可以在该连接上发起服务器到客户端的请求。

协议修订版 `2026-07-28` 移除了这三种机制。每个请求都在 `_meta` 中自带协议版本与客户端能力；`server/discover` 取代能力交换；服务器发起的请求被多轮往返请求（MRTR）取代——服务器以 `resultType: "input_required"` 回应 `tools/call`，客户端携带 `inputResponses` 重试。同一修订版还弃用了 Roots、Sampling、Logging 与 Dynamic Client Registration，并以单一的 `subscriptions/listen` 流取代 `resources/subscribe` 与 HTTP GET 端点。

因此该桥接无法服务仅支持新修订版的服务器，无法利用无状态部署，并且会静默依赖三项已被规范排定移除的能力。

## 现状

桥接依赖 `@modelcontextprotocol/client@2` 及其再导出的 `@modelcontextprotocol/core` 底层，并以 `@modelcontextprotocol/server@2` 作为现代 fixture 服务器的 devDependency。v1 SDK 仍保留为 devDependency，因为较早的 fixture 服务器是 v1，而它们正是双时代路径必须继续服务的 2025 时代对端。由于 v2 的 `versionNegotiation` 默认走旧版握手，未设置 `protocolEra` 的连接仍逐字节发送与迁移前相同的流量；选择现代修订版是经校验的 `Config` 字段，而非常量。

有两条由桥接自己掌控的请求路径被有意保留。`tools/list` 使用 v2 的类型化 request 重载，它按 method 名解析协议结果 schema，且从不写入 SDK 响应缓存。`tools/call` 则改传桥接自己的宽松 zod 结果 schema，因为现实中的服务器会返回违反协议 schema 的 content 数组，而 `extractText` 已经会逐个报告无法识别的 block；若使用协议 schema，整个结果会在桥接能够描述收到什么之前就被拒绝。

## 决定

时代协商属于配置。`protocolEra` 接受 `'legacy'`（默认）、`'auto'` 或 `{ pin: '2026-07-28' }`；`resolveProtocolEra` 在 `apply` 中、任何 effect 注册之前完成校验，因此不受支持的 pin 在加载时即失败，而不是等到连接时。随后 v2 客户端协商时代（`versionNegotiation`、`ProtocolEra`），在现代连接上附加保留的逐请求 `_meta` 信封，并对 `2025-11-25` 服务器回退到旧版握手。桥接在构造时提供自身身份与能力，不手工构造该信封。

MRTR 通过已有的 harness seam 完成。v2 客户端自动完成 `input_required` 结果：将每个内嵌请求路由到按其 method 注册的 handler，携带 `inputResponses` 与逐字节回显的 `requestState` 重试原始调用，轮数上限由 `maxRounds`（经校验的字段，默认 10）控制。因此桥接注册 handler，而不是实现重试循环：

| 内嵌请求 | 注册 |
|---|---|
| `elicitation/create` | 注册；form 模式映射到 `ctx.userQuestions` |
| `sampling/createMessage` | 不注册——已弃用；工具调用显式失败 |
| `roots/list` | 不注册——已弃用；工作区路径改为显式传参 |

能力由已挂载的 seam 推导，绝不硬编码。仅当 `ctx.userQuestions` 存在时，桥接才声明 `elicitation: { form: {} }`，并在该 seam 存在时于连接前注册其 elicitation handler；且绝不声明 `url` 模式，因为 CLI 与 Web 都没有实现 URL 模式 elicitation 所要求的同意界面。它也不声明任何已弃用的 sampling、roots 或 logging 能力，因此请求这些能力的服务器会收到 `MissingRequiredClientCapabilityError`（`-32021`），工具调用显式失败而不是挂起。

列表变更改由 listen 流承载。桥接以 `autoRefresh: false` 传入 SDK 的 `listChanged` 选项，因此由 SDK 安装 handler，并在现代时代于服务器声明该能力时自行开启 `subscriptions/listen` 流。handler 清除缓存的工具列表，并通过监督器的单一队列排队一次重新同步；未声明该能力却更改列表的服务器会在下次重连或重载时才被发现。

列表结果变得可缓存。现代 `tools/list` 结果携带 `ttlMs` 与 `cacheScope`；桥接把聚合后的描述符——从不是绑定到客户端的定义——存入按 `(serverName, 授权摘要)` 索引的 `ToolListCache`，在该新鲜度窗口内提供服务，并在列表变更与 dispose 时清除条目。缺失或未知的范围按 `private` 处理，且授权摘要始终是键的一部分，因此 `public` 结果绝不会扩大为跨授权复用。

elicitation 按在飞调用归属到 agent。SDK 的 elicitation handler 是连接级的、不携带调用身份，因此 `ElicitationBroker` 跟踪在飞的工具执行并据此解析 agent：唯一且明确的 agent 是确定的，因为服务器只能在其正在处理的请求内发起 elicitation；无 agent 的执行不表达意见；两个或更多不同 agent 时取消该提问，而不是把它展示给错误的 agent。

## 已验证的 SDK 状态

针对已发布的 `@modelcontextprotocol/client@2.0.0` 包核对：它是纯 ESM（`"type": "module"`）且要求 Node `>=20`，二者均满足本仓库 `^22.19 || >=24` 的引擎范围与全仓库 ESM 约定。其类型导出 `ProtocolEra`、`SUPPORTED_PROTOCOL_VERSIONS`、`withInputRequired`、`InputRequiredOptions`、`SubscriptionsListenRequest`、`SubscriptionFilter`、`DiscoverRequest`、`DiscoverResult`、`RequestStateAccessor` 以及 task 类型。其文档说明：在现代连接上会逐请求自动附加 `_meta` 信封；MRTR 默认通过已注册的 handler 自动完成；并且自 `2026-07-28` 起 `roots/list` 与 `sampling/createMessage` 的 handler 接口已弃用。

因此 v2 客户端已经实现了本 note「问题」一节所指的三项缺失机制。桥接的工作量在于依赖、配置、handler 注册，以及缓存与订阅接线，而不在于协议实现。

## 非目标

由本 harness 提供 MCP 服务。mcp-client 的 Agent Note 已记录：暴露 harness 为 agent 的角色由 ACP 承担，本 note 不重新讨论该决定。桥接 MCP resources 与 prompts 仍属推迟。采用 Tasks、MCP Apps 或 Enterprise-Managed Authorization 扩展不在范围内；`extensions` 留空，使服务器看不到我们并未真正提供的能力。

## 备选方案

**继续使用 v1 SDK，手工实现该修订版。** 否决：这会重新实现时代协商、`_meta` 信封、MRTR 轮次管理与订阅解复用——正是受维护的客户端已经提供的机制，违背「优先使用受维护依赖而非手工实现」的政策。

**不依赖 SDK，编写最小 MCP 客户端。** 同样否决，且额外需要自行承担对一个仍在演进的规范的符合性。

**在 elicitation 之外一并实现 sampling 与 roots。** 否决：两者均已弃用并有明确移除窗口；sampling 需要就「第二次模型请求成为模型可见并入日志」作出专门决策；roots 会为一项规范正在退役的能力向第三方服务器披露工作区路径。

**在同一次变更中升级 `subagent-claude-code`。** 否决，没有必要：其源码并未 import 该 SDK，且 v2 的包名不同，二者可以共存。改动它只会扩大 diff 而不改变行为。

**等待 MCP 服务器先迁移，再改动客户端。** 否决：该修订版的兼容模型要求客户端先行，而双时代桥接用一条代码路径同时服务两类服务器。

**无条件启用时代协商。** 否决：`'auto'` 会在发送 `initialize` 握手之前先用 `server/discover` 探测服务器，而一个因无关原因失败的服务器可能被误判为 `2025-11-25`。默认保持 `'legacy'`，使既有配置项不改变其发送内容；在不希望依赖该启发式的地方可以使用 `{ pin }`。

## 后果

- 双时代运行是真实并存而非替换：同一个 fixture 工厂服务两个时代并注册完全一致的工具名，`2025-11-25` 服务器通过未改动的握手继续工作。
- 默认路径未变，因此既有部署在线路上逐字节一致，录制会话快照不发生移动。
- 拒绝已弃用能力是可见的行为变更：仅提供 roots 或 sampling 的服务器现在会产生能力错误，而旧桥接会尝试交互。包的 README 已说明这一点。
- 自动完成会在每个 MRTR 轮次重新执行服务器的工作，因此 `maxRounds` 为一次调用设定上界，既有的每次调用超时覆盖全部轮次；带副作用的工具服务器必须能容忍重复执行，这是桥接无法验证的属性。
- stdio 的时代探测没有状态码，因此 `'auto'` 只能依据「无法识别的错误」回退，在这一点重要的场合可用 `{ pin }` 规避该启发式。
- 缓存范围是正确性风险，桥接以保守方式处理：未知范围视为 `private`，授权摘要绝不会从键中移除，代价是每个授权各有一份缓存条目。
- sampling 与 roots 保持未实现而不是降级实现，代价是放弃服务器发起的模型调用与根目录披露，直到有单独的决定覆盖它们。
- SDK v2 尚新，时代协商、自动完成与列表变更处理都是本次迁移的承重部分。

## 验证

- `tests/elicitation.spec.ts` 覆盖每个 elicitation 表单字段的映射与答案编码，并固定 broker 的唯一 agent 与歧义归属行为。
- `tests/tool-list-cache.spec.ts` 固定摘要分区、范围与 TTL 归一化、新鲜度边界、清除与条目数量上界。
- `tests/apply.spec.ts` 固定时代与轮数默认值、不受支持 pin 的拒绝、仅在提问服务挂载时注册能力与 handler，以及重新同步路径。
- `tests/mcp-client.e2e.ts` 让 v2 fixture 运行于两个时代：一致的工具名、经 `ctx.userQuestions` 应答的 MRTR elicitation、sampling 与 roots 的显式失败、经订阅送达的列表变更，以及先复用描述符再将其清除。
- `apps/cli/tests/memory-mcp-configs.spec.ts` 与录制会话快照保持通过，固定旧版默认路径及其模型可见输出未变。
