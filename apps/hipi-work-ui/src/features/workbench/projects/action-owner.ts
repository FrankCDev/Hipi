import { PROTOCOL_VERSION, type Project, type ProjectListItem } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CatalogSession } from "../catalog/session.ts";
import type { ProjectCatalogCommand } from "../command-recovery.ts";
import { matchesProjectCommand } from "./commands.ts";

type RenameCommand = Extract<ProjectCatalogCommand, { method: "renameProject" }>;
type ActionCommand = Extract<ProjectCatalogCommand, { method: "renameProject" | "setProjectPinned" }>;
type InlineRename = {
	target: Project;
	draft: string;
	editing: boolean;
	request: RenameCommand | null;
	validationAttempt?: number;
};
export type ProjectPinNotice = {
	projectId: string;
	projectName: string;
	reason: "rename_unconfirmed" | "pin_not_applied" | null;
};

/** A branch owns edit intent; the durable catalog owns every admitted mutation. */
export function useProjectActionOwner(
	item: ProjectListItem | undefined,
	session: CatalogSession,
	guard: (action: () => void) => void,
	projectPinEnabled = false,
	enabled = true,
	onPinNotice?: (notice: ProjectPinNotice) => void,
) {
	const cache = useQueryClient();
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [inline, setInline] = useState<InlineRename | null>(null);
	const [pinContinuing, setPinContinuing] = useState(false);
	const continuation = useRef(false);
	const flight = useRef<{ request: RenameCommand; done: Promise<void> } | null>(null);
	const edit = useRef<InlineRename | null>(null);
	const command = useRef<ActionCommand | null>(null);
	const reconciled = useRef<string | null>(null);
	const permissions = useRef({ enabled, projectPinEnabled });
	useLayoutEffect(() => {
		permissions.current = { enabled, projectPinEnabled };
	}, [enabled, projectPinEnabled]);
	const available = () => {
		const current = session.getSnapshot();
		return (
			permissions.current.enabled && !current.busy && !current.pending && !current.initialSend && !current.incompatible
		);
	};
	const updateInline = (value: InlineRename | null) => {
		edit.current = value;
		setInline(value);
	};
	const reconcile = () => {
		const request = command.current;
		const current = session.getSnapshot();
		if (
			!request ||
			current.pending ||
			current.failed ||
			!current.projectResult ||
			!matchesProjectCommand(request, current.projectResult) ||
			reconciled.current === request.params.requestId
		)
			return;
		reconciled.current = request.params.requestId;
		if (current.projectResult.method === "renameProject") {
			const result = current.projectResult.result;
			const cached = cache.getQueryData<Project>(["project", result.projectId]);
			if (!cached || cached.revision <= result.revision) cache.setQueryData(["project", result.projectId], result);
		}
		for (const key of [
			["projects"],
			["project", request.params.projectId],
			["project-catalog"],
			["sidebar-navigation"],
			["sidebar-pins"],
		])
			void cache.invalidateQueries({ queryKey: key });
		if (edit.current?.request && matchesProjectCommand(edit.current.request, current.projectResult)) updateInline(null);
	};
	useEffect(reconcile);
	const execute = (request: ActionCommand) => {
		guard(() => {
			if (!available()) return;
			if (request.method === "setProjectPinned" && !permissions.current.projectPinEnabled) return;
			command.current = request;
			const done = session.execute(request);
			if (request.method === "renameProject") flight.current = { request, done };
			void done.then(() => {
				const current = session.getSnapshot();
				if (current.failed && !current.pending) {
					void cache.invalidateQueries({ queryKey: ["projects"] });
					void cache.invalidateQueries({ queryKey: ["project", request.params.projectId] });
				}
				reconcile();
			});
		});
	};
	const renameProject = (target: Project, value: string): RenameCommand | null => {
		const name = value.trim();
		if (!available() || !name || name.length > 128) return null;
		const request: RenameCommand = {
			version: PROTOCOL_VERSION,
			method: "renameProject",
			params: { requestId: crypto.randomUUID(), projectId: target.projectId, expectedRevision: target.revision, name },
		};
		execute(request);
		return request;
	};
	const commitInlineRename = () => {
		const current = edit.current;
		if (!current?.editing || !available()) return;
		const name = current.draft.trim();
		if (name.length > 128) {
			updateInline({ ...current, validationAttempt: (current.validationAttempt ?? 0) + 1 });
			return;
		}
		updateInline({ ...current, editing: false });
		if (!name || name === current.target.name) {
			updateInline(null);
			return;
		}
		const request = renameProject(current.target, name);
		updateInline({ ...current, editing: false, request });
	};
	const ownRename = () => {
		const current = session.getSnapshot();
		return (
			!!edit.current?.request &&
			flight.current?.request === edit.current.request &&
			!current.failed &&
			!current.incompatible &&
			!current.initialSend &&
			(!current.pending ||
				(current.pending.method === "renameProject" &&
					current.pending.params.requestId === flight.current.request.params.requestId))
		);
	};
	return {
		state,
		projectId: item?.project.projectId,
		disabled: !enabled || state.busy || !!state.pending || !!state.initialSend || state.incompatible,
		canAct: available,
		isBusy: () => session.getSnapshot().busy,
		projectPinEnabled,
		pinned: item?.presentation.pinned ?? false,
		pinDisabled:
			!item ||
			!enabled ||
			!projectPinEnabled ||
			pinContinuing ||
			item.presentation.projectId !== item.project.projectId ||
			(!available() && !ownRename()),
		inline,
		inlineFailed: !!inline?.request && state.failed && command.current === inline.request,
		renameProject,
		togglePin: () => {
			if (
				!item ||
				!permissions.current.enabled ||
				!permissions.current.projectPinEnabled ||
				continuation.current ||
				item.presentation.projectId !== item.project.projectId
			)
				return;
			if (edit.current?.editing) {
				commitInlineRename();
				if (edit.current?.editing) return;
			}
			const rename = edit.current?.request;
			const pendingFlight = flight.current;
			if (!available() && !ownRename()) return;
			const pin: Extract<ActionCommand, { method: "setProjectPinned" }> = {
				version: PROTOCOL_VERSION,
				method: "setProjectPinned",
				params: {
					requestId: crypto.randomUUID(),
					projectId: item.project.projectId,
					expectedPresentationRevision: item.presentation.revision,
					pinned: !item.presentation.pinned,
				},
			};
			const notice = { projectId: item.project.projectId, projectName: item.project.name };
			onPinNotice?.({ ...notice, reason: null });
			if (rename) {
				if (!pendingFlight || pendingFlight.request !== rename) return;
				continuation.current = true;
				setPinContinuing(true);
				void session.continueProjectPin(rename, pin, pendingFlight.done).then((result) => {
					if (result === "admitted") {
						command.current = pin;
						reconcile();
					} else if (result !== "disposed") onPinNotice?.({ ...notice, reason: result });
					continuation.current = false;
					setPinContinuing(false);
				});
			} else execute(pin);
		},
		beginInlineRename: () => {
			if (!item || !available()) return;
			const retained = edit.current;
			updateInline({
				target: { ...item.project },
				draft: retained?.target.projectId === item.project.projectId ? retained.draft : item.project.name,
				editing: true,
				request: null,
			});
		},
		changeInlineName: (draft: string) => {
			if (edit.current?.editing) updateInline({ ...edit.current, draft });
		},
		commitInlineRename,
		cancelInlineRename: () => {
			if (edit.current?.editing) updateInline(null);
		},
	};
}

export type ProjectActionOwner = ReturnType<typeof useProjectActionOwner>;
