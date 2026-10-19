import {
	type AppClient,
	LIMITS,
	type Message,
	type Method,
	type Params,
	PROTOCOL_VERSION,
	parseRequest,
	parseResult,
	parseSnapshot,
	type Result,
	type Scope,
	type Snapshot,
} from "@hipi/work-runtime/contracts";
import { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppClientProvider } from "../../src/app/client-provider.tsx";
import { PreferencesProvider } from "../../src/app/preferences.tsx";
import { ConversationHistory } from "../../src/features/workbench/conversation-history.tsx";
import "../../src/theme.css";
import "./fixture.css";

// Isolated component acceptance only: no production route, transport, runtime or model.
const total = 384;
const initialStart = total - LIMITS.historyMessages;
const emptyHistory = new URLSearchParams(location.search).has("empty");
const original = Array.from({ length: 480 }, (_, i) => `Original line ${i}: ${"abcdef0123456789 ".repeat(5)}`).join(
	"\n",
);
const source = (index: number) =>
	`Message ${index}\n\n${"A wrapping paragraph 中文阅读位置. ".repeat(4 + (index % 5))}\n\n` +
	`\`\`\`ts\n${Array.from({ length: 2 + (index % 4) }, (_, line) => `const item${line} = ${index};`).join("\n")}\n\`\`\``;
function message(index: number): Message {
	const truncated = index === total - 4;
	const text = truncated ? "Bounded original preview. Open to read the authoritative text page." : source(index);
	return {
		id: `m-${index}`,
		role: "assistant",
		text,
		textLength: truncated ? original.length : text.length,
		truncated,
	};
}
const initialMessages = Array.from({ length: LIMITS.historyMessages }, (_, i) => message(initialStart + i));
const scope: Scope = { workspaceId: "fixture-workspace", conversationId: "fixture-a" };
function initial(boundScope: Scope): Snapshot {
	return parseSnapshot({
		...boundScope,
		messages: initialMessages,
		partial: "",
		partialLength: 0,
		partialTruncated: false,
		running: false,
		historyCursor: emptyHistory ? "scan-0" : String(initialStart),
	});
}
type CallRecord = {
	method: Method;
	conversationId: string;
	cursor?: string;
	offset?: number;
	aborted: boolean;
	settled: boolean;
};
const calls: CallRecord[] = [];
let pending: (() => void)[] = [];
let maxActive = 0;
let streamText = "";
const client: AppClient = {
	async call<M extends Method>(method: M, params: Params<M>, signal?: AbortSignal): Promise<Result<M>> {
		const request = parseRequest({ version: PROTOCOL_VERSION, method, params });
		if (request.method !== "getHistory" && request.method !== "getMessageText")
			throw new Error(`Unexpected fixture call: ${method}`);
		const p = request.params;
		const record: CallRecord = {
			method,
			conversationId: p.conversationId,
			...("cursor" in p ? { cursor: p.cursor } : {}),
			...("offset" in p ? { offset: p.offset } : {}),
			aborted: signal?.aborted ?? false,
			settled: false,
		};
		calls.push(record);
		maxActive = Math.max(maxActive, calls.filter((call) => !call.settled && !call.aborted).length);
		const aborted = () => {
			record.aborted = true;
		};
		signal?.addEventListener("abort", aborted, { once: true });
		// Deliberately ignore cancellation until release: exercise late-result suppression.
		await new Promise<void>((resolve) => pending.push(resolve));
		signal?.removeEventListener("abort", aborted);
		record.settled = true;
		const boundScope = { workspaceId: p.workspaceId, conversationId: p.conversationId };
		if (request.method === "getHistory") {
			const cursor = request.params.cursor ?? String(initialStart);
			if (cursor.startsWith("scan-"))
				return parseResult(method, { ...boundScope, messages: [], nextCursor: `scan-${Number(cursor.slice(5)) + 1}` });
			const end = Number(cursor);
			const start = Math.max(0, end - 31);
			// Repeat the boundary ID on purpose: retained originals must win and not duplicate.
			return parseResult(method, {
				...boundScope,
				messages: Array.from({ length: end - start + 1 }, (_, i) => message(start + i)),
				nextCursor: start > 0 ? String(start) : null,
			});
		}
		const { messageId, offset } = request.params;
		const text = messageId === "stream-final" ? streamText : original;
		const chunk = text.slice(offset, offset + LIMITS.textChunk);
		return parseResult(method, {
			...boundScope,
			messageId,
			offset,
			text: chunk,
			textLength: text.length,
			nextOffset: offset + chunk.length < text.length ? offset + chunk.length : null,
		});
	},
	async observe() {
		throw new Error("Observation is outside component acceptance scope");
	},
};

type Control = {
	release: () => void;
	stream: (step: number, final?: boolean) => void;
	switchScope: () => void;
	stats: () => { calls: CallRecord[]; maxActive: number; total: number; initialStart: number };
};
declare global {
	interface Window {
		messageFixture: Control;
	}
}

function Fixture() {
	const [snapshot, setSnapshot] = useState(() => initial(scope));
	const [streamStep, setStreamStep] = useState(0);
	useLayoutEffect(() => {
		window.messageFixture = {
			release() {
				const batch = pending;
				pending = [];
				for (const resolve of batch) resolve();
			},
			stream(step, final = false) {
				streamText =
					`Stream step ${step}\n\n${"Wrapping streaming paragraph 中文. ".repeat(step * 5)}\n\n\`\`\`ts\n` +
					Array.from({ length: step * 3 }, (_, i) => `const streamed${i} = ${i};`).join("\n") +
					(final ? "\n```" : "");
				setSnapshot((current) =>
					parseSnapshot({
						...current,
						messages: final
							? [
									...current.messages.slice(-31),
									{
										id: "stream-final",
										role: "assistant",
										text: streamText.slice(0, LIMITS.messagePreview),
										textLength: streamText.length,
										truncated: streamText.length > LIMITS.messagePreview,
									},
								]
							: current.messages,
						partial: final ? "" : streamText,
						partialLength: final ? 0 : streamText.length,
						partialTruncated: false,
						running: !final,
					}),
				);
			},
			switchScope() {
				setSnapshot(initial({ ...scope, conversationId: "fixture-b" }));
			},
			stats: () => ({ calls, maxActive, total, initialStart }),
		};
	}, []);
	return (
		<AppClientProvider client={client}>
			<PreferencesProvider>
				<nav aria-label="Component acceptance controls" className="fixture-controls">
					<button type="button" onClick={() => window.messageFixture.release()}>
						Release pending read
					</button>
					<button
						type="button"
						onClick={() => {
							const next = streamStep + 3;
							setStreamStep(next);
							window.messageFixture.stream(next);
						}}
					>
						Grow stream
					</button>
					<button type="button" onClick={() => window.messageFixture.stream(Math.max(3, streamStep), true)}>
						Commit stream
					</button>
					<button type="button" onClick={() => window.messageFixture.switchScope()}>
						Switch conversation
					</button>
				</nav>
				<main
					className="fixture-shell"
					data-scope={snapshot.conversationId}
					data-running={snapshot.running}
					data-fixed={new URLSearchParams(location.search).has("fixed")}
				>
					<ConversationHistory scope={snapshot} snapshot={snapshot} error={false} />
				</main>
			</PreferencesProvider>
		</AppClientProvider>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
createRoot(root).render(<Fixture />);
