/** Public local transport boundary between the Agent host and its clients. */
export { connectTransport, createTransportServer, type TransportClient, type TransportRequest, type TransportServer, type TransportSubscription } from "./endpoint.ts";
export { unixSocketPath } from "./unix-link.ts";
