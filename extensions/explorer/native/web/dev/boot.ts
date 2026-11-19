(() => {
	const handler = {
		async postMessage(packet: unknown) {
			const response = await fetch("/bridge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(packet),
			});
			return response.json();
		},
	};
	Object.assign(window, { webkit: { messageHandlers: { explorer: handler } } });
	const events = new EventSource("/events");
	events.onmessage = (event) => window.explorer?.receive(JSON.parse(event.data));
	window.addEventListener("pagehide", () => events.close());
})();
