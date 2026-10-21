import type { Conversation, ModelReference } from "@hipi/work-runtime/contracts";
import { Blocks, FolderPlus, Plus, ShieldCheck } from "lucide-react";
import { type MouseEvent, type ReactNode, useId, useRef, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { ActionTooltip } from "../../components/ui/action-tooltip.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogBody, DialogContent, DialogTitle } from "../../components/ui/dialog.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { AgentPermissionManagement } from "../agent-permissions/agent-permissions.tsx";
import { ToolPacksPanel } from "../tool-packs/index.ts";
import { capabilityLabels } from "./labels.ts";
import "./conversation-capabilities.css";

/** Acquisition and permissions are distinct controls; neither owns the underlying authorization session. */
export function ConversationCapabilities({
	conversation,
	model,
	connected,
	children,
}: {
	conversation: Conversation;
	model?: ModelReference;
	connected: boolean;
	children?: (view: { controls: ReactNode; attention: ReactNode }) => ReactNode;
}) {
	const { locale } = usePreferences();
	const l = capabilityLabels(locale);
	const [section, setSection] = useState<"files" | "tool-packs" | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const plusTrigger = useRef<HTMLButtonElement>(null);
	const returnFocus = useRef<HTMLButtonElement | null>(null);
	const openingDialog = useRef(false);
	const dialogId = useId();
	const showPermissions = (event: MouseEvent<HTMLButtonElement>) => {
		returnFocus.current = event.currentTarget;
		setSection("files");
	};
	return (
		<AgentPermissionManagement
			scope={conversation}
			model={model}
			connected={connected}
			archived={conversation.archivedAt !== null}
			detailsOpen={section === "files"}
			onOpenDetails={showPermissions}
			onContextRestoreFocus={() => plusTrigger.current?.focus()}
		>
			{({ content: permissions, attention, contextAction }) => (
				<ToolPacksPanel
					workspaceId={conversation.workspaceId}
					conversation={conversation}
					active={section === "tool-packs"}
					connected={connected}
				>
					{(toolPacks) => {
						const controls = (
							<section className="permission-controls capabilities-controls" aria-label={l["capabilities.title"]}>
								<div className="capability-actions">
									<DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
										<ActionTooltip
											label={l["capabilities.add"]}
											disabled={menuOpen || section !== null || contextAction["aria-expanded"]}
										>
											<DropdownMenuTrigger asChild>
												<Button
													ref={plusTrigger}
													variant="ghost"
													size="icon-sm"
													className="composer-add-trigger"
													aria-label={l["capabilities.add"]}
												>
													<Plus size={16} aria-hidden="true" />
												</Button>
											</DropdownMenuTrigger>
										</ActionTooltip>
										<DropdownMenuContent
											className="composer-add-menu"
											align="start"
											side="top"
											onCloseAutoFocus={(event) => {
												if (openingDialog.current) event.preventDefault();
												openingDialog.current = false;
											}}
										>
											<DropdownMenuItem asChild disabled={contextAction.disabled}>
												<button
													type="button"
													className="capability-context-trigger"
													{...contextAction}
													onClick={(event) => {
														openingDialog.current = true;
														contextAction.onClick(event);
														setMenuOpen(false);
													}}
												>
													<FolderPlus size={16} aria-hidden="true" />
													{l["capabilities.contextAction"]}
												</button>
											</DropdownMenuItem>
											<DropdownMenuItem asChild>
												<button
													type="button"
													className="capability-tools-trigger"
													aria-haspopup="dialog"
													onClick={() => {
														openingDialog.current = true;
														returnFocus.current = plusTrigger.current;
														setMenuOpen(false);
														setSection("tool-packs");
													}}
												>
													<Blocks size={16} aria-hidden="true" />
													{l["capabilities.toolsAction"]}
												</button>
											</DropdownMenuItem>
										</DropdownMenuContent>
									</DropdownMenu>
									<ActionTooltip
										label={l["capabilities.permissions"]}
										disabled={section !== null || contextAction["aria-expanded"]}
									>
										<Button
											variant="ghost"
											size="sm"
											className="capabilities-trigger permission-mode-trigger"
											aria-label={l["capabilities.permissions"]}
											aria-haspopup="dialog"
											aria-expanded={section === "files"}
											aria-controls={dialogId}
											onClick={showPermissions}
										>
											<ShieldCheck size={16} aria-hidden="true" />
											<span>{l["capabilities.permissions"]}</span>
										</Button>
									</ActionTooltip>
								</div>
							</section>
						);
						return (
							<>
								{children ? (
									children({ controls, attention: section === null ? attention : null })
								) : (
									<>
										{controls}
										{section === null && attention}
									</>
								)}
								<Dialog
									open={section !== null}
									onOpenChange={(open) => {
										if (!open) setSection(null);
									}}
								>
									<DialogContent
										id={dialogId}
										className="conversation-options-dialog"
										scrollBody
										data-section={section}
										closeLabel={l["capabilities.close"]}
										aria-describedby={undefined}
										onSubmit={(event) => event.stopPropagation()}
										onCloseAutoFocus={(event) => {
											if (returnFocus.current?.isConnected) {
												event.preventDefault();
												returnFocus.current.focus();
											}
										}}
									>
										<DialogTitle>
											{l[section === "tool-packs" ? "capabilities.tools" : "capabilities.files"]}
										</DialogTitle>
										<DialogBody>
											{attention}
											{section === "tool-packs" ? toolPacks : permissions}
										</DialogBody>
									</DialogContent>
								</Dialog>
							</>
						);
					}}
				</ToolPacksPanel>
			)}
		</AgentPermissionManagement>
	);
}
