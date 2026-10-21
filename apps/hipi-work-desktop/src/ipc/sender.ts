/** Object identity matters: a same-URL frame/window is not the owned application renderer. */
export function trustedSender(
	event: { sender: unknown; senderFrame: unknown },
	owner: { mainFrame: { url: string } },
	page: string,
): boolean {
	return event.sender === owner && event.senderFrame === owner.mainFrame && owner.mainFrame.url === page;
}
