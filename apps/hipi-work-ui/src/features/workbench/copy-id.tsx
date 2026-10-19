import { useState } from "react";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";

export function CopyId({ value, testId }: { value: string; testId: string }) {
	const { t } = usePreferences();
	const [result, setResult] = useState<"idle" | "copied" | "failed">("idle");
	return (
		<dd className="grid gap-1">
			<span className="identifier select-all" data-testid={testId}>
				{value}
			</span>
			<Button
				variant="ghost"
				size="sm"
				className="justify-self-start"
				onClick={() => {
					if (!navigator.clipboard) {
						setResult("failed");
						return;
					}
					void navigator.clipboard.writeText(value).then(
						() => setResult("copied"),
						() => setResult("failed"),
					);
				}}
			>
				{t(result === "copied" ? "common.copied" : "common.copy")}
			</Button>
			{result === "failed" && (
				<p className="small-copy" role="alert">
					{t("common.copyFailed")}
				</p>
			)}
		</dd>
	);
}
