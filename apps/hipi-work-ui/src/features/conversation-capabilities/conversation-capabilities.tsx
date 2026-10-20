import type { Conversation, ModelReference } from "@hipi/work-runtime/contracts";
import { Blocks, ChevronRight, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogTitle,
	DialogTrigger,
} from "../../components/ui/dialog.tsx";
import { AgentPermissionManagement } from "../agent-permissions/agent-permissions.tsx";
import { ToolPacksPanel } from "../tool-packs/index.ts";
import { capabilityLabels } from "./labels.ts";

type CapabilitySection = "files" | "tool-packs";

/** A single conversation entry; the two live management owners never live inside a dismissible portal. */
export function ConversationCapabilities({
	conversation,
	model,
	connected,
}: {
	conversation: Conversation;
	model?: ModelReference;
	connected: boolean;
}) {
	const { locale } = usePreferences();
	const l = capabilityLabels(locale);
	const [open, setOpen] = useState(false);
	const [section, setSection] = useState<CapabilitySection>("files");
	const sectionId = useId();
	const showFiles = () => {
		setSection("files");
		setOpen(true);
	};
	return (
		<AgentPermissionManagement
			scope={conversation}
			model={model}
			connected={connected}
			archived={conversation.archivedAt !== null}
			detailsOpen={open && section === "files"}
			onOpenDetails={showFiles}
		>
			{({ content: permissions, attention }) => (
				<ToolPacksPanel
					workspaceId={conversation.workspaceId}
					conversation={conversation}
					active={open && section === "tool-packs"}
				>
					{(toolPacks) => (
						<section className="permission-controls capabilities-controls" aria-label={l["capabilities.title"]}>
							<Dialog open={open} onOpenChange={setOpen}>
								<DialogTrigger asChild>
									<Button
										variant="ghost"
										size="sm"
										className="capabilities-trigger"
										aria-label={l["capabilities.title"]}
									>
										<SlidersHorizontal size={15} aria-hidden="true" />
										{l["capabilities.trigger"]}
									</Button>
								</DialogTrigger>
								<DialogContent
									placement="right"
									className="capabilities-dialog"
									closeLabel={l["capabilities.close"]}
									onSubmit={(event) => event.stopPropagation()}
								>
									<div className="capabilities-heading">
										<DialogTitle>{l["capabilities.title"]}</DialogTitle>
										<DialogDescription>{l["capabilities.description"]}</DialogDescription>
									</div>
									<div className="capabilities-summary">
										<span>{l["capabilities.scope"]}</span>
										<strong>{conversation.title}</strong>
									</div>
									{attention}
									<div className="capabilities-layout">
										<nav className="capabilities-navigation" aria-label={l["capabilities.navigation"]}>
											<Button
												variant="ghost"
												data-section="files"
												aria-current={section === "files" ? "page" : undefined}
												aria-controls={sectionId}
												onClick={() => setSection("files")}
											>
												<ShieldCheck size={18} aria-hidden="true" />
												<span>{l["capabilities.files"]}</span>
												<ChevronRight size={14} aria-hidden="true" />
											</Button>
											<Button
												variant="ghost"
												data-section="tool-packs"
												aria-current={section === "tool-packs" ? "page" : undefined}
												aria-controls={sectionId}
												onClick={() => setSection("tool-packs")}
											>
												<Blocks size={18} aria-hidden="true" />
												<span>{l["capabilities.tools"]}</span>
												<ChevronRight size={14} aria-hidden="true" />
											</Button>
										</nav>
										<DialogBody className="capabilities-content">
											<section
												id={sectionId}
												className="capabilities-section"
												data-section={section}
												aria-labelledby={`${sectionId}-heading`}
											>
												<div className="capabilities-section-heading">
													<h3 id={`${sectionId}-heading`}>
														{l[section === "files" ? "capabilities.files" : "capabilities.tools"]}
													</h3>
													<p>
														{l[section === "files" ? "capabilities.filesDescription" : "capabilities.toolsDescription"]}
													</p>
												</div>
												{section === "files" ? permissions : toolPacks}
											</section>
										</DialogBody>
									</div>
								</DialogContent>
							</Dialog>
							{!open && attention}
						</section>
					)}
				</ToolPacksPanel>
			)}
		</AgentPermissionManagement>
	);
}
