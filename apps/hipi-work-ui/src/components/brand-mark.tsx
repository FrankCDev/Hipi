/** Decorative product mark. The containing link/button supplies its accessible name. */
export function BrandMark({ className, size = 24 }: { className?: string; size?: number }) {
	return (
		<svg aria-hidden="true" focusable="false" className={className} width={size} height={size} viewBox="0 0 256 256">
			<rect x="16" y="16" width="224" height="224" rx="52" fill="var(--brand)" />
			<g fill="var(--on-brand)">
				<path d="M64 64h32v48h44l-32 32H96v48H64Z" />
				<path d="M160 64h32v128h-32v-48h-44l32-32h12Z" />
			</g>
		</svg>
	);
}
