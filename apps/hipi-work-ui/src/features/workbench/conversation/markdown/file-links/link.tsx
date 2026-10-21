import { File } from "lucide-react";
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../../../../app/preferences.tsx";
import { ActionTooltip } from "../../../../../components/ui/action-tooltip.tsx";
import { useProjectFileLinks } from "./provider.tsx";
import "./link.css";

export function ProjectFileLink({ path, title, children }: { path: string; title?: string; children: ReactNode }) {
	const capability = useProjectFileLinks();
	const { locale } = usePreferences();
	const [failure, setFailure] = useState(false);
	const [pending, setPending] = useState(false);
	const request = useRef<AbortController | null>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: Destination and authority changes retire the in-flight gesture.
	useLayoutEffect(() => {
		setFailure(false);
		setPending(false);
		return () => {
			request.current?.abort();
			request.current = null;
		};
	}, [path, capability]);
	if (!capability) return <span title={title}>{children}</span>;
	const activate = (event: MouseEvent<HTMLButtonElement>) => {
		event.preventDefault();
		if (!event.nativeEvent.isTrusted || event.button !== 0 || request.current) return;
		const controller = new AbortController();
		request.current = controller;
		setPending(true);
		setFailure(false);
		void capability
			.open(path, controller.signal)
			.catch(() => {
				if (!controller.signal.aborted) setFailure(true);
			})
			.finally(() => {
				if (request.current === controller) {
					request.current = null;
					setPending(false);
				}
			});
	};
	return (
		<>
			<ActionTooltip label={title ?? path}>
				<button type="button" className="markdown-file-link" aria-busy={pending || undefined} onClick={activate}>
					<span className="markdown-file-link-icon" aria-hidden="true" data-markdown-copy="exclude">
						<File />
					</span>
					<span className="markdown-file-link-label">{children}</span>
				</button>
			</ActionTooltip>
			{failure && (
				<span role="alert" className="external-link-error" data-markdown-copy="exclude">
					{locale.startsWith("zh")
						? "无法打开项目文件，请检查文件是否存在及文件夹访问权限。"
						: "Could not open the project file. Check that it exists and that folder access is available."}
				</span>
			)}
		</>
	);
}
