import type { Project, ProjectListItem, ProjectPage } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useAppClient } from "../../../app/client-provider.tsx";
import { usePreferences } from "../../../app/preferences.tsx";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "../../../components/ui/dropdown-menu.tsx";
import { CatalogPagination } from "../catalog/pagination.tsx";
import { useCatalogPages } from "../catalog/use-pages.ts";
import { workbenchLabels } from "../workbench-labels.ts";

/** Changes the next Send destination through the navigation owner; never creates work or grants file access. */
export function HomeProjectPicker({
	current,
	disabled,
	allowProjectless,
	onSelect,
}: {
	current: Project;
	disabled: boolean;
	allowProjectless: boolean;
	onSelect: (project: Project | null) => void;
}) {
	const { locale, t } = usePreferences();
	const client = useAppClient();
	const cache = useQueryClient();
	const [open, setOpen] = useState(false);
	const openRef = useRef(open);
	openRef.current = open;
	const pages = useCatalogPages<ProjectListItem, ProjectPage>({
		queryKey: ["projects", "picker"],
		queryPage: (cursor, signal) => client.call("listProjects", cursor ? { cursor } : {}, signal),
		itemKey: ({ project }) => project.projectId,
		enabled: open && !disabled,
		gcTime: 0,
	});
	const labels = workbenchLabels(locale);
	const region = useRef<HTMLDivElement>(null);
	const choices = pages.items.some(({ project }) => project.projectId === current.projectId)
		? pages.items.map(({ project }) => project)
		: [current, ...pages.items.map(({ project }) => project)];
	return (
		<DropdownMenu
			open={open}
			onOpenChange={(next) => {
				openRef.current = next;
				setOpen(next);
				if (!next)
					void cache.cancelQueries({ queryKey: ["projects", "picker", "pages"], exact: true }).then(() => {
						if (!openRef.current) cache.removeQueries({ queryKey: ["projects", "picker", "pages"], exact: true });
					});
			}}
		>
			<DropdownMenuTrigger asChild>
				<button type="button" disabled={disabled} aria-label={`${labels["workbench.chooseProject"]}: ${current.name}`}>
					{current.name}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent
				ref={region}
				className="home-project-menu"
				align="center"
				aria-label={labels["workbench.chooseProject"]}
			>
				<DropdownMenuRadioGroup
					value={current.projectId}
					onValueChange={(id) => {
						if (disabled || id === current.projectId) return;
						if (id === "" && allowProjectless) onSelect(null);
						else {
							const project = choices.find((item) => item.projectId === id);
							if (project) onSelect(project);
						}
					}}
				>
					{allowProjectless && (
						<DropdownMenuRadioItem value="" disabled={disabled}>
							{labels["workbench.noProject"]}
						</DropdownMenuRadioItem>
					)}
					{choices.map((project) => (
						<DropdownMenuRadioItem
							key={project.projectId}
							value={project.projectId}
							data-catalog-key={project.projectId}
							textValue={project.name}
							disabled={disabled}
						>
							<span className="home-project-name">{project.name}</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				{pages.isError && <DropdownMenuSeparator />}
				{pages.isError && (
					<DropdownMenuItem
						disabled={pages.isFetching}
						onSelect={(event) => {
							event.preventDefault();
							void pages.retry();
						}}
					>
						{t("history.retry")}
					</DropdownMenuItem>
				)}
				<CatalogPagination pages={pages} listRef={region} />
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
