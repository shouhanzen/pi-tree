import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const FORKZONE_DIRNAME = "forkzones";
export const EXTENSION_NAME = "subagent";

export type EventKind =
	| "user_message"
	| "assistant_message"
	| "tool_call"
	| "tool_result"
	| "compaction"
	| "spawn"
	| "terminal"
	| "status";

export interface RuntimePaths {
	rootDir: string;
	agentsDir: string;
	zonesDir: string;
	eventsDir: string;
	snapshotsDir: string;
}

export interface AgentMeta {
	agentId: string;
	name: string;
	zoneId: string;
	parentAgentId?: string;
	parentZoneId?: string;
	seedVisibleZoneIds: string[];
	cwd: string;
	createdAt: string;
	pid?: number;
	alive: boolean;
	lastStatus?: string;
	lastStatusAt?: string;
	isRoot: boolean;
}

export interface ZoneMeta {
	zoneId: string;
	ownerAgentId: string;
	parentZoneId?: string;
	createdAt: string;
}

export interface ZoneEvent {
	eventId: string;
	timestamp: string;
	zoneId: string;
	emittingAgentId: string;
	kind: EventKind;
	payload: Record<string, unknown>;
}

export interface HeardState {
	lastSeenByZone: Record<string, string>;
}

export interface HeardRecord {
	receivedAt: string;
	event: ZoneEvent;
}

export interface ZoneSpan {
	zoneId: string;
	ownerAgent: AgentMeta | null;
	zone: ZoneMeta | null;
	depth: number;
	isAlive: boolean;
	records: HeardRecord[];
	children: ZoneSpan[];
}

export interface SpawnOptions {
	name?: string;
	task: string;
	model?: string;
	thinkingLevel?: string;
	appendSystemPrompt?: string;
	snapshotMarkdown: string;
	extensionPath?: string;
}

