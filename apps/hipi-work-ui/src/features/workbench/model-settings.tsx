import type { CredentialState } from "@hipi/work-runtime/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useCredentialClient } from "../../app/client-provider.tsx";
import type { CredentialRequest } from "../../app/credential-client.ts";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../../components/ui/dialog.tsx";
import { Input } from "../../components/ui/input.tsx";

export function ModelSettings() {
	const { t } = usePreferences();
	const credentials = useCredentialClient();
	const cache = useQueryClient();
	const [open, setOpen] = useState(false);
	const [secret, setSecret] = useState("");
	const [state, setState] = useState<CredentialState>();
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<"saved" | "actionFailed" | null>(null);
	const active = useRef(true);
	const gate = useRef(false);
	const inputId = useId();
	useEffect(() => {
		active.current = true;
		return () => {
			active.current = false;
		};
	}, []);
	const run = async (input: CredentialRequest) => {
		if (!credentials || gate.current) return;
		gate.current = true;
		setBusy(true);
		if (input.operation !== "status") setOutcome(null);
		setSecret("");
		try {
			const next = await credentials.request(input);
			if (active.current) {
				setState(next);
				if (input.operation !== "status") setOutcome("saved");
			}
			await Promise.all([
				cache.invalidateQueries({ queryKey: ["models"] }),
				cache.invalidateQueries({ queryKey: ["conversation-model"] }),
			]);
		} catch {
			if (active.current) {
				setState(undefined);
				setOutcome("actionFailed");
			}
		} finally {
			gate.current = false;
			if (active.current) setBusy(false);
		}
	};
	return (
		<Dialog
			open={open}
			onOpenChange={(value) => {
				if (!busy) {
					setSecret("");
					setOutcome(null);
					setOpen(value);
					if (value) void run({ operation: "status", provider: "openai" });
				}
			}}
		>
			<DialogTrigger asChild>
				<Button variant="ghost" size="sm">
					{t("model.settings")}
				</Button>
			</DialogTrigger>
			<DialogContent closeLabel={t("common.close")} closeDisabled={busy}>
				<DialogTitle>{t("model.settings")}</DialogTitle>
				<DialogDescription>
					{t(credentials?.storage === "memory" ? "model.memoryNote" : "model.secretNote")}
				</DialogDescription>
				{!credentials ? (
					<p>{t("model.noPort")}</p>
				) : (
					<form
						className="grid gap-4"
						onSubmit={(event) => {
							event.preventDefault();
							if (secret && !busy && (state === "missing" || state === "configured"))
								void run({ operation: "set", provider: "openai", secret });
						}}
					>
						<output>{busy ? t("common.loading") : state ? t(`model.${state}`) : t("receipt.unconfirmed")}</output>
						<label className="field" htmlFor={inputId}>
							{t("model.key")}
							<Input
								id={inputId}
								type="password"
								autoComplete="off"
								spellCheck={false}
								maxLength={4096}
								value={secret}
								disabled={busy}
								onChange={(event) => setSecret(event.target.value)}
							/>
						</label>
						{outcome && <output>{t(`model.${outcome}`)}</output>}
						<p className="text-sm text-muted-foreground">{t("model.removeNote")}</p>
						<div className="flex flex-wrap gap-2">
							<Button type="submit" disabled={!secret || busy || (state !== "missing" && state !== "configured")}>
								{t("model.save")}
							</Button>
							<Button
								type="button"
								variant="outline"
								disabled={busy || state !== "configured"}
								onClick={() => void run({ operation: "remove", provider: "openai" })}
							>
								{t("model.remove")}
							</Button>
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								onClick={() => void run({ operation: "status", provider: "openai" })}
							>
								{t("model.refresh")}
							</Button>
						</div>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
