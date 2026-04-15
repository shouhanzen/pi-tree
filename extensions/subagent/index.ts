import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import {
	EXTENSION_NAME,
	type AgentMeta,
	type ZoneEvent,
	archiveAgentSubtree,
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
	resumeAgentProcess,
	randomId,
	refreshAgentLiveness,
	spawnChildProcess,
	syncVisibleEvents,
	type RuntimePaths,
	unarchiveAgentSubtree,
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

function buildResumeSnapshot(
	ctx: ExtensionContext,
	paths: RuntimePaths,
	caller: AgentMeta,
	target: AgentMeta,
	message: string,
): string {
	const callerProjection = buildProjectionMessage(paths, caller);
	const targetProjection = buildProjectionMessage(paths, target);
	return [
		"# Resume snapshot",
		"",
		`Caller agent: ${caller.agentId} (${caller.name})`,
		`Target agent: ${target.agentId} (${target.name})`,
		`Target zone: ${target.zoneId}`,
		`Resume created: ${nowIso()}`,
		"",
		"# Target conversation view",
		"",
		targetProjection || "(no routed projection yet)",
		"",
		"# Caller view",
		"",
		callerProjection || "(no caller projection)",
		"",
		"# New user message",
		"",
		message,
	].join("\n");
}

async function resumeAgentWithMessage(
	ctx: ExtensionContext,
	paths: RuntimePaths,
	caller: AgentMeta,
	targetAgentId: string,
	message: string,
	thinkingLevel?: string,
): Promise<AgentToolResult<Record<string, unknown>>> {
	const target = getAgentMeta(paths, targetAgentId);
	if (!target) throw new Error(`Unknown agent: ${targetAgentId}`);
	if (target.archived) throw new Error(`Archived agent cannot receive messages: ${targetAgentId}`);
	const snapshotMarkdown = buildResumeSnapshot(ctx, paths, caller, target, message);
	const resumed = resumeAgentProcess(paths, targetAgentId, {
		name: target.name,
		task: message,
		snapshotMarkdown,
		extensionPath: EXTENSION_FILE_PATH,
		model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		thinkingLevel,
		appendSystemPrompt: [
			`You are resuming persistent subagent ${target.name} (${target.agentId}).`,
			`Keep the same identity, zone, and transcript.`,
			`Treat the new user message as the next normal turn in this same conversation.`,
		].join("\n"),
	});
	emitZoneEvent(paths, makeEvent(caller, "status", { text: `zone push to ${targetAgentId}` }));
	return {
		content: [{ type: "text", text: `Messaged ${resumed.agentId}.` }],
		details: { ok: true, agentId: resumed.agentId, resumed: true },
	};
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

	pi.registerCommand("subagent-message", {
		description: "Send a new user message to a persistent subagent conversation",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const firstSpace = trimmed.indexOf(" ");
			if (!trimmed || firstSpace === -1) {
				ctx.ui.notify("Usage: /subagent-message <agent-id> <message>", "warning");
				return;
			}
			const agentId = trimmed.slice(0, firstSpace).trim();
			const message = trimmed.slice(firstSpace + 1).trim();
			const { agent, paths } = requireState();
			try {
				const result = await resumeAgentWithMessage(ctx, paths, agent, agentId, message, pi.getThinkingLevel());
				updateStatus(ctx, paths, agent);
				ctx.ui.notify(extractTextFromContent(result.content), "success");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});

	pi.registerCommand("subagent-archive", {
		description: "Archive a completed subagent subtree (soft hide)",
		handler: async (args, ctx) => {
			const agentId = args.trim();
			if (!agentId) {
				ctx.ui.notify("Usage: /subagent-archive <agent-id>", "warning");
				return;
			}
			const { agent, paths } = requireState();
			const target = getAgentMeta(paths, agentId);
			if (!target) {
				ctx.ui.notify(`Unknown agent: ${agentId}`, "error");
				return;
			}
			archiveAgentSubtree(paths, agentId);
			emitZoneEvent(paths, makeEvent(agent, "status", { text: `archived ${agentId}` }));
			ctx.ui.notify(`Archived ${agentId}.`, "success");
		},
	});

	pi.registerCommand("subagent-unarchive", {
		description: "Restore an archived subagent subtree",
		handler: async (args, ctx) => {
			const agentId = args.trim();
			if (!agentId) {
				ctx.ui.notify("Usage: /subagent-unarchive <agent-id>", "warning");
				return;
			}
			const { agent, paths } = requireState();
			const target = getAgentMeta(paths, agentId);
			if (!target) {
				ctx.ui.notify(`Unknown agent: ${agentId}`, "error");
				return;
			}
			unarchiveAgentSubtree(paths, agentId);
			emitZoneEvent(paths, makeEvent(agent, "status", { text: `unarchived ${agentId}` }));
			ctx.ui.notify(`Unarchived ${agentId}.`, "success");
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

	pi.registerTool({
		name: "message_subagent",
		label: "Message Subagent",
		description: "Send a new user message to a persistent subagent conversation and resume it in place.",
		promptSnippet: "Send a normal new user turn to an existing persistent subagent conversation.",
		promptGuidelines: [
			"Use this tool when continuing an existing persistent agent rather than spawning a brand-new child.",
			"Do not use this on archived agents.",
		],
		parameters: Type.Object({
			agentId: Type.String({ description: "The target persistent subagent ID" }),
			message: Type.String({ description: "The next user message for that persistent subagent" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const { agent, paths } = requireState();
			try {
				return await resumeAgentWithMessage(ctx, paths, agent, params.agentId, params.message, pi.getThinkingLevel());
			} catch (error) {
				return {
					content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
					details: { ok: false },
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "archive_subagent",
		label: "Archive Subagent",
		description: "Archive a completed subagent subtree so it is hidden by default.",
		promptSnippet: "Archive a completed subagent subtree when you want to prune tree clutter without deleting it.",
		parameters: Type.Object({
			agentId: Type.String({ description: "The root agent ID of the subtree to archive" }),
		}),
		async execute(_toolCallId, params) {
			const { paths } = requireState();
			const target = getAgentMeta(paths, params.agentId);
			if (!target) {
				return { content: [{ type: "text", text: `Unknown agent: ${params.agentId}` }], details: { ok: false }, isError: true };
			}
			archiveAgentSubtree(paths, params.agentId);
			return { content: [{ type: "text", text: `Archived ${params.agentId}.` }], details: { ok: true } };
		},
	});

	pi.registerTool({
		name: "unarchive_subagent",
		label: "Unarchive Subagent",
		description: "Restore an archived subagent subtree so it is visible and messageable again.",
		promptSnippet: "Restore an archived subagent subtree.",
		parameters: Type.Object({
			agentId: Type.String({ description: "The root agent ID of the subtree to unarchive" }),
		}),
		async execute(_toolCallId, params) {
			const { paths } = requireState();
			const target = getAgentMeta(paths, params.agentId);
			if (!target) {
				return { content: [{ type: "text", text: `Unknown agent: ${params.agentId}` }], details: { ok: false }, isError: true };
			}
			unarchiveAgentSubtree(paths, params.agentId);
			return { content: [{ type: "text", text: `Unarchived ${params.agentId}.` }], details: { ok: true } };
		},
	});

}
