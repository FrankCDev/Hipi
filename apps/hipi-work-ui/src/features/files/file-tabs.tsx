import { Ellipsis, FileText, X } from "lucide-react";
import { useRef } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.tsx";
import { fileLabels } from "./file-labels.ts";
import { FileTabContextMenu, fileTabCloseTargets } from "./file-tab-menu.tsx";
import type { FileWorkspaceSession, WorkspaceFileTab } from "./file-workspace-session.ts";

export function FileTabs({
	tabs,
	activeId,
	session,
	close,
	closing,
}: {
	tabs: readonly WorkspaceFileTab[];
	activeId?: string;
	session: FileWorkspaceSession;
	close: (ids: string[]) => void;
	closing: boolean;
}) {
	const { locale } = usePreferences();
	const l = fileLabels(locale);
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	return (
		<div className="file-tabs-header">
			<div className="file-tabs" role="tablist" aria-label={l["tabs.title"]}>
				{tabs.map((tab, index) => {
					const active = tab.id === activeId;
					const state = tab.kind === "editor" ? tab.editor.snapshot() : undefined;
					return (
						<FileTabContextMenu key={tab.id} id={tab.id} session={session} close={close} closing={closing}>
							<div className="file-tab" data-active={active} data-preview={!tab.pinned} role="presentation">
								<button
									type="button"
									ref={(element) => {
										if (element) buttons.current.set(tab.id, element);
										else buttons.current.delete(tab.id);
									}}
									className="file-tab-select"
									id={`file-tab-${tab.id}`}
									role="tab"
									aria-selected={active}
									aria-controls={`file-tab-content-${tab.id}`}
									tabIndex={active ? 0 : -1}
									title={tab.target.path}
									draggable
									onDragStart={(event) => {
										event.dataTransfer.effectAllowed = "move";
										event.dataTransfer.setData("application/x-hipi-file-tab", tab.id);
									}}
									onDragOver={(event) => {
										if (event.dataTransfer.types.includes("application/x-hipi-file-tab")) event.preventDefault();
									}}
									onDrop={(event) => {
										event.preventDefault();
										session.move(event.dataTransfer.getData("application/x-hipi-file-tab"), tab.id);
									}}
									onClick={() => session.select(tab.id)}
									onDoubleClick={() => session.pin(tab.id)}
									onAuxClick={(event) => {
										if (event.button === 1) {
											event.preventDefault();
											close([tab.id]);
										}
									}}
									onKeyDown={(event) => {
										const next = {
											ArrowLeft: (index + tabs.length - 1) % tabs.length,
											ArrowRight: (index + 1) % tabs.length,
											Home: 0,
											End: tabs.length - 1,
										}[event.key];
										const target = next === undefined ? undefined : tabs[next];
										if (!target) return;
										event.preventDefault();
										session.select(target.id);
										buttons.current.get(target.id)?.focus({ preventScroll: true });
										buttons.current.get(target.id)?.scrollIntoView({ block: "nearest", inline: "nearest" });
									}}
								>
									<FileText size={14} aria-hidden />
									<span className="file-tab-name">{tab.target.path.split("/").at(-1)}</span>
									{state?.document && state.document.text !== state.document.baseline.text && (
										<span className="file-tab-dirty" title={l.dirty}>
											<span className="sr-only">{l.dirty}</span>
										</span>
									)}
									{state?.error && (
										<span className="file-tab-error">
											<span aria-hidden>!</span>
											<span className="sr-only">{l["state.failed"]}</span>
										</span>
									)}
								</button>
								<Button
									size="icon-xs"
									variant="ghost"
									className="file-tab-close"
									aria-label={`${l["tabs.close"]}: ${tab.target.path}`}
									title={l["tabs.close"]}
									disabled={closing}
									onClick={() => close([tab.id])}
								>
									<X size={14} aria-hidden />
								</Button>
							</div>
						</FileTabContextMenu>
					);
				})}
			</div>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button size="icon-sm" variant="ghost" aria-label={l["tabs.actions"]} title={l["tabs.actions"]}>
						<Ellipsis size={16} aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem disabled={!activeId || closing} onSelect={() => activeId && close([activeId])}>
						{l["tabs.close"]}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={tabs.length < 2 || closing}
						onSelect={() => activeId && close(fileTabCloseTargets(session, activeId, "others"))}
					>
						{l["tabs.closeOthers"]}
					</DropdownMenuItem>
					<DropdownMenuItem
						disabled={tabs.at(-1)?.id === activeId || closing}
						onSelect={() => activeId && close(fileTabCloseTargets(session, activeId, "right"))}
					>
						{l["tabs.closeRight"]}
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
