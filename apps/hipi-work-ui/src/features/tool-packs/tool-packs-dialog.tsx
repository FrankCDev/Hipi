import type { Conversation } from "@hipi/work-runtime/contracts";
import { useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { toolPackLabels } from "./labels.ts";
import { ToolPacksPanel } from "./tool-packs-panel.tsx";

export function ToolPacksDialog({
	workspaceId,
	conversation,
	connected,
}: {
	workspaceId: string;
	conversation?: Conversation;
	connected: boolean;
}) {
	const { locale } = usePreferences();
	const l = toolPackLabels(locale);
	const [open, setOpen] = useState(false);
	return (
		<ToolPacksPanel workspaceId={workspaceId} conversation={conversation} active={open} connected={connected}>
			{(content) => (
				<Dialog open={open} onOpenChange={setOpen}>
					<DialogTrigger asChild>
						<Button variant="ghost" size="sm" disabled={!workspaceId}>
							{l["toolPacks.title"]}
						</Button>
					</DialogTrigger>
					<DialogContent
						scrollBody
						closeLabel={l["toolPacks.close"]}
						className="tool-packs-dialog sm:max-w-2xl break-words"
						aria-describedby={undefined}
					>
						<DialogTitle>{l["toolPacks.title"]}</DialogTitle>
						<DialogBody>{content}</DialogBody>
					</DialogContent>
				</Dialog>
			)}
		</ToolPacksPanel>
	);
}
