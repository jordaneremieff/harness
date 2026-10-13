/** Public local transport boundary shared by the agent host and UI consumers. */
export { Endpoint, Feed, connectTransport, createTransportServer, type FeedKind, type TransportClient, type TransportRequest, type TransportServer, type TransportServerOptions, type TransportSubscription } from "./endpoint.ts";
export { createUnixLink, connectUnixLink, listenUnixLinks, unixSocketPath, UNIX_FRAME_BYTES, UNIX_QUEUE_BYTES, LocalTransportRefusal, type LocalTransportRefusalReason, type UnixLink, type UnixLinkOptions } from "./unix-link.ts";
