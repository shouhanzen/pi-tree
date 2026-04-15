import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { complete } from "@mariozechner/pi-ai";
import { convertToLlm, serializeConversation, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Focusable, type Theme } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
	EXTENSION_NAME,
	type AgentMeta,
	type ZoneEvent,
	archiveAgentSubtree,
	type AgentTreeNode,
	buildAgentTree,
	buildVisibleZoneIds,
	emitZoneEvent,
	extractTextFromContent,
	getAgentMeta,
	getDescendantAgentIds,
	getZoneEventPath,
	isAgentSubtreeAlive,
	killAgentProcess,
	loadOrCreateCurrentAgent,
	markAgentAlive,
	readJsonl,
	renderProjectionMarkdown,
	renderSessionBranchSnapshot,
	flattenAgentTree,
	resumeAgentProcess,
	randomId,
	refreshAgentLiveness,
	spawnChildProcess,
	summarizeEventForProjection,
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

function buildDelegationPrompt(agent: AgentMeta): string {
	const rootBehavior = agent.isRoot
		? [
			"You are orca, the trunk coordinator. Delegate aggressively.",
			"If the task is non-trivial, parallelizable, or spans multiple files/modules, prefer spawning subagents instead of doing all work yourself.",
		]
		: [
			"You are a persistent subagent in a recursive agent tree.",
			"You may also delegate when the task meaningfully splits into parallel or isolated subproblems.",
		];
	return [
		"[SUBAGENT OPERATING MODE]",
		...rootBehavior,
		"When there is a lot of code to write, first decide the module/file split yourself.",
		"Explicitly describe the contract for each module or work packet before delegating.",
		"Contracts should name responsibilities, expected inputs/outputs, and any key interfaces or invariants.",
		"Then spawn subagents for the implementation work rather than serially writing every module yourself when the work is decomposable.",
		"When there is a lot of code to read, first decide the reading split yourself.",
		"Explicitly describe which files or subsystems each subagent should inspect, and what questions each one should answer.",
		"After subagents finish, synthesize their results into a single coherent conclusion or plan.",
		"Prefer crisp task packets with clear boundaries over vague delegation.",
		"Do not delegate tiny tasks that are faster to do directly.",
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

function formatAgentState(agent: AgentMeta): string {
	if (agent.archived) return "archived";
	if (agent.alive) return "alive";
	return agent.lastStatus ?? "dead";
}

function getStateColor(state: string): "success" | "warning" | "dim" {
	if (state === "alive") return "success";
	if (state === "archived") return "warning";
	return "dim";
}

function makePaneLine(theme: Theme, width: number, text = "", borderLeft = "│", borderRight = "│"): string {
	return `${theme.fg("border", borderLeft)}${truncateToWidth(text, Math.max(0, width - 2), "…", true)}${theme.fg("border", borderRight)}`;
}

function wrapPaneText(text: string, width: number): string[] {
	const innerWidth = Math.max(1, width - 2);
	return text
		.split("\n")
		.flatMap((line) => (line.length === 0 ? [""] : wrapTextWithAnsi(line, innerWidth)));
}

function buildAgentDetailLines(paths: RuntimePaths, target: AgentMeta): string[] {
	const zoneEvents = readJsonl<ZoneEvent>(getZoneEventPath(paths, target.zoneId));
	const recentEvents = zoneEvents.slice(-24);
	const header = [
		`Name: ${target.name}`,
		`Agent: ${target.agentId}`,
		`Zone: ${target.zoneId}`,
		`State: ${formatAgentState(target)}`,
		"",
		"Recent chat:",
	];
	if (recentEvents.length === 0) {
		header.push("(no events yet)");
		return header;
	}
	for (const event of recentEvents) {
		header.push(`- ${event.emittingAgentId}: ${summarizeEventForProjection(event)}`);
	}
	return header;
}

export function renderSubagentUiPreview(paths: RuntimePaths, selectedAgentId?: string, showArchived = false, width = 120): string[] {
	const plainTheme: Theme = {
		fg: (_token: any, text: string) => text,
		bg: (_token: any, text: string) => text,
		bold: (text: string) => text,
		dim: (text: string) => text,
		italic: (text: string) => text,
		underline: (text: string) => text,
		strikethrough: (text: string) => text,
	} as Theme;
	const nodes = flattenAgentTree(buildAgentTree(paths, showArchived));
	const selected = nodes.find((node) => node.agent.agentId === selectedAgentId) ?? nodes[0];
	const overlay = new AgentTreeOverlay(
		plainTheme,
		(includeArchived) => buildAgentTree(paths, includeArchived),
		(agentId) => {
			const target = getAgentMeta(paths, agentId);
			if (!target) return `Unknown agent: ${agentId}`;
			const chatLines = buildAgentDetailLines(paths, target);
			const projection = renderProjectionMarkdown(paths, target);
			return projection.trim() ? [...chatLines, "", "Routed context:", projection].join("\n") : chatLines.join("\n");
		},
		() => "",
		() => "",
		() => {},
	);
		(overlay as any).showArchived = showArchived;
		(overlay as any).selectedIndex = Math.max(0, nodes.findIndex((node) => node.agent.agentId === selected?.agent.agentId));
	return overlay.render(width);
}

class AgentTreeOverlay implements Focusable {
	focused = false;
	private selectedIndex = 0;
	private showArchived = false;
	private readonly theme: Theme;
	private readonly getNodes: (showArchived: boolean) => AgentTreeNode[];
	private readonly getDetail: (agentId: string) => string;
	private readonly onArchive: (agentId: string) => string;
	private readonly onUnarchive: (agentId: string) => string;
	private readonly done: () => void;

	constructor(
		theme: Theme,
		getNodes: (showArchived: boolean) => AgentTreeNode[],
		getDetail: (agentId: string) => string,
		onArchive: (agentId: string) => string,
		onUnarchive: (agentId: string) => string,
		done: () => void,
	) {
		this.theme = theme;
		this.getNodes = getNodes;
		this.getDetail = getDetail;
		this.onArchive = onArchive;
		this.onUnarchive = onUnarchive;
		this.done = done;
	}

	private getFlatNodes(): AgentTreeNode[] {
		return flattenAgentTree(this.getNodes(this.showArchived));
	}

	handleInput(data: string): void {
		const nodes = this.getFlatNodes();
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.done();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.selectedIndex = Math.min(nodes.length - 1, this.selectedIndex + 1);
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			return;
		}
		if (matchesKey(data, "a")) {
			const node = nodes[this.selectedIndex];
			if (node && !node.agent.archived && !node.agent.alive && !node.agent.isRoot) {
				this.onArchive(node.agent.agentId);
			}
			return;
		}
		if (matchesKey(data, "u")) {
			const node = nodes[this.selectedIndex];
			if (node && node.agent.archived) {
				this.onUnarchive(node.agent.agentId);
			}
			return;
		}
		if (matchesKey(data, "f")) {
			this.showArchived = !this.showArchived;
			this.selectedIndex = 0;
			return;
		}
	}

	render(width: number): string[] {
		const nodes = this.getFlatNodes();
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, nodes.length - 1)));
		const selected = nodes[this.selectedIndex] ?? nodes[0];
		const leftWidth = Math.max(30, Math.floor(width * 0.33));
		const rightWidth = Math.max(46, width - leftWidth - 1);
		const leftLines = this.renderTree(leftWidth, nodes);
		const rightLines = this.renderDetail(rightWidth, selected?.agent.agentId);
		const maxLines = Math.max(leftLines.length, rightLines.length);
		const lines: string[] = [];
		for (let i = 0; i < maxLines; i++) {
			const left = leftLines[i] ?? makePaneLine(this.theme, leftWidth);
			const right = rightLines[i] ?? makePaneLine(this.theme, rightWidth);
			lines.push(`${left}${right}`);
		}
		return lines;
	}

	private renderTree(width: number, nodes: AgentTreeNode[]): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`));
		lines.push(makePaneLine(this.theme, width, this.theme.fg("accent", ` Subagents ${this.showArchived ? "• archived shown" : ""}`)));
		lines.push(makePaneLine(this.theme, width, this.theme.fg("dim", `${nodes.length} visible node(s)`)));
		lines.push(makePaneLine(this.theme, width));
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i]!;
			const state = formatAgentState(node.agent);
			const indent = "  ".repeat(node.depth);
			const marker = i === this.selectedIndex ? this.theme.fg("accent", "▶") : this.theme.fg("dim", "•");
			const idShort = node.agent.agentId.slice(0, 8);
			const row = `${marker} ${indent}${node.agent.name} · ${idShort} ${this.theme.fg(getStateColor(state), `[${state}]`)}`;
			lines.push(makePaneLine(this.theme, width, row));
		}
		if (nodes.length === 0) {
			lines.push(makePaneLine(this.theme, width, this.theme.fg("dim", "No agents yet.")));
		}
		lines.push(makePaneLine(this.theme, width));
		lines.push(makePaneLine(this.theme, width, this.theme.fg("dim", "↑↓/j/k select  a archive  u restore  f toggle archived  esc close")));
		lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	private renderDetail(width: number, agentId?: string): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("border", `╭${"─".repeat(width - 2)}╮`));
		lines.push(makePaneLine(this.theme, width, this.theme.fg("accent", " Selected agent chat")));
		lines.push(makePaneLine(this.theme, width));
		if (!agentId) {
			lines.push(makePaneLine(this.theme, width, this.theme.fg("dim", "No agent selected.")));
			lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
			return lines;
		}
		for (const line of wrapPaneText(this.getDetail(agentId), width)) {
			lines.push(makePaneLine(this.theme, width, line));
		}
		lines.push(this.theme.fg("border", `╰${"─".repeat(width - 2)}╯`));
		return lines;
	}

	invalidate(): void {}
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
			buildDelegationPrompt(target),
		].join("\n\n"),
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
			appendSystemPrompt: buildDelegationPrompt({
				...agent,
				isRoot: false,
				name: name ?? "subagent",
			}),
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
		const operatingPrompt = buildDelegationPrompt(currentAgent);
		return {
			systemPrompt: [event.systemPrompt, operatingPrompt, projection].filter((part) => !!part && part.trim().length > 0).join("\n\n"),
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

	pi.registerCommand("subagent-ui", {
		description: "Open an experimental two-pane agent tree + selected chat browser",
		handler: async (_args, ctx) => {
			const { agent, paths } = requireState();
			const getNodes = (showArchived: boolean) => {
				refreshForkzoneRuntime(paths, agent);
				return buildAgentTree(paths, showArchived);
			};
			const getDetail = (agentId: string) => {
				const target = getAgentMeta(paths, agentId);
				if (!target) return `Unknown agent: ${agentId}`;
				refreshForkzoneRuntime(paths, target);
				const chatLines = buildAgentDetailLines(paths, target);
				const projection = renderProjectionMarkdown(paths, target);
				if (!projection.trim()) return chatLines.join("\n");
				return [...chatLines, "", "Routed context:", projection].join("\n");
			};
			await ctx.ui.custom((_tui, theme, _kb, done) => {
				return new AgentTreeOverlay(
					theme,
					getNodes,
					getDetail,
					(agentId) => {
						archiveAgentSubtree(paths, agentId);
						return `Archived ${agentId}.`;
					},
					(agentId) => {
						unarchiveAgentSubtree(paths, agentId);
						return `Unarchived ${agentId}.`;
					},
					() => done(undefined),
				);
			}, { overlay: true, overlayOptions: { anchor: "center", width: "90%", maxHeight: "85%" } });
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
			"For broad work, first decide the split yourself, define clear contracts for each module or investigation packet, then spawn subagents against those contracts.",
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

}
