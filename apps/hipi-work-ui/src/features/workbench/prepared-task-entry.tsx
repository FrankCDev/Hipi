import { LIMITS, type ModelReference } from "@hipi/work-runtime/contracts";
import { useId, useRef } from "react";
import { useLocalState } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Textarea } from "../../components/ui/textarea.tsx";
import { ConversationStarters } from "./conversation-starters.tsx";
import { CreateDialog } from "./create-dialog.tsx";
import { workbenchLabels } from "./workbench-labels.ts";

/** Project-local input only. Creation and eventual submission remain separate explicit decisions. */
export function PreparedTaskEntry({
	workspaceId,
	disabled,
	onCreate,
	draft,
	onDraftChange,
}: {
	workspaceId: string;
	disabled: boolean;
	onCreate: (title: string, model?: ModelReference, initialDraft?: string) => Promise<void>;
	draft: string;
	onDraftChange: (value: string) => void;
}) {
	const local = useLocalState();
	const { locale } = usePreferences();
	const l = workbenchLabels(locale);
	const input = useRef<HTMLTextAreaElement>(null);
	const inputId = useId();
	return (
		<div className="prepared-task-entry">
			<div className="prepared-task-composer">
				<label className="sr-only" htmlFor={inputId}>
					{l["workbench.taskGoal"]}
				</label>
				<Textarea
					id={inputId}
					ref={input}
					className="prepared-task-input"
					rows={4}
					value={draft}
					maxLength={LIMITS.text}
					placeholder={l["workbench.taskPlaceholder"]}
					aria-describedby={`${inputId}-note`}
					onChange={(event) => onDraftChange(event.target.value)}
				/>
				<div className="prepared-task-footer">
					<span>{l[local.storageAvailable ? "workbench.taskSaved" : "workbench.taskUnsaved"]}</span>
					<CreateDialog
						kind="conversation"
						workspaceId={workspaceId}
						draft={draft}
						onDraftChange={onDraftChange}
						disabled={disabled}
						triggerLabel={l["workbench.taskContinue"]}
						onCreate={onCreate}
					/>
				</div>
			</div>
			<p className="prepared-task-note" id={`${inputId}-note`}>
				{l["workbench.taskNotSent"]}
			</p>
			<ConversationStarters
				hasDraft={draft.length > 0}
				disabled={disabled}
				onSelect={(text) => {
					if (draft.length || disabled) return;
					onDraftChange(text);
					input.current?.focus();
				}}
			/>
		</div>
	);
}
