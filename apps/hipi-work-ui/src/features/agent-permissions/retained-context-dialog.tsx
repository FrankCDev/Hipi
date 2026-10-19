import type { AgentContext, ModelReference, Scope } from "@hipi/work-runtime/contracts";
import { useState, useSyncExternalStore } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.tsx";
import { permissionLabels } from "./labels.ts";
import type { PermissionSession } from "./permission-session.ts";

type ConsentProps = {
	scope: Scope;
	source: AgentContext;
	model?: ModelReference;
	session: PermissionSession;
	disabled: boolean;
	disabledReason?: string;
};
export function RetainedContextDialog(props: ConsentProps) {
	const { locale } = usePreferences();
	const l = permissionLabels(locale);
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="outline"
					size="sm"
					disabled={props.disabled || !props.model || props.source.purpose !== "live-files"}
				>
					{l["permissions.retained.authorize"]}
				</Button>
			</DialogTrigger>
			<DialogContent closeLabel={l["permissions.action.close"]} className="max-h-[85vh] overflow-y-auto">
				<RetainedContextConsent {...props} onAuthorized={() => setOpen(false)} />
			</DialogContent>
		</Dialog>
	);
}
export function RetainedContextConsent({
	scope,
	source,
	model,
	session,
	disabled,
	disabledReason,
	onAuthorized,
}: ConsentProps & { onAuthorized: () => void }) {
	const { locale } = usePreferences();
	const l = permissionLabels(locale);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [duration, setDuration] = useState("900000");
	const eligible =
		source.purpose === "live-files" &&
		source.workspaceId === scope.workspaceId &&
		source.conversationId === scope.conversationId;
	return (
		<>
			<DialogTitle>{l["permissions.retained.authorize"]}</DialogTitle>
			<DialogDescription>{l["permissions.retained.disclosure"]}</DialogDescription>
			{disabledReason && <output>{disabledReason}</output>}
			<p className="break-all">
				{l["permissions.context.scope"]}: {scope.workspaceId} / {scope.conversationId}
			</p>
			<p className="break-all">
				{l["permissions.context.model"]}: {model?.provider} / {model?.modelId}
			</p>
			<p className="break-all">
				{l["permissions.retained.source"]}: {source.grantId}
			</p>
			<p className="break-all">
				{l["permissions.retained.range"]}: {source.rootId} / {source.pathPrefixes.map((path) => path || "/").join(", ")}
			</p>
			<p>{l["permissions.retained.restart"]}</p>
			<Select value={duration} onValueChange={setDuration}>
				<SelectTrigger aria-label={l["permissions.context.expiry"]}>
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="900000">{l["permissions.context.short"]}</SelectItem>
					<SelectItem value="3600000">{l["permissions.context.long"]}</SelectItem>
				</SelectContent>
			</Select>
			{state.failed && <p role="alert">{l["permissions.action.failed"]}</p>}
			{state.uncertain && <p role="alert">{l["permissions.action.unknown"]}</p>}
			<Button
				disabled={disabled || !model || !eligible}
				onClick={() => {
					if (disabled || !model || !eligible) return;
					void session
						.authorizeRetained({
							...scope,
							requestId: crypto.randomUUID(),
							sourceGrantId: source.grantId,
							model,
							expiresAt: Date.now() + Number(duration),
							disclosureVersion: 1,
						})
						.then(() => {
							if (!session.getSnapshot().failed && !session.getSnapshot().uncertain) onAuthorized();
						});
				}}
			>
				{l["permissions.retained.authorize"]}
			</Button>
		</>
	);
}
