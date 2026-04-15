import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import {
	EXTENSION_NAME,
	type AgentMeta,
	type ZoneEvent,
	buildVisibleZoneIds,
	emitZoneEvent,
	extractTextFromContent,
	getAgentMeta,
	getDescendantAgentIds,
	isAgentSubtreeAlive,
	killAgentProcess,
	loadOrCreateCurrentAgent,
	markAgentAlive,
	renderProjectionMarkdown,
	renderSessionBranchSnapshot,
	randomId,
	refreshAgentLiveness,
	spawnChildProcess,
	syncVisibleEvents,
	type RuntimePaths,
} from "./runtime.js";

const EXTENSION_FILE_PATH =
	typeof __filename !== "undefined" ? __filename : fileURLToPath(import.meta.url);

function nowIso(): string {
	return new Date().toISOString();
}

function stringify(value: unknown): string {
	try {
		return typeof value === "string" ? value : JSON.stringify(value);
	} catch {
		return String(value);
	}
}

function refreshForkzoneRuntime(paths: RuntimePaths, agent: AgentMeta): void {
	refreshAgentLiveness(paths, agent.agentId);
	syncVisibleEvents(paths, agent);
	const refreshed = getAgentMeta(paths, agent.agentId);
	if (!refreshed) return;
	agent.alive = refreshed.alive;
	agent.lastStatus = refreshed.lastStatus;
	agent.lastStatusAt = refreshed.lastStatusAt;
	agent.pid = refreshed.pid;
}

function buildProjectionMessage(paths: RuntimePaths, agent: AgentMeta): string {
	const visible = buildVisibleZoneIds(paths, agent);
	const projection = renderProjectionMarkdown(paths, agent);
	if (!projection.trim()) return "";
	return [
		"[FORKZONE ROUTED CONTEXT]",
		`Current agent: ${agent.agentId} (${agent.name})`,
		`Current zone: ${agent.zoneId}`,
		`Current state: ${agent.alive ? "alive" : agent.lastStatus ?? "dead"}`,
		`Visible zones: ${visible.join(", ")}`,
		"",
		projection,
	].join("\n");
}

function insertProjection(messages: any[], projection: string): any[] {
	if (!projection.trim()) return messages;
	const custom = {
		customType: "forkzones-context",
		content: projection,
		display: false,
	};
	let insertionIndex = messages.length;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as { role?: string } | undefined;
		if (msg?.role === "user") {
			insertionIndex = i;
			break;
		}
	}
	return [...messages.slice(0, insertionIndex), custom, ...messages.slice(insertionIndex)];
}

