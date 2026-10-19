/** Selection and its destination UI commit together, after any dirty-editor decision. */
export function navigateConversation({
	changesWorkspace,
	guard,
	select,
	onSelected,
}: {
	changesWorkspace: boolean;
	guard: (action: () => void) => void;
	select: () => void;
	onSelected?: () => void;
}) {
	const navigate = () => {
		select();
		onSelected?.();
	};
	if (changesWorkspace) guard(navigate);
	else navigate();
}
