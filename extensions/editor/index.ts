import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { fileURLToPath } from "node:url";
import { registerOrdinary } from "./ordinary.ts";
import { contribution } from "./durable.ts";

export default function editor(pi: ExtensionAPI) {
	registerOrdinary(pi);
	pi.events.emit("durable:contribution", contribution(fileURLToPath(import.meta.url)));
}