function makeEvent(agent: AgentMeta, kind: ZoneEvent["kind"], payload: Record<string, unknown>): ZoneEvent {
	return {
		eventId: randomId("evt"),
		timestamp: nowIso(),
		zoneId: agent.zoneId,
		emittingAgentId: agent.agentId,
		kind,
		payload,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function updateStatus(ctx: ExtensionContext, _paths: RuntimePaths, agent: AgentMeta): void {
	ctx.ui.setStatus(
		EXTENSION_NAME,
		ctx.ui.theme.fg("accent", `zone ${agent.name}:${agent.agentId} ${agent.alive ? "alive" : "dead"}`),
	);
}

function buildSpawnSnapshot(ctx: ExtensionContext, paths: RuntimePaths, agent: AgentMeta, task: string): string {
	const entries = ctx.sessionManager.getBranch();
	const direct = renderSessionBranchSnapshot(entries as unknown[]);
	const projection = buildProjectionMessage(paths, agent);
	return [
		"# Spawn snapshot",
		"",
		`Spawner agent: ${agent.agentId} (${agent.name})`,
		`Spawner zone: ${agent.zoneId}`,
		`Snapshot created: ${nowIso()}`,
		"",
		direct,
		"",
		projection,
		"",
		"# Delegated task",
		"",
		task,
	].join("\n");
}

async function joinAgentSubtree(
	paths: RuntimePaths,
	caller: AgentMeta,
	targetAgentId: string,
	timeoutSeconds: number | undefined,
	signal: AbortSignal | undefined,
): Promise<void> {
	const target = getAgentMeta(paths, targetAgentId);
	if (!target) throw new Error(`Unknown agent: ${targetAgentId}`);
	const deadline = timeoutSeconds && timeoutSeconds > 0 ? Date.now() + timeoutSeconds * 1000 : undefined;
	while (true) {
		refreshAgentLiveness(paths, caller.agentId);
		syncVisibleEvents(paths, caller);
		if (!isAgentSubtreeAlive(paths, targetAgentId)) break;
		if (signal?.aborted) throw new Error("Join aborted.");
		if (deadline && Date.now() > deadline) throw new Error(`Timed out joining ${targetAgentId}.`);
		await sleep(500);
	}
	refreshAgentLiveness(paths, caller.agentId);
	syncVisibleEvents(paths, caller);
	const refreshed = getAgentMeta(paths, caller.agentId);
	if (refreshed) {
		caller.alive = refreshed.alive;
		caller.lastStatus = refreshed.lastStatus;
		caller.lastStatusAt = refreshed.lastStatusAt;
		caller.pid = refreshed.pid;
	}
}

async function buildCompactionSummary(
	ctx: ExtensionContext,
	paths: RuntimePaths,
	agent: AgentMeta,
	messagesToSummarize: unknown[],
	previousSummary: string | undefined,
	signal: AbortSignal,
): Promise<string | null> {
	if (!ctx.model) return null;
	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
	if (!auth.ok || !auth.apiKey) return null;
	const projection = buildProjectionMessage(paths, agent);
	const conversationText = serializeConversation(convertToLlm(messagesToSummarize as any[]));
	const previousBlock = previousSummary ? `\nPrevious compaction summary:\n${previousSummary}\n` : "";
	const prompt = `You are summarizing an agent-local transcript for a recursive forkzone system.
Preserve the important direct conversation state, important tool outcomes, and the live/dead state of visible zone spans.
Do not drop the fact that zones are spans with headers and routed history.
Summarize concisely but preserve enough detail to continue work.

${previousBlock}
Current visible forkzone span projection:
${projection || "(none)"}

Conversation/messages being compacted:
<conversation>
${conversationText}
</conversation>

Return markdown with these sections when relevant:
- Current goal
- Decisions/state
- Visible zone spans
- Important tool results
- Next useful steps`;
	const response = await complete(
		ctx.model,
		{
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
			maxTokens: 4096,
			signal,
		},
	);
	const summary = response.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n")
		.trim();
	return summary || null;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	let currentAgent: AgentMeta | undefined;
	let runtimePaths: RuntimePaths | undefined;

	function requireState(): { agent: AgentMeta; paths: RuntimePaths } {
		if (!currentAgent || !runtimePaths) throw new Error("subagent runtime not initialized yet");
		return { agent: currentAgent, paths: runtimePaths };
	}

	async function spawnAgentFromTask(
		task: string,
		name: string | undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Record<string, unknown>>> {
		const { agent, paths } = requireState();
		const snapshotMarkdown = buildSpawnSnapshot(ctx, paths, agent, task);
		const child = spawnChildProcess(paths, agent, {
			name,
			task,
			snapshotMarkdown,
			extensionPath: EXTENSION_FILE_PATH,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinkingLevel: pi.getThinkingLevel(),
		});
		emitZoneEvent(paths, makeEvent(agent, "spawn", {
			childAgentId: child.agentId,
			childZoneId: child.zoneId,
			task,
			name: child.name,
		}));
		updateStatus(ctx, paths, agent);
		return {
			content: [
				{
					type: "text",
					text: `Spawned subagent ${child.name} (${child.agentId}) in zone ${child.zoneId}.`,
				},
			],
			details: {
				agentId: child.agentId,
				zoneId: child.zoneId,
				pid: child.pid,
			},
		};
	}

	pi.on("session_start", async (_event, ctx) => {
		const { paths, agent } = loadOrCreateCurrentAgent(ctx.cwd);
		runtimePaths = paths;
		currentAgent = agent;
		markAgentAlive(paths, agent.agentId, true, "alive");
		refreshForkzoneRuntime(paths, agent);
		updateStatus(ctx, paths, agent);
		emitZoneEvent(paths, makeEvent(agent, "status", { text: `agent online pid=${process.pid}` }));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		if (!currentAgent || !runtimePaths) return;
		markAgentAlive(runtimePaths, currentAgent.agentId, false, "stopped");
		emitZoneEvent(runtimePaths, makeEvent(currentAgent, "terminal", { status: "stopped" }));
		updateStatus(ctx, runtimePaths, currentAgent);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!currentAgent || !runtimePaths) return;
		refreshForkzoneRuntime(runtimePaths, currentAgent);
		updateStatus(ctx, runtimePaths, currentAgent);
		const projection = buildProjectionMessage(runtimePaths, currentAgent);
		if (!projection) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${projection}`,
		};
	});

	pi.on("context", async (event, ctx) => {
		if (!currentAgent || !runtimePaths) return;
		refreshForkzoneRuntime(runtimePaths, currentAgent);
		updateStatus(ctx, runtimePaths, currentAgent);
		const projection = buildProjectionMessage(runtimePaths, currentAgent);
		if (!projection) return;
		return { messages: insertProjection(event.messages as any[], projection) };
	});

	pi.on("message_end", async (event) => {
		if (!currentAgent || !runtimePaths) return;
		const message = event.message as { role?: string; content?: unknown; customType?: string };
		if ((message as { customType?: string }).customType === "forkzones-context") return;
		if (message.role === "user") {
			emitZoneEvent(runtimePaths, makeEvent(currentAgent, "user_message", { text: extractTextFromContent(message.content) }));
		}
		if (message.role === "assistant") {
			const text = extractTextFromContent(message.content);
			if (text.trim()) emitZoneEvent(runtimePaths, makeEvent(currentAgent, "assistant_message", { text }));
		}
	});

	pi.on("tool_execution_start", async (event) => {
		if (!currentAgent || !runtimePaths) return;
		emitZoneEvent(runtimePaths, makeEvent(currentAgent, "tool_call", {
			toolName: event.toolName,
			args: stringify(event.args),
		}));
	});

	pi.on("tool_execution_end", async (event) => {
		if (!currentAgent || !runtimePaths) return;
		emitZoneEvent(runtimePaths, makeEvent(currentAgent, "tool_result", {
			toolName: event.toolName,
			output: stringify(event.result),
			isError: event.isError,
		}));
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!currentAgent || !runtimePaths) return;
		refreshForkzoneRuntime(runtimePaths, currentAgent);
		const { preparation, signal } = event;
		try {
			const summary = await buildCompactionSummary(
				ctx,
				runtimePaths,
				currentAgent,
				[...preparation.messagesToSummarize, ...preparation.turnPrefixMessages],
				preparation.previousSummary,
				signal,
			);
			if (!summary) return;
			return {
				compaction: {
					summary,
					firstKeptEntryId: preparation.firstKeptEntryId,
					tokensBefore: preparation.tokensBefore,
				},
			};
		} catch {
			return;
		}
	});

	pi.on("session_compact", async (event) => {
		if (!currentAgent || !runtimePaths) return;
		emitZoneEvent(runtimePaths, makeEvent(currentAgent, "compaction", {
			summary: event.compactionEntry.summary,
		}));
	});

	pi.registerCommand("subagent-spawn", {
		description: "Spawn a background subagent for a task",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /subagent-spawn <task>", "warning");
				return;
			}
			const result = await spawnAgentFromTask(task, undefined, ctx);
			ctx.ui.notify(extractTextFromContent(result.content), "success");
		},
	});

	pi.registerCommand("subagent-kill", {
		description: "Kill a running subagent by agent ID",
		handler: async (args, ctx) => {
			const agentId = args.trim();
			if (!agentId) {
				ctx.ui.notify("Usage: /subagent-kill <agent-id>", "warning");
				return;
			}
			const { agent, paths } = requireState();
			const result = killAgentProcess(paths, agentId);
			if (!result.ok) {
				ctx.ui.notify(result.reason ?? `Could not kill ${agentId}`, "error");
				return;
			}
			emitZoneEvent(paths, makeEvent(agent, "status", { text: `killed ${agentId}` }));
			updateStatus(ctx, paths, agent);
			ctx.ui.notify(`Killed ${agentId}`, "success");
		},
	});

	pi.registerCommand("subagent-join", {
		description: "Wait for a subagent subtree to finish and hydrate its routed messages",
		handler: async (args, ctx) => {
			const [agentId, timeoutRaw] = args.trim().split(/\s+/, 2);
			if (!agentId) {
				ctx.ui.notify("Usage: /subagent-join <agent-id> [timeout-seconds]", "warning");
				return;
			}
			const timeoutSeconds = timeoutRaw ? Number(timeoutRaw) : undefined;
			const { agent, paths } = requireState();
			try {
				await joinAgentSubtree(paths, agent, agentId, Number.isFinite(timeoutSeconds) ? timeoutSeconds : undefined, ctx.signal);
				updateStatus(ctx, paths, agent);
				ctx.ui.notify(`Joined ${agentId}.`, "success");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerTool({
		name: "spawn_subagent",
		label: "Spawn Subagent",
		description:
			"Spawn a background subagent that inherits the current effective context snapshot and works on a delegated task.",
		promptSnippet: "Spawn a background subagent for substantial delegated work.",
		promptGuidelines: [
			"Use this tool for long-running implementation, investigation, or delegated coding work.",
			"When the user updates an in-flight task, kill the old subagent and spawn a fresh one instead of trying to message the old one.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "The delegated task for the new subagent" }),
			name: Type.Optional(Type.String({ description: "Optional human-friendly subagent name" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return spawnAgentFromTask(params.task, params.name, ctx);
		},
	});

	pi.registerTool({
		name: "kill_subagent",
		label: "Kill Subagent",
		description: "Kill a running subagent by agent ID.",
		promptSnippet: "Kill a running subagent when replacing or stopping delegated work.",
		parameters: Type.Object({
			agentId: Type.String({ description: "The agent ID of the subagent to stop" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, paths } = requireState();
			const result = killAgentProcess(paths, params.agentId);
			if (result.ok) {
				emitZoneEvent(paths, makeEvent(agent, "status", { text: `killed ${params.agentId}` }));
				updateStatus(ctx, paths, agent);
				return {
					content: [{ type: "text", text: `Killed ${params.agentId}.` }],
					details: { ok: true },
				};
			}
			return {
				content: [{ type: "text", text: result.reason ?? `Could not kill ${params.agentId}.` }],
				details: { ok: false },
				isError: true,
			};
		},
	});

	pi.registerTool({
		name: "join_subagent",
		label: "Join Subagent",
		description: "Wait for a subagent subtree to finish, hydrate its new routed messages, and refresh the caller's span view.",
		promptSnippet: "Wait for a subagent subtree to finish and synchronize its final routed context.",
		promptGuidelines: [
			"Use this tool when you need a synchronization barrier before reasoning from a subagent's final state.",
			"Joining hydrates newly available routed subtree messages into your local context before returning.",
		],
		parameters: Type.Object({
			agentId: Type.String({ description: "The target subagent ID to join" }),
			timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout in seconds. If omitted, wait indefinitely." })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const { agent, paths } = requireState();
			try {
				await joinAgentSubtree(paths, agent, params.agentId, params.timeoutSeconds, signal);
				updateStatus(ctx, paths, agent);
				return {
					content: [{ type: "text", text: `Joined ${params.agentId}.` }],
					details: { ok: true, joinedAgentId: params.agentId, subtreeAgentIds: getDescendantAgentIds(paths, params.agentId) },
				};
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { ok: false },
					isError: true,
				};
			}
		},
	});

}
