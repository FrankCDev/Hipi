/** Recorded creation age only; the catalog does not currently expose last activity. */
export function conversationAge(createdAt: number | null, now: number, locale: string) {
	if (createdAt === null || !Number.isFinite(createdAt) || !Number.isFinite(new Date(createdAt).getTime())) return null;
	if (createdAt > now) return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(createdAt);
	const seconds = Math.max(0, Math.floor((now - createdAt) / 1000));
	const units = [
		["year", 31_536_000],
		["month", 2_592_000],
		["day", 86_400],
		["hour", 3_600],
		["minute", 60],
	] as const;
	const [unit, size] = units.find(([, size]) => seconds >= size) ?? ["second", 1];
	return new Intl.RelativeTimeFormat(locale, { style: "narrow", numeric: seconds < 60 ? "auto" : "always" }).format(
		seconds < 60 ? 0 : -Math.floor(seconds / size),
		unit,
	);
}

/** A continuation means a lower bound, never a fabricated total. */
export function projectConversationCount(count: number, hasMore: boolean, locale: string) {
	const number = new Intl.NumberFormat(locale).format(count);
	if (locale === "en") return `${hasMore ? "At least " : ""}${number} ${count === 1 ? "chat" : "chats"}`;
	return `${hasMore ? "至少 " : ""}${number} 个聊天`;
}
