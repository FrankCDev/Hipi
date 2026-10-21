import type { Scope } from "@hipi/work-runtime/contracts";
import { usePageInView } from "framer-motion";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useAppClient } from "../../app/client-provider.tsx";
import { MessageProjection, selectionIntersects } from "../workbench/conversation/message-projection.ts";
import { ActivitySession, type ActivityState } from "./activity-session.ts";
import type { LiveActivityRead } from "./live-activity.ts";

type MessageActivityRead = {
	messageId: string;
	session: ActivitySession;
	state: ActivityState;
	live?: LiveActivityRead;
	connected: boolean;
	lease: (windowed?: boolean) => () => void;
};
const MessageActivityContext = createContext<MessageActivityRead | null>(null);
export function useMessageActivityOwner() {
	return useContext(MessageActivityContext);
}

/** A message, not its interleaved slices, owns the bounded metadata/output readers. */
export function MessageActivityOwner({
	scope,
	connected,
	messageId,
	children,
	live,
}: {
	scope: Scope;
	connected: boolean;
	messageId: string;
	children: ReactNode;
	live?: LiveActivityRead;
}) {
	const client = useAppClient();
	const visible = usePageInView();
	const root = useRef<HTMLDivElement>(null);
	const session = useMemo(
		() =>
			new ActivitySession(
				client,
				{ workspaceId: scope.workspaceId, conversationId: scope.conversationId },
				{ kind: "message", messageId },
			),
		[client, scope.workspaceId, scope.conversationId, messageId],
	);
	const state = useSyncExternalStore(session.subscribe, session.snapshot, session.snapshot);
	const [consumers, setConsumers] = useState(0);
	const [windowConsumers, setWindowConsumers] = useState(0);
	const lease = useCallback((windowed = false) => {
		setConsumers((count) => count + 1);
		if (windowed) setWindowConsumers((count) => count + 1);
		return () => {
			setConsumers((count) => count - 1);
			if (windowed) setWindowConsumers((count) => count - 1);
		};
	}, []);
	const liveSession = live?.session;
	const outputs = useMemo(
		() => ({ historical: state.outputs, live: live?.state.outputs }),
		[state.outputs, live?.state.outputs],
	);
	const [display, setDisplay] = useState({ session, liveSession, outputs });
	const projection = useMemo(
		() =>
			new MessageProjection<typeof outputs>(
				{ historical: undefined, live: undefined },
				(outputs) => setDisplay({ session, liveSession, outputs }),
				() =>
					selectionIntersects(root.current?.closest(".conversation-panel") ?? root.current, document.getSelection()),
			),
		[session, liveSession],
	);
	useEffect(() => {
		projection.update(outputs, false);
	}, [projection, outputs]);
	useEffect(() => {
		const flush = () => projection.flush();
		document.addEventListener("selectionchange", flush);
		return () => {
			document.removeEventListener("selectionchange", flush);
			projection.dispose();
		};
	}, [projection]);
	useEffect(() => {
		session.activate();
		return () => session.dispose();
	}, [session]);
	const enabled = connected && visible && consumers > 0;
	useEffect(() => {
		if (!enabled) {
			session.cancel();
			return;
		}
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const refresh = async () => {
			const selected = selectionIntersects(
				root.current?.closest(".conversation-panel") ?? root.current,
				document.getSelection(),
			);
			if (!selected && !session.snapshot().failed) {
				if (windowConsumers > 0) await session.windowPage(0);
				else await session.inlinePage();
			}
			if (!stopped && selected) timer = setTimeout(() => void refresh(), 2000);
		};
		void refresh();
		return () => {
			stopped = true;
			clearTimeout(timer);
			session.cancel();
		};
	}, [session, enabled, windowConsumers]);
	return (
		<MessageActivityContext.Provider
			value={{
				messageId,
				session,
				state: { ...state, outputs: display.session === session ? display.outputs.historical : undefined },
				live: live
					? {
							...live,
							state: { ...live.state, outputs: display.liveSession === liveSession ? display.outputs.live : undefined },
						}
					: undefined,
				connected: connected && visible,
				lease,
			}}
		>
			<div ref={root} className="message-activity-owner">
				{children}
			</div>
		</MessageActivityContext.Provider>
	);
}
