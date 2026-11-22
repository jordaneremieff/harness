import { arr, int, obj, str, type Static } from "@earendil-works/pi-schema";
export const InterruptSelection = obj(
	{
		taskId: int({ minimum: 1 }),
		queuedInputs: arr(int({ minimum: 1 }), { minItems: 1, maxItems: 200, uniqueItems: true }),
		intentId: str({ minLength: 1, maxLength: 256 }),
	},
	{},
);
export type Selection = Static<typeof InterruptSelection>;
export function interruptConflict(input: {
	interrupt?: Selection;
	timerId?: number;
	release?: boolean;
	background?: boolean;
}): boolean {
	return !!input.interrupt && (!!input.release || !!input.background || input.timerId !== undefined);
}
