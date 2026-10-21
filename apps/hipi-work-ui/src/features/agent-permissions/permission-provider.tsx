import type { Scope } from "@hipi/work-runtime/contracts";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useAppClient, useLocalState } from "../../app/client-provider.tsx";
import { PermissionSession, type PermissionState } from "./permission-session.ts";

type PermissionOwner = {
	scope: Scope;
	session: PermissionSession;
	state: PermissionState;
	now: number;
	setNow: (now: number) => void;
	connected: boolean;
	archived: boolean;
	visible: boolean;
};
const PermissionContext = createContext<PermissionOwner | null>(null);
export function usePermissionOwner() {
	return useContext(PermissionContext);
}

/** One scoped owner survives transcript virtualization and management dialog dismissal. */
export function PermissionProvider({
	scope,
	connected,
	archived = false,
	children,
}: {
	scope: Scope;
	connected: boolean;
	archived?: boolean;
	children: ReactNode;
}) {
	const client = useAppClient();
	const local = useLocalState();
	const session = useMemo(
		() =>
			new PermissionSession(client, { workspaceId: scope.workspaceId, conversationId: scope.conversationId }, local),
		[client, local, scope.workspaceId, scope.conversationId],
	);
	const state = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
	const [now, setNow] = useState(Date.now);
	const [visible, setVisible] = useState(
		() => typeof document === "undefined" || document.visibilityState !== "hidden",
	);
	useEffect(() => {
		const update = () => setVisible(document.visibilityState !== "hidden");
		document.addEventListener("visibilitychange", update);
		return () => document.removeEventListener("visibilitychange", update);
	}, []);
	useEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
	useEffect(() => {
		if (!connected || !visible || state.failed) {
			session.cancel();
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			await session.refresh();
			if (stopped) return;
			setNow(Date.now());
			if (!session.getSnapshot().failed) timer = setTimeout(() => void poll(), 2000);
		};
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
			session.cancel();
		};
	}, [session, connected, visible, state.failed]);
	return (
		<PermissionContext.Provider value={{ scope, session, state, now, setNow, connected, archived, visible }}>
			{children}
		</PermissionContext.Provider>
	);
}
