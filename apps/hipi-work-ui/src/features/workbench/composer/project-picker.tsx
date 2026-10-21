import type { Project, ProjectListItem } from "@hipi/work-runtime/contracts";
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
import { catalogLabels } from "../catalog/labels.ts";
import { workbenchLabels } from "../workbench-labels.ts";

type ProjectChoices = {
	items: readonly ProjectListItem[];
	hasMore: boolean;
	canRestart: boolean;
	isFetching: boolean;
	isError: boolean;
	loadMore: () => Promise<void>;
	retry: () => Promise<void>;
	restart: () => Promise<void>;
};

/** Changes the next Send destination through the navigation owner; never creates work or grants file access. */
export function HomeProjectPicker({
	current,
	pages,
	disabled,
	allowProjectless,
	onSelect,
}: {
	current: Project;
	pages: ProjectChoices;
	disabled: boolean;
	allowProjectless: boolean;
	onSelect: (project: Project | null) => void;
}) {
	const { locale, t } = usePreferences();
	const labels = workbenchLabels(locale);
	const catalog = catalogLabels(locale);
	const choices = pages.items.some(({ project }) => project.projectId === current.projectId)
		? pages.items.map(({ project }) => project)
		: [current, ...pages.items.map(({ project }) => project)];
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button type="button" disabled={disabled} aria-label={`${labels["workbench.chooseProject"]}: ${current.name}`}>
					{current.name}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent className="home-project-menu" align="center" aria-label={labels["workbench.chooseProject"]}>
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
							textValue={project.name}
							disabled={disabled}
						>
							<span className="home-project-name">{project.name}</span>
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
				{(pages.isError || pages.hasMore || pages.canRestart) && <DropdownMenuSeparator />}
				{pages.isError && (
					<DropdownMenuItem
						disabled={pages.isFetching}
						onSelect={(event) => {
							event.preventDefault();
							void pages.retry();
						}}
					>
						{t("nav.refresh")}
					</DropdownMenuItem>
				)}
				{pages.hasMore && (
					<DropdownMenuItem
						disabled={pages.isFetching || pages.isError}
						onSelect={(event) => {
							event.preventDefault();
							void pages.loadMore();
						}}
					>
						{pages.isFetching ? catalog.loadingMore : catalog.loadMore}
					</DropdownMenuItem>
				)}
				{pages.canRestart && (
					<DropdownMenuItem
						disabled={pages.isFetching}
						onSelect={(event) => {
							event.preventDefault();
							void pages.restart();
						}}
					>
						{catalog.first}
					</DropdownMenuItem>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
