import type { Conversation, Workspace } from "@hipi/work-runtime/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";
import { ReopenRequest } from "./reopen-request.ts";

export type DisconnectConfirmation = { warning?: string; commit: () => boolean };

export function ConnectionActions({
	disconnect,
	prepareDisconnect,
	onOpen,
}: {
	disconnect: () => void;
	prepareDisconnect?: () => DisconnectConfirmation;
	onOpen: (workspace: Workspace, conversation: Conversation) => void;
}) {
	const client = useAppClient();
	const workspaceInputId = useId();
	const conversationInputId = useId();
	const { t } = usePreferences();
	const [reopen, setReopen] = useState(false);
	const [disconnecting, setDisconnecting] = useState<DisconnectConfirmation | null>(null);
	const [changed, setChanged] = useState(false);
	const prepare = () =>
		prepareDisconnect?.() ?? {
			commit: () => {
				disconnect();
				return true;
			},
		};
	const [workspaceId, setWorkspaceId] = useState("");
	const [conversationId, setConversationId] = useState("");
	const [request] = useState(() => new ReopenRequest());
	useEffect(() => () => request.cancel(), [request]);
	const opening = useMutation({
		mutationFn: (run: () => Promise<void>) => run(),
	});
	function changeReopen(open: boolean) {
		if (!open) request.cancel();
		opening.reset();
		setReopen(open);
	}
	return (
		<>
			<Dialog open={reopen} onOpenChange={changeReopen}>
				<DialogTrigger asChild>
					<Button variant="ghost" className="w-full justify-start">
						{t("nav.open")}
					</Button>
				</DialogTrigger>
				<DialogContent closeLabel={t("common.close")}>
					<DialogTitle className="text-lg font-semibold">{t("nav.open")}</DialogTitle>
					<DialogDescription className="small-copy">{t("nav.localIndex")}</DialogDescription>
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (opening.isPending) return;
							const run = request.begin(client, { workspaceId, conversationId }, (workspace, conversation) => {
								onOpen(workspace, conversation);
								changeReopen(false);
							});
							if (run) opening.mutate(run);
						}}
					>
						<label className="field" htmlFor={workspaceInputId}>
							{t("common.workspaceId")}
							<Input
								id={workspaceInputId}
								required
								value={workspaceId}
								onChange={(event) => setWorkspaceId(event.target.value)}
								maxLength={128}
							/>
						</label>
						<label className="field" htmlFor={conversationInputId}>
							{t("common.conversationId")}
							<Input
								id={conversationInputId}
								required
								value={conversationId}
								onChange={(event) => setConversationId(event.target.value)}
								maxLength={128}
							/>
						</label>
						{opening.isError && (
							<p className="error-text" role="alert">
								{t("work.error")}
							</p>
						)}
						<div className="flex justify-end gap-2">
							<DialogClose asChild>
								<Button variant="ghost">{t("common.cancel")}</Button>
							</DialogClose>
							<Button type="submit" disabled={opening.isPending}>
								{t(opening.isPending ? "common.loading" : "common.open")}
							</Button>
						</div>
					</form>
				</DialogContent>
			</Dialog>
			<Dialog
				open={disconnecting !== null}
				onOpenChange={(open) => {
					setChanged(false);
					setDisconnecting(open ? prepare() : null);
				}}
			>
				<DialogTrigger asChild>
					<Button variant="ghost" className="w-full justify-start">
						{t("connection.disconnect")}
					</Button>
				</DialogTrigger>
				<DialogContent closeLabel={t("common.close")}>
					<DialogTitle className="text-lg font-semibold">{t("connection.disconnect")}</DialogTitle>
					<DialogDescription className="small-copy">{t("connection.leaveNote")}</DialogDescription>
					{disconnecting?.warning && <p className="notice">{disconnecting.warning}</p>}
					{changed && (
						<p className="notice" role="alert">
							{t("connection.reviewChanged")}
						</p>
					)}
					<div className="flex justify-end gap-2">
						<DialogClose asChild>
							<Button variant="ghost">{t("common.cancel")}</Button>
						</DialogClose>
						<Button
							onClick={() => {
								if (!disconnecting?.commit()) {
									setDisconnecting(prepare());
									setChanged(true);
								} else setDisconnecting(null);
							}}
						>
							{t("connection.confirmDisconnect")}
						</Button>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}
