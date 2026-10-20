import type { CredentialState } from "@hipi/work-runtime/contracts";
import { credentialSecret } from "@hipi/work-runtime/credentials";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useCredentialClient } from "../../app/client-provider.tsx";
import type { CredentialRequest } from "../../app/credential-client.ts";
import { usePreferences } from "../../app/preferences.tsx";
import { Button } from "../../components/ui/button.tsx";
import { Input } from "../../components/ui/input.tsx";
import { legacyProviderLabels } from "./legacy-provider-labels.ts";
import "./custom-provider-settings.css";

type Lifetime = { active: boolean; busy: boolean };
type Outcome = "saved" | "removed" | "invalid" | "unknown" | "statusUnknown";

/** Official provider credentials only. No editable endpoint, model configuration, or secret-bearing cache. */
export function LegacyProviderEditor({ onBusy }: { onBusy: (busy: boolean) => void }) {
	const credentials = useCredentialClient();
	const cache = useQueryClient();
	const { locale } = usePreferences();
	const l = legacyProviderLabels(locale);
	const [secret, setSecret] = useState("");
	const [state, setState] = useState<CredentialState>();
	const [busy, setBusy] = useState(false);
	const [outcome, setOutcome] = useState<Outcome>();
	const lifetime = useRef<Lifetime>({ active: false, busy: false });
	const busyCallback = useRef(onBusy);
	const inputId = useId();
	useEffect(() => {
		busyCallback.current = onBusy;
	}, [onBusy]);
	const run = useCallback(
		async (input: CredentialRequest, owner = lifetime.current) => {
			if (!credentials || !owner.active || owner.busy) return;
			owner.busy = true;
			setBusy(true);
			busyCallback.current(true);
			setOutcome(undefined);
			if (input.operation !== "status") setSecret("");
			let dispatched = false;
			try {
				if (input.operation === "set") credentialSecret(input.secret);
				dispatched = true;
				const next = await credentials.request(input);
				if (!owner.active || lifetime.current !== owner) return;
				setState(next);
				if (input.operation === "status")
					setOutcome(next === "missing" || next === "configured" ? undefined : "statusUnknown");
				else
					setOutcome(
						input.operation === "set" && next === "configured"
							? "saved"
							: input.operation === "remove" && next === "missing"
								? "removed"
								: "unknown",
					);
			} catch {
				if (!owner.active || lifetime.current !== owner) return;
				if (dispatched) setState(undefined);
				setOutcome(dispatched ? (input.operation === "status" ? "statusUnknown" : "unknown") : "invalid");
			} finally {
				if (dispatched && input.operation !== "status")
					await Promise.all([
						cache.invalidateQueries({ queryKey: ["models"] }),
						cache.invalidateQueries({ queryKey: ["conversation-model"] }),
					]).catch(() => undefined);
				owner.busy = false;
				if (owner.active && lifetime.current === owner) {
					setBusy(false);
					busyCallback.current(false);
				}
			}
		},
		[credentials, cache],
	);
	useEffect(() => {
		const owner: Lifetime = { active: true, busy: false };
		lifetime.current = owner;
		setSecret("");
		setState(undefined);
		setOutcome(undefined);
		if (credentials) void run({ operation: "status", provider: "openai" }, owner);
		return () => {
			owner.active = false;
		};
	}, [credentials, run]);
	const writable = state === "missing" || state === "configured";
	const uncertain = outcome === "unknown" || outcome === "statusUnknown";
	return (
		<form
			className="custom-provider-form"
			onSubmit={(event) => {
				event.preventDefault();
				if (secret && writable && !uncertain) void run({ operation: "set", provider: "openai", secret });
			}}
		>
			<p className="custom-provider-hint">{l.service}</p>
			{!credentials ? (
				<p className="custom-provider-hint">{l.noPort}</p>
			) : (
				<>
					<output aria-live="polite">{state ? l[state] : busy ? l.loading : l.statusUnknown}</output>
					<label className="field" htmlFor={inputId}>
						{l.key}
						<Input
							id={inputId}
							type="password"
							value={secret}
							onChange={(event) => setSecret(event.target.value)}
							placeholder={l.placeholder}
							maxLength={4096}
							autoComplete="off"
							spellCheck={false}
							disabled={busy || !writable || uncertain}
						/>
					</label>
					<p className="custom-provider-hint">{l[credentials.storage]}</p>
					{outcome && (
						<output
							role={outcome === "saved" || outcome === "removed" ? "status" : "alert"}
							className="custom-provider-feedback"
						>
							{l[outcome]}
						</output>
					)}
					<div className="custom-provider-actions">
						<Button type="submit" disabled={!secret || busy || !writable || uncertain}>
							{l.save}
						</Button>
						{state === "configured" && (
							<Button
								type="button"
								variant="outline"
								disabled={busy || uncertain}
								onClick={() => void run({ operation: "remove", provider: "openai" })}
							>
								{l.remove}
							</Button>
						)}
						{uncertain && (
							<Button
								type="button"
								variant="ghost"
								disabled={busy}
								onClick={() => void run({ operation: "status", provider: "openai" })}
							>
								{l.refresh}
							</Button>
						)}
					</div>
				</>
			)}
		</form>
	);
}