function mkdirp(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

function exists(filePath: string): boolean {
	return fs.existsSync(filePath);
}

function readJson<T>(filePath: string, fallback: T): T {
	try {
		if (!exists(filePath)) return fallback;
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
	} catch {
		return fallback;
	}
}

function writeJson(filePath: string, value: unknown): void {
	mkdirp(path.dirname(filePath));
	fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function appendJsonl(filePath: string, value: unknown): void {
	mkdirp(path.dirname(filePath));
	fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

export function readJsonl<T>(filePath: string): T[] {
	if (!exists(filePath)) return [];
	const text = fs.readFileSync(filePath, "utf8").trim();
	if (!text) return [];
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as T);
}

export function randomId(prefix: string): string {
	return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function getRuntimePaths(cwd: string): RuntimePaths {
	const rootDir = path.resolve(cwd, ".pi", FORKZONE_DIRNAME);
	return {
		rootDir,
		agentsDir: path.join(rootDir, "agents"),
		zonesDir: path.join(rootDir, "zones"),
		eventsDir: path.join(rootDir, "events"),
		snapshotsDir: path.join(rootDir, "snapshots"),
	};
}

export function ensureRuntime(cwd: string): RuntimePaths {
	const paths = getRuntimePaths(cwd);
	mkdirp(paths.rootDir);
	mkdirp(paths.agentsDir);
	mkdirp(paths.zonesDir);
	mkdirp(paths.eventsDir);
	mkdirp(paths.snapshotsDir);
	return paths;
}

export function getAgentMetaPath(paths: RuntimePaths, agentId: string): string {
	return path.join(paths.agentsDir, agentId, "meta.json");
}

export function getAgentHeardPath(paths: RuntimePaths, agentId: string): string {
	return path.join(paths.agentsDir, agentId, "heard.jsonl");
}

export function getAgentHeardStatePath(paths: RuntimePaths, agentId: string): string {
	return path.join(paths.agentsDir, agentId, "heard-state.json");
}

export function getZoneMetaPath(paths: RuntimePaths, zoneId: string): string {
	return path.join(paths.zonesDir, `${zoneId}.json`);
}

export function getZoneEventPath(paths: RuntimePaths, zoneId: string): string {
	return path.join(paths.eventsDir, `${zoneId}.jsonl`);
}

export function listAgentMetas(paths: RuntimePaths): AgentMeta[] {
	if (!exists(paths.agentsDir)) return [];
	const agentIds = fs.readdirSync(paths.agentsDir, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	return agentIds
		.map((agentId) => readJson<AgentMeta | null>(getAgentMetaPath(paths, agentId), null))
		.filter((meta): meta is AgentMeta => !!meta);
}

export function listZoneMetas(paths: RuntimePaths): ZoneMeta[] {
	if (!exists(paths.zonesDir)) return [];
	return fs
		.readdirSync(paths.zonesDir)
		.filter((name) => name.endsWith(".json"))
		.map((name) => readJson<ZoneMeta | null>(path.join(paths.zonesDir, name), null))
		.filter((meta): meta is ZoneMeta => !!meta);
}

export function getZoneMeta(paths: RuntimePaths, zoneId: string): ZoneMeta | null {
	return readJson<ZoneMeta | null>(getZoneMetaPath(paths, zoneId), null);
}

export function getAgentMeta(paths: RuntimePaths, agentId: string): AgentMeta | null {
	return readJson<AgentMeta | null>(getAgentMetaPath(paths, agentId), null);
}

export function saveAgentMeta(paths: RuntimePaths, meta: AgentMeta): void {
	writeJson(getAgentMetaPath(paths, meta.agentId), meta);
}

export function saveZoneMeta(paths: RuntimePaths, meta: ZoneMeta): void {
	writeJson(getZoneMetaPath(paths, meta.zoneId), meta);
}

export function loadOrCreateCurrentAgent(cwd: string): { paths: RuntimePaths; agent: AgentMeta } {
	const paths = ensureRuntime(cwd);
	const envAgentId = process.env.PI_SUBAGENT_AGENT_ID;
	if (envAgentId) {
		const existing = getAgentMeta(paths, envAgentId);
		if (existing) return { paths, agent: existing };
		const fallback: AgentMeta = {
			agentId: envAgentId,
			name: process.env.PI_SUBAGENT_AGENT_NAME || envAgentId,
			zoneId: process.env.PI_SUBAGENT_ZONE_ID || randomId("zone"),
			parentAgentId: process.env.PI_SUBAGENT_PARENT_AGENT_ID || undefined,
			parentZoneId: process.env.PI_SUBAGENT_PARENT_ZONE_ID || undefined,
			seedVisibleZoneIds: parseJsonStringArray(process.env.PI_SUBAGENT_SEED_VISIBLE_ZONES) ?? [],
			cwd,
			createdAt: new Date().toISOString(),
			pid: process.pid,
			alive: true,
			lastStatus: "alive",
			lastStatusAt: new Date().toISOString(),
			isRoot: false,
		};
		saveAgentMeta(paths, fallback);
		saveZoneMeta(paths, {
			zoneId: fallback.zoneId,
			ownerAgentId: fallback.agentId,
			parentZoneId: fallback.parentZoneId,
			createdAt: fallback.createdAt,
		});
		return { paths, agent: fallback };
	}

	const rootMetaPath = path.join(paths.rootDir, "root-agent.json");
	const existingRoot = readJson<AgentMeta | null>(rootMetaPath, null);
	if (existingRoot) {
		const refreshed = { ...existingRoot, pid: process.pid, alive: true, cwd };
		saveAgentMeta(paths, refreshed);
		writeJson(rootMetaPath, refreshed);
		return { paths, agent: refreshed };
	}

	const rootAgent: AgentMeta = {
		agentId: "root-orca",
		name: "orca",
		zoneId: "zone-root-orca",
		seedVisibleZoneIds: ["zone-root-orca"],
		cwd,
		createdAt: new Date().toISOString(),
		pid: process.pid,
		alive: true,
		lastStatus: "alive",
		lastStatusAt: new Date().toISOString(),
		isRoot: true,
	};
	saveAgentMeta(paths, rootAgent);
	saveZoneMeta(paths, {
		zoneId: rootAgent.zoneId,
		ownerAgentId: rootAgent.agentId,
		createdAt: rootAgent.createdAt,
	});
	writeJson(rootMetaPath, rootAgent);
	return { paths, agent: rootAgent };
}

function parseJsonStringArray(value: string | undefined): string[] | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((item): item is string => typeof item === "string");
	} catch {
		return null;
	}
}

export function emitZoneEvent(paths: RuntimePaths, event: ZoneEvent): void {
	appendJsonl(getZoneEventPath(paths, event.zoneId), event);
}

export function buildVisibleZoneIds(paths: RuntimePaths, agent: AgentMeta): string[] {
	const zones = listZoneMetas(paths);
	const childrenByParent = new Map<string, string[]>();
	for (const zone of zones) {
		if (!zone.parentZoneId) continue;
		const current = childrenByParent.get(zone.parentZoneId) ?? [];
		current.push(zone.zoneId);
		childrenByParent.set(zone.parentZoneId, current);
	}
	const seen = new Set<string>();
	const ordered: string[] = [];
	const queue = [...agent.seedVisibleZoneIds];
	while (queue.length > 0) {
		const zoneId = queue.shift();
		if (!zoneId || seen.has(zoneId)) continue;
		seen.add(zoneId);
		ordered.push(zoneId);
		for (const childZoneId of childrenByParent.get(zoneId) ?? []) queue.push(childZoneId);
	}
	if (!seen.has(agent.zoneId)) ordered.push(agent.zoneId);
	return ordered;
}

export function syncVisibleEvents(paths: RuntimePaths, agent: AgentMeta): HeardRecord[] {
	const heardStatePath = getAgentHeardStatePath(paths, agent.agentId);
	const heardPath = getAgentHeardPath(paths, agent.agentId);
	const heardState = readJson<HeardState>(heardStatePath, { lastSeenByZone: {} });
	const visibleZoneIds = buildVisibleZoneIds(paths, agent).filter((zoneId) => zoneId !== agent.zoneId);
	const newRecords: HeardRecord[] = [];

	for (const zoneId of visibleZoneIds) {
		const events = readJsonl<ZoneEvent>(getZoneEventPath(paths, zoneId));
		const lastSeen = heardState.lastSeenByZone[zoneId];
		let startIndex = 0;
		if (lastSeen) {
			const idx = events.findIndex((event) => event.eventId === lastSeen);
			startIndex = idx >= 0 ? idx + 1 : 0;
		}
		for (const event of events.slice(startIndex)) {
			const record: HeardRecord = {
				receivedAt: new Date().toISOString(),
				event,
			};
			appendJsonl(heardPath, record);
			newRecords.push(record);
			heardState.lastSeenByZone[zoneId] = event.eventId;
			const emittingMeta = getAgentMeta(paths, event.emittingAgentId);
			if (emittingMeta) {
				if (event.kind === "terminal") {
					emittingMeta.alive = false;
					emittingMeta.lastStatus = String(event.payload.status ?? "stopped");
					emittingMeta.lastStatusAt = event.timestamp;
					saveAgentMeta(paths, emittingMeta);
				}
				if (event.kind === "status") {
					emittingMeta.alive = true;
					emittingMeta.lastStatus = String(event.payload.text ?? emittingMeta.lastStatus ?? "alive");
					emittingMeta.lastStatusAt = event.timestamp;
					saveAgentMeta(paths, emittingMeta);
				}
			}
		}
	}

	writeJson(heardStatePath, heardState);
	return newRecords;
}

export function loadHeardRecords(paths: RuntimePaths, agentId: string): HeardRecord[] {
	return readJsonl<HeardRecord>(getAgentHeardPath(paths, agentId));
}

export function markAgentAlive(paths: RuntimePaths, agentId: string, alive: boolean, status?: string): void {
	const meta = getAgentMeta(paths, agentId);
	if (!meta) return;
	meta.alive = alive;
	meta.pid = alive ? process.pid : meta.pid;
	meta.lastStatus = status ?? (alive ? "alive" : meta.lastStatus ?? "stopped");
	meta.lastStatusAt = new Date().toISOString();
	saveAgentMeta(paths, meta);
}

export function summarizeEventForProjection(event: ZoneEvent): string {
	switch (event.kind) {
		case "user_message":
			return `user: ${String(event.payload.text ?? "")}`;
		case "assistant_message":
			return `assistant: ${String(event.payload.text ?? "")}`;
		case "tool_call":
			return `tool call ${String(event.payload.toolName ?? "tool")}: ${String(event.payload.args ?? "")}`;
		case "tool_result":
			return `tool result ${String(event.payload.toolName ?? "tool")}: ${String(event.payload.output ?? "")}`;
		case "compaction":
			return `compaction: ${String(event.payload.summary ?? "")}`;
		case "spawn":
			return `spawned ${String(event.payload.childAgentId ?? "child")}: ${String(event.payload.task ?? "")}`;
		case "terminal":
			return `terminal: ${String(event.payload.status ?? "stopped")}`;
		case "status":
			return `status: ${String(event.payload.text ?? "")}`;
		default:
			return JSON.stringify(event.payload);
	}
}

export function buildZoneSpans(paths: RuntimePaths, agent: AgentMeta): ZoneSpan[] {
	const records = loadHeardRecords(paths, agent.agentId);
	if (records.length === 0) return [];
	const zones = listZoneMetas(paths);
	const zoneMap = new Map(zones.map((zone) => [zone.zoneId, zone]));
	const agentMap = new Map(listAgentMetas(paths).map((meta) => [meta.agentId, meta]));
	const byZone = new Map<string, HeardRecord[]>();
	for (const record of records) {
		const current = byZone.get(record.event.zoneId) ?? [];
		current.push(record);
		byZone.set(record.event.zoneId, current);
	}
	const visibleZoneIds = buildVisibleZoneIds(paths, agent).filter((zoneId) => zoneId !== agent.zoneId);
	const visibleSet = new Set(visibleZoneIds);
	const childZoneIdsByParent = new Map<string, string[]>();
	for (const zoneId of visibleZoneIds) {
		const zone = zoneMap.get(zoneId);
		if (!zone?.parentZoneId || !visibleSet.has(zone.parentZoneId)) continue;
		const current = childZoneIdsByParent.get(zone.parentZoneId) ?? [];
		current.push(zoneId);
		childZoneIdsByParent.set(zone.parentZoneId, current);
	}

	const buildSpan = (zoneId: string): ZoneSpan => {
		const zone = zoneMap.get(zoneId) ?? null;
		const ownerAgent = zone ? (agentMap.get(zone.ownerAgentId) ?? null) : null;
		const children = (childZoneIdsByParent.get(zoneId) ?? []).map((childZoneId) => buildSpan(childZoneId));
		return {
			zoneId,
			ownerAgent,
			zone,
			depth: computeZoneDepth(zoneId, zoneMap),
			isAlive: ownerAgent?.alive ?? false,
			records: byZone.get(zoneId) ?? [],
			children,
		};
	};

	return visibleZoneIds
		.filter((zoneId) => {
			const zone = zoneMap.get(zoneId);
			return !zone?.parentZoneId || !visibleSet.has(zone.parentZoneId);
		})
		.map((zoneId) => buildSpan(zoneId))
		.filter((span) => span.records.length > 0 || span.children.length > 0);
}

export function renderProjectionMarkdown(paths: RuntimePaths, agent: AgentMeta): string {
	const spans = buildZoneSpans(paths, agent);
	if (spans.length === 0) return "";
	const lines: string[] = [
		"# Forkzone spans",
		"",
		"Visible routed spans heard by this agent. Each span has a header, a historical body, and a live append tail while its owner is alive.",
		"",
	];
	for (const span of spans) renderZoneSpan(lines, span);
	return lines.join("\n").trim();
}

function renderZoneSpan(lines: string[], span: ZoneSpan): void {
	const depth = Math.min(6, 2 + span.depth);
	const hashes = "#".repeat(depth);
	const ownerLabel = span.ownerAgent ? `${span.ownerAgent.name} (${span.ownerAgent.agentId})` : "unknown-agent";
	const state = span.isAlive ? "alive" : "dead";
	lines.push(`${hashes} Zone span ${span.zoneId}`);
	lines.push(`Header: agent=${ownerLabel} state=${state}`);
	if (span.zone?.parentZoneId) lines.push(`Parent zone: ${span.zone.parentZoneId}`);
	lines.push("");
	if (span.records.length > 0) {
		lines.push(span.isAlive ? "Append tail:" : "Historical transcript after zone dissipation:");
		for (const record of span.records) {
			lines.push(`- ${record.event.emittingAgentId}: ${summarizeEventForProjection(record.event)}`);
		}
		lines.push("");
	}
	if (span.children.length > 0) {
		if (span.isAlive) {
			lines.push("Nested live spans:");
			lines.push("");
			for (const child of span.children) renderZoneSpan(lines, child);
		} else {
			lines.push("Nested spans dissolved into historical transcript:");
			lines.push("");
			for (const child of span.children) renderDissolvedZoneSpan(lines, child);
		}
	}
}

function renderDissolvedZoneSpan(lines: string[], span: ZoneSpan): void {
	const ownerLabel = span.ownerAgent ? `${span.ownerAgent.name} (${span.ownerAgent.agentId})` : "unknown-agent";
	lines.push(`- dead zone header ${span.zoneId} agent=${ownerLabel} state=${span.isAlive ? "alive" : "dead"}`);
	for (const record of span.records) {
		lines.push(`  - ${record.event.emittingAgentId}: ${summarizeEventForProjection(record.event)}`);
	}
	for (const child of span.children) renderDissolvedZoneSpan(lines, child);
}

function computeZoneDepth(zoneId: string, zoneMap: Map<string, ZoneMeta>): number {
	let depth = 0;
	let current = zoneMap.get(zoneId);
	while (current?.parentZoneId) {
		depth += 1;
		current = zoneMap.get(current.parentZoneId);
	}
	return depth;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function zoneHasTerminalEvent(paths: RuntimePaths, zoneId: string): boolean {
	const events = readJsonl<ZoneEvent>(getZoneEventPath(paths, zoneId));
	for (let i = events.length - 1; i >= 0; i--) {
		if (events[i].kind === "terminal") return true;
	}
	return false;
}

export function refreshAgentLiveness(paths: RuntimePaths, currentAgentId?: string): AgentMeta[] {
	const changed: AgentMeta[] = [];
	for (const meta of listAgentMetas(paths)) {
		if (!meta.alive || !meta.pid) continue;
		if (currentAgentId && meta.agentId === currentAgentId) continue;
		if (processExists(meta.pid)) continue;
		meta.alive = false;
		meta.lastStatus = meta.lastStatus === "killed" ? "killed" : "stopped";
		meta.lastStatusAt = new Date().toISOString();
		saveAgentMeta(paths, meta);
		if (!zoneHasTerminalEvent(paths, meta.zoneId)) {
			emitZoneEvent(paths, {
				eventId: randomId("evt"),
				timestamp: new Date().toISOString(),
				zoneId: meta.zoneId,
				emittingAgentId: meta.agentId,
				kind: "terminal",
				payload: { status: meta.lastStatus },
			});
		}
		changed.push(meta);
	}
	return changed;
}

export function writeSnapshot(paths: RuntimePaths, name: string, markdown: string): string {
	mkdirp(paths.snapshotsDir);
	const filePath = path.join(paths.snapshotsDir, `${name}-${Date.now()}.md`);
	fs.writeFileSync(filePath, markdown, "utf8");
	return filePath;
}

export function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

export function spawnChildProcess(paths: RuntimePaths, parentAgent: AgentMeta, options: SpawnOptions): AgentMeta {
	const childAgentId = randomId("agent");
	const childZoneId = randomId("zone");
	const childName = options.name?.trim() || childAgentId;
	const childMeta: AgentMeta = {
		agentId: childAgentId,
		name: childName,
		zoneId: childZoneId,
		parentAgentId: parentAgent.agentId,
		parentZoneId: parentAgent.zoneId,
		seedVisibleZoneIds: Array.from(new Set([...buildVisibleZoneIds(paths, parentAgent), childZoneId])),
		cwd: parentAgent.cwd,
		createdAt: new Date().toISOString(),
		alive: true,
		lastStatus: "alive",
		lastStatusAt: new Date().toISOString(),
		isRoot: false,
	};
	saveAgentMeta(paths, childMeta);
	saveZoneMeta(paths, {
		zoneId: childZoneId,
		ownerAgentId: childAgentId,
		parentZoneId: parentAgent.zoneId,
		createdAt: childMeta.createdAt,
	});

	const snapshotPath = writeSnapshot(paths, childAgentId, options.snapshotMarkdown);
	const appendSystemPrompt =
		options.appendSystemPrompt ||
		[
			`You are subagent ${childName} (${childAgentId}).`,
			`Your root zone is ${childZoneId}.`,
			`You may use recursive subagents when helpful.`,
			`You do not return a special handoff. Do the work and stop when done.`,
		].join("\n");

	const args = ["-p", "--no-session"];
	if (options.extensionPath) args.push("-e", options.extensionPath);
	args.push(`@${snapshotPath}`, options.task, "--append-system-prompt", appendSystemPrompt);
	if (options.model) args.push("--model", options.model);
	if (options.thinkingLevel) args.push("--thinking", options.thinkingLevel);
	const invocation = getPiInvocation(args);
	const childEnv = {
		...process.env,
		PI_SUBAGENT_AGENT_ID: childAgentId,
		PI_SUBAGENT_AGENT_NAME: childName,
		PI_SUBAGENT_ZONE_ID: childZoneId,
		PI_SUBAGENT_PARENT_AGENT_ID: parentAgent.agentId,
		PI_SUBAGENT_PARENT_ZONE_ID: parentAgent.zoneId,
		PI_SUBAGENT_SEED_VISIBLE_ZONES: JSON.stringify(childMeta.seedVisibleZoneIds),
	};
	const child = spawn(invocation.command, invocation.args, {
		cwd: parentAgent.cwd,
		env: childEnv,
		stdio: "ignore",
		detached: true,
	});
	child.unref();
	childMeta.pid = child.pid;
	saveAgentMeta(paths, childMeta);
	return childMeta;
}

export function appendAgentTerminalEvent(paths: RuntimePaths, agentId: string, status: string): AgentMeta | null {
	const meta = getAgentMeta(paths, agentId);
	if (!meta) return null;
	meta.alive = false;
	meta.lastStatus = status;
	meta.lastStatusAt = new Date().toISOString();
	saveAgentMeta(paths, meta);
	emitZoneEvent(paths, {
		eventId: randomId("evt"),
		timestamp: new Date().toISOString(),
		zoneId: meta.zoneId,
		emittingAgentId: meta.agentId,
		kind: "terminal",
		payload: { status },
	});
	return meta;
}

export function killAgentProcess(paths: RuntimePaths, agentId: string): { ok: boolean; reason?: string } {
	const meta = getAgentMeta(paths, agentId);
	if (!meta) return { ok: false, reason: `Unknown agent: ${agentId}` };
	if (!meta.alive || !meta.pid) return { ok: false, reason: `Agent is not running: ${agentId}` };
	try {
		process.kill(meta.pid);
		appendAgentTerminalEvent(paths, agentId, "killed");
		return { ok: true };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

export function extractTextFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (!part || typeof part !== "object") return "";
			const item = part as { type?: string; text?: string };
			return item.type === "text" ? (item.text ?? "") : "";
		})
		.filter(Boolean)
		.join("\n");
}

export function renderSessionBranchSnapshot(entries: unknown[]): string {
	const lines: string[] = ["# Direct conversation snapshot", ""];
	for (const rawEntry of entries) {
		if (!rawEntry || typeof rawEntry !== "object") continue;
		const entry = rawEntry as Record<string, unknown>;
		switch (entry.type) {
			case "message": {
				const message = entry.message as Record<string, unknown> | undefined;
				if (!message) break;
				const role = String(message.role ?? "message");
				const text = extractTextFromContent(message.content);
				if (text.trim()) lines.push(`## ${role}\n${text}\n`);
				break;
			}
			case "compaction": {
				const summary = String(entry.summary ?? "");
				if (summary.trim()) lines.push(`## compaction\n${summary}\n`);
				break;
			}
			case "branch_summary": {
				const summary = String(entry.summary ?? "");
				if (summary.trim()) lines.push(`## branch summary\n${summary}\n`);
				break;
			}
			case "custom_message": {
				const text = extractTextFromContent(entry.content);
				const customType = String(entry.customType ?? "custom_message");
				if (text.trim()) lines.push(`## ${customType}\n${text}\n`);
				break;
			}
		}
	}
	return lines.join("\n").trim();
}
