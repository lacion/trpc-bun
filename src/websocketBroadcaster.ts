import type { AnyRouter } from "@trpc/server";
import type { ServerWebSocket } from "bun";
import type { TrpcBunWsClientCtx } from "./websocketAdapter";

/**
 * Broadcast utilities for tRPC Bun WS adapter.
 *
 * Provides a reconnect notification broadcast, useful for clients to
 * gracefully resubscribe after backend deploys or network interruptions.
 */

declare global {
	// eslint-disable-next-line no-var
	var activeTrpcClients:
		| Set<ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>>
		| undefined;
}

export function broadcastReconnectNotification() {
	const clients = globalThis.activeTrpcClients as
		| Set<ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>>
		| undefined;
	if (!clients || clients.size === 0) return 0;
	const payload = JSON.stringify({ id: null, method: "reconnect" as const });
	let count = 0;
	for (const client of clients) {
		// best-effort send if socket is open
		const isOpen = (client as { readyState?: number }).readyState === 1;
		if (isOpen) {
			client.send(payload);
			count++;
		}
	}
	return count;
}
