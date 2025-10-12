import type { AnyRouter } from "@trpc/server";
import type { Server } from "bun";
import {
	createTrpcBunFetchAdapter,
	type TrpcBunFetchOptions,
} from "./fetchAdapter";
import {
	createTrpcBunWebSocketAdapter,
	type TrpcBunWsClientCtx,
	type TrpcBunWsOptions,
} from "./websocketAdapter";

/**
 * Bun + tRPC Server Adapter
 *
 * Returns a Bun.serve-compatible options object that wires both the fetch
 * adapter and the websocket adapter together. Pass this to Bun.serve to run
 * tRPC over HTTP and WebSocket in one server, using Bun-native features.
 *
 */

type Optional<T, K extends keyof T> = Pick<Partial<T>, K> & Omit<T, K>;

export function configureTrpcBunServer<TRouter extends AnyRouter>(
	opts: TrpcBunFetchOptions<TRouter> & TrpcBunWsOptions<TRouter>,
	serveOptions?: Optional<
		globalThis.Bun.Serve.Options<TrpcBunWsClientCtx<TRouter>>,
		"fetch"
	>,
) {
	const trpcFetch = createTrpcBunFetchAdapter<
		TRouter,
		TrpcBunWsClientCtx<TRouter>
	>({
		...opts,
		emitWsUpgrades: true,
	});

	return {
		...serveOptions,
		async fetch(req: Request, server: Server<TrpcBunWsClientCtx<TRouter>>) {
			const trpcResponse = trpcFetch(req, server);
			if (trpcResponse) return trpcResponse;
			return serveOptions?.fetch?.call(server, req, server);
		},
		websocket: createTrpcBunWebSocketAdapter(opts),
	} as unknown as globalThis.Bun.Serve.Options<TrpcBunWsClientCtx<TRouter>>;
}
