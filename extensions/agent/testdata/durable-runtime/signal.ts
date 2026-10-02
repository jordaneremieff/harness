/** Explicit marker frames for child-process fixtures. Files are not readiness signals. */
import { createConnection } from "node:net";

/** Publish one marker name. The receiver closes the socket after it reads the frame. */
export function publishFixtureMarker(socketPath: string, name: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		socket.once("error", reject);
		socket.once("connect", () => socket.end(`${name}\n`));
		socket.once("close", () => resolve());
	});
}
