import type { AnyRouter, inferRouterContext } from "@trpc/server";
import type {
	FetchCreateContextFnOptions,
	FetchHandlerRequestOptions,
} from "@trpc/server/adapters/fetch";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import type { Server } from "bun";

/**
 * Bun + tRPC Fetch Adapter
 *
 * A small wrapper around @trpc/server's fetch adapter that integrates cleanly
 * with Bun.serve's upgrade flow. If a WebSocket upgrade is attempted on this
 * endpoint, it will forward the Request to Bun's upgrade() and short-circuit
 * the fetch handler.
 *
 */

export type CreateBunContextOptions = FetchCreateContextFnOptions;

export type TrpcBunFetchOptions<TRouter extends AnyRouter> = Omit<
	FetchHandlerRequestOptions<TRouter>,
	"req"
> & {
	/**
	 * Prefix for all tRPC routes, e.g. "/trpc".
	 * Requests not matching this prefix will be ignored by the adapter.
	 */
	endpoint?: string;
	/**
	 * Optional tRPC context factory using FetchCreateContextFnOptions
	 */
	createContext?: (
		opts: CreateBunContextOptions,
	) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
};

export function createTrpcBunFetchAdapter<
	TRouter extends AnyRouter,
	WSData = unknown,
>(opts: TrpcBunFetchOptions<TRouter> & { emitWsUpgrades?: boolean }) {
	return (request: Request, server: Server<WSData>) => {
		const url = new URL(request.url);

		if (opts.endpoint && !url.pathname.startsWith(opts.endpoint)) {
			return;
		}

		// If WebSocket upgrades are enabled, let Bun handle them first.
		// Per ws.md, call server.upgrade with the same 'this' (do not detach).
		// Successful upgrade should not return a Response.
		if (opts.emitWsUpgrades) {
			const upgrade = server.upgrade as unknown as (
				this: Server<WSData>,
				req: Request,
				options?: { headers?: RequestInit["headers"]; data?: WSData },
			) => boolean;
			const upgraded = upgrade.call(server, request, {
				data: { req: request } as unknown as WSData,
			});
			if (upgraded) {
				return;
			}
		}

		return fetchRequestHandler({
			createContext: () => ({}) as never,
			...opts,
			req: request,
			endpoint: opts.endpoint ?? "",
		});
	};
}
