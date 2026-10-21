import { Checkbox } from "radix-ui";
import { Icon } from "./icon.tsx";
import "./read-only-checkbox.css";

/** A status indicator, never an editable task or form control. */
export function ReadOnlyCheckbox({ checked, label }: { checked: boolean; label: string }) {
	return (
		<Checkbox.Root className="ui-read-only-checkbox" checked={checked} disabled tabIndex={-1} aria-label={label}>
			<Checkbox.Indicator className="ui-read-only-checkbox-indicator">
				<Icon name="check" size={12} />
			</Checkbox.Indicator>
		</Checkbox.Root>
	);
}
