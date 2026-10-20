import { ContextMenu } from "radix-ui";
import type { ReactNode } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { fileLabels } from "./file-labels.ts";
import type { FileWorkspaceSession } from "./file-workspace-session.ts";
import "../../components/ui/control-primitives.css";
import "./file-tab-menu.css";

type CloseAction = "close" | "others" | "right";
/** Compute against the current exact tab, never whichever tab became active later. */
export function fileTabCloseTargets(session: FileWorkspaceSession, id: string, action: CloseAction) {
	const tab = session.snapshot().tabs.find((item) => item.id === id);
	if (!tab) return [];
	const tabs = session.snapshot().tabs.filter((item) => item.target.workspaceId === tab.target.workspaceId);
	return action === "close"
		? [id]
		: (action === "others"
				? tabs.filter((item) => item.id !== id)
				: tabs.slice(tabs.findIndex((item) => item.id === id) + 1)
			).map((item) => item.id);
}

export function FileTabContextMenu({
	id,
	session,
	close,
	closing,
	children,
}: {
	id: string;
	session: FileWorkspaceSession;
	close: (ids: string[]) => void;
	closing: boolean;
	children: ReactNode;
}) {
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
			<ContextMenu.Portal>
				<ContextMenu.Content
					className="ui-menu-surface file-tab-context-menu"
					collisionPadding={6}
					aria-label={l["tabs.actions"]}
				>
					{(
						[
							["close", "tabs.close"],
							["others", "tabs.closeOthers"],
							["right", "tabs.closeRight"],
						] as const
					).map(([action, label]) => (
						<ContextMenu.Item
							key={action}
							className="ui-menu-row file-tab-context-item"
							disabled={closing || fileTabCloseTargets(session, id, action).length === 0}
							onSelect={() => {
								if (!closing) close(fileTabCloseTargets(session, id, action));
							}}
						>
							{l[label]}
						</ContextMenu.Item>
					))}
				</ContextMenu.Content>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}
