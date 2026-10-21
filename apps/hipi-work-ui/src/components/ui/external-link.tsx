import { externalLinkUrl } from "@hipi/work-runtime/external-links";
import { type MouseEvent, type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { useExternalLinks } from "../../app/external-link-provider.tsx";
import { usePreferences } from "../../app/preferences.tsx";
import "./external-link.css";

export function ExternalLink({ href, title, children }: { href?: string; title?: string; children: ReactNode }) {
	const client = useExternalLinks();
	const { locale } = usePreferences();
	const [failure, setFailure] = useState(false);
	const busy = useRef(false);
	const url = externalLinkUrl(href);
	const generation = useRef({ url, client });
	useLayoutEffect(() => {
		generation.current = { url, client };
		busy.current = false;
		setFailure(false);
		return () => {
			generation.current = { url, client };
			busy.current = false;
		};
	}, [url, client]);
	if (!url || !client?.supported) return <span title={title}>{children}</span>;
	const activate = (event: MouseEvent<HTMLAnchorElement>) => {
		event.preventDefault();
		// This prevents accidental synthetic UI activation, not a compromised renderer's IPC access.
		if (!event.nativeEvent.isTrusted || ![0, 1].includes(event.button) || busy.current) return;
		busy.current = true;
		const activation = generation.current;
		setFailure(false);
		void client
			.open(url)
			.then(
				(result) => {
					if (activation === generation.current) setFailure(result !== "opened");
				},
				() => {
					if (activation === generation.current) setFailure(true);
				},
			)
			.finally(() => {
				if (activation === generation.current) busy.current = false;
			});
	};
	return (
		<>
			<a
				className="external-link"
				href={url}
				title={title}
				target="_blank"
				rel="noopener noreferrer"
				onClick={activate}
				onAuxClick={activate}
			>
				{children}
			</a>
			{failure && (
				<span className="external-link-error" role="alert" data-markdown-copy="exclude">
					{locale === "zh-CN"
						? "无法确认链接已打开，请检查浏览器。"
						: "Opening could not be confirmed. Check your browser."}
				</span>
			)}
		</>
	);
}
