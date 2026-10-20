import { AppError, type ConversationSearchHit, SEARCH_LIMITS } from "@hipi/work-runtime/contracts";
import { Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../components/ui/dialog.tsx";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../../components/ui/input-group.tsx";
import { ConversationSearchController, searchHitKey } from "./conversation-search-controller.ts";
import { conversationSearchLabels } from "./conversation-search-labels.ts";
import { SearchHighlight } from "./search-highlight.tsx";
import "./conversation-search.css";

export function ConversationSearch({
	open,
	onOpenChange,
	onRestoreFocus,
	onActivate,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onRestoreFocus: () => void;
	onActivate: (hit: ConversationSearchHit, signal: AbortSignal) => Promise<boolean>;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			{open && (
				<SearchContent onClose={() => onOpenChange(false)} onRestoreFocus={onRestoreFocus} onActivate={onActivate} />
			)}
		</Dialog>
	);
}

function SearchContent({
	onClose,
	onRestoreFocus,
	onActivate,
}: {
	onClose: () => void;
	onRestoreFocus: () => void;
	onActivate: (hit: ConversationSearchHit, signal: AbortSignal) => Promise<boolean>;
}) {
	const client = useAppClient();
	const { locale } = usePreferences();
	const l = conversationSearchLabels(locale);
	const owner = useMemo(() => new ConversationSearchController(client), [client]);
	const state = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
	const [value, setValue] = useState("");
	const [selected, setSelected] = useState<string>();
	const [opening, setOpening] = useState(false);
	const [openError, setOpenError] = useState<"stale" | "failed">();
	const activation = useRef<AbortController | undefined>(undefined);
	const input = useRef<HTMLInputElement>(null);
	const composing = useRef(false);
	const id = useId();
	useEffect(() => {
		owner.activate();
		return () => {
			activation.current?.abort();
			activation.current = undefined;
			owner.dispose();
		};
	}, [owner]);
	const selectedIndex = Math.max(
		0,
		state.items.findIndex((item) => searchHitKey(item) === selected),
	);
	const active = state.items[selectedIndex];
	const activate = async (hit: ConversationSearchHit) => {
		activation.current?.abort();
		const request = new AbortController();
		activation.current = request;
		setOpening(true);
		setOpenError(undefined);
		try {
			const opened = await onActivate(hit, request.signal);
			if (activation.current === request && !request.signal.aborted && opened) onClose();
		} catch (error) {
			if (activation.current !== request || request.signal.aborted) return;
			setOpenError(
				error instanceof AppError &&
					(error.code === "CURSOR_STALE" || error.code === "CONVERSATION_ARCHIVED" || error.code === "NOT_FOUND")
					? "stale"
					: "failed",
			);
		} finally {
			if (activation.current === request) {
				// Promise.all can reject while a sibling metadata/hydration read is
				// still pending. Release its signal before dropping the group owner.
				request.abort();
				activation.current = undefined;
				setOpening(false);
			}
		}
	};
	const change = (next: string, isComposing = composing.current) => {
		activation.current?.abort();
		activation.current = undefined;
		setOpening(false);
		setOpenError(undefined);
		setValue(next);
		setSelected(undefined);
		owner.setQuery(next, isComposing);
	};
	const complete =
		!state.refreshing &&
		!state.refreshFailed &&
		state.index?.state === "ready" &&
		state.queryGeneration === state.index.generation;
	const move = (index: number) => {
		const hit = state.items[index];
		if (!hit) return;
		setSelected(searchHitKey(hit));
		document.getElementById(`${id}-result-${index}`)?.scrollIntoView({ block: "nearest" });
	};
	return (
		<DialogContent
			className="conversation-search-dialog"
			closeLabel={l.close}
			onOpenAutoFocus={(event) => {
				event.preventDefault();
				input.current?.focus({ preventScroll: true });
			}}
			onCloseAutoFocus={(event) => {
				event.preventDefault();
				onRestoreFocus();
			}}
			onEscapeKeyDown={(event) => {
				if (composing.current || event.isComposing || event.keyCode === 229) event.preventDefault();
			}}
		>
			<DialogTitle>{l.title}</DialogTitle>
			<DialogDescription className="sr-only">{l.scope}</DialogDescription>
			<InputGroup className="conversation-search-input">
				<InputGroupAddon>
					<Search size={18} aria-hidden="true" />
				</InputGroupAddon>
				<InputGroupInput
					ref={input}
					role="combobox"
					aria-label={l.title}
					aria-autocomplete="list"
					aria-expanded
					aria-controls={`${id}-results`}
					aria-activedescendant={active ? `${id}-result-${selectedIndex}` : undefined}
					autoComplete="off"
					maxLength={SEARCH_LIMITS.query}
					placeholder={l.placeholder}
					value={value}
					onChange={(event) => change(event.target.value)}
					onCompositionStart={() => {
						composing.current = true;
						change(value, true);
					}}
					onCompositionEnd={(event) => {
						composing.current = false;
						change(event.currentTarget.value, false);
					}}
					onKeyDown={(event) => {
						if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
						if (event.key === "ArrowDown" || event.key === "ArrowUp") {
							event.preventDefault();
							move(Math.max(0, Math.min(state.items.length - 1, selectedIndex + (event.key === "ArrowDown" ? 1 : -1))));
						} else if (event.key === "Enter" && active && !opening) {
							event.preventDefault();
							void activate(active);
						}
					}}
				/>
				{value && (
					<InputGroupAddon align="inline-end">
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={l.clear}
							className="conversation-search-clear"
							onClick={() => {
								composing.current = false;
								change("", false);
								input.current?.focus({ preventScroll: true });
							}}
						>
							<X size={16} aria-hidden="true" />
						</Button>
					</InputGroupAddon>
				)}
			</InputGroup>
			<div className="conversation-search-results" role="listbox" id={`${id}-results`} aria-label={l.title}>
				{state.items.map((hit, index) => (
					<button
						key={searchHitKey(hit)}
						id={`${id}-result-${index}`}
						type="button"
						role="option"
						tabIndex={-1}
						aria-selected={index === selectedIndex}
						disabled={opening}
						className="conversation-search-result"
						data-workspace-id={hit.workspaceId}
						data-conversation-id={hit.conversationId}
						data-message-id={hit.kind === "message" ? hit.messageId : undefined}
						data-match-kind={hit.kind}
						onPointerMove={() => setSelected(searchHitKey(hit))}
						onClick={() => void activate(hit)}
					>
						<span className="conversation-search-result-title">{hit.title}</span>
						<span className="conversation-search-result-project">
							{hit.workspaceName} · {hit.kind === "message" ? l.messageMatch : l.titleMatch}
						</span>
						<span className="conversation-search-snippet">
							<SearchHighlight
								text={hit.snippet}
								offset={hit.snippetOffset}
								start={hit.matchStart}
								end={hit.matchEnd}
							/>
						</span>
					</button>
				))}
			</div>
			<div className="conversation-search-status" aria-live="polite">
				{!state.query && <p>{l.start}</p>}
				{state.loading && <output>{l.loading}</output>}
				{state.refreshing && <output>{state.index?.completedAt ? l.refreshing : l.building}</output>}
				{state.query && !complete && <p>{l.partial}</p>}
				{state.query &&
					complete &&
					!state.loading &&
					!state.failed &&
					!state.scanLimited &&
					!state.items.length &&
					!state.nextCursor && <p>{l.empty}</p>}
				{opening && <output>{l.opening}</output>}
				{openError && <p role="alert">{openError === "stale" ? l.stale : l.openFailed}</p>}
				{state.failed && (
					<p role="alert">
						{l.failed}{" "}
						<Button size="sm" variant="ghost" onClick={owner.restart}>
							{l.retry}
						</Button>
					</p>
				)}
				{state.refreshFailed && <p role="alert">{l.refreshFailed}</p>}
				<div className="conversation-search-actions">
					{state.nextCursor && (
						<Button size="sm" variant="outline" disabled={state.loading} onClick={owner.loadMore}>
							{state.scanLimited ? l.continue : l.more}
						</Button>
					)}
					<Button size="sm" variant="ghost" disabled={state.refreshing} onClick={owner.refresh}>
						{l.refresh}
					</Button>
				</div>
			</div>
		</DialogContent>
	);
}
