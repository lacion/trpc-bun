import type { AnyRouter, inferRouterContext } from "@trpc/server";
import {
	callTRPCProcedure,
	getErrorShape,
	getTRPCErrorFromUnknown,
	isTrackedEnvelope,
	TRPCError,
	transformTRPCResponse,
} from "@trpc/server";
import type { TRPCRequestInfo } from "@trpc/server/http";
import { parseConnectionParamsFromUnknown } from "@trpc/server/http";
import {
	isObservable,
	observableToAsyncIterable,
} from "@trpc/server/observable";
import {
	parseTRPCMessage,
	type TRPCClientOutgoingMessage,
	type TRPCResponseMessage,
	type TRPCResultMessage,
} from "@trpc/server/rpc";
import type { ServerWebSocket, WebSocketHandler } from "bun";

/**
 * Bun + tRPC WebSocket Adapter
 *
 * Implements the tRPC WS protocol on top of Bun.serve's websocket handler
 * using the latest API. Supports query/mutation responses
 * and subscription streams with backpressure-safe iteration and cancellation.
 *
 */

export type TrpcBunWsContextOptions<TRouter extends AnyRouter> = {
	req: Request;
	res: ServerWebSocket<TrpcBunWsClientCtx<TRouter>>;
	info: TRPCRequestInfo;
};

export type TrpcBunWsOptions<TRouter extends AnyRouter> = {
	router: TRouter;
	createContext?: (
		opts: TrpcBunWsContextOptions<TRouter>,
	) => inferRouterContext<TRouter> | Promise<inferRouterContext<TRouter>>;
	onError?: (opts: {
		error: TRPCError;
		type: "unknown" | "query" | "mutation" | "subscription";
		path?: string;
		ctx?: inferRouterContext<TRouter>;
		input?: unknown;
		req: Request;
	}) => void;
};

export type TrpcBunWsClientCtx<TRouter extends AnyRouter> = {
	req: Request;
	abortController: AbortController;
	abortControllers: Map<string | number, AbortController>;
	inflightIds?: Set<string | number>;
	recentIds?: Set<string | number>;
	ctx:
		| Promise<inferRouterContext<TRouter>>
		| ((
				params: TRPCRequestInfo["connectionParams"],
		  ) => Promise<inferRouterContext<TRouter>>);
};

// Global registry of active WS clients, parametrized with AnyRouter so we avoid 'unknown'
declare global {
	// eslint-disable-next-line no-var
	var activeTrpcClients:
		| Set<ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>>
		| undefined;
}

export function createTrpcBunWebSocketAdapter<TRouter extends AnyRouter>(
	ops: TrpcBunWsOptions<TRouter>,
): WebSocketHandler<TrpcBunWsClientCtx<TRouter>> {
	const { router } = ops;

	// Initialize active client registry if needed
	if (!globalThis.activeTrpcClients) {
		globalThis.activeTrpcClients = new Set<
			ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>
		>();
	}

	const respond = (
		client: ServerWebSocket<unknown>,
		untransformedJSON: TRPCResponseMessage,
	) => {
		client.send(
			JSON.stringify(
				transformTRPCResponse(ops.router._def._config, untransformedJSON),
			),
		);
	};

	async function createClientCtx(
		client: ServerWebSocket<TrpcBunWsClientCtx<inferRouterContext<TRouter>>>,
		url: URL,
		connectionParams: TRPCRequestInfo["connectionParams"],
	) {
		const ctxPromise = ops.createContext?.({
			req: client.data.req,
			res: client,
			info: {
				url,
				connectionParams,
				calls: [],
				isBatchCall: false,
				accept: null,
				type: "unknown",
				signal: client.data.abortController.signal,
			},
		});

		try {
			return await ctxPromise;
		} catch (cause) {
			const error = getTRPCErrorFromUnknown(cause);
			ops.onError?.({
				error,
				path: undefined,
				type: "unknown",
				ctx: undefined,
				req: client.data.req,
				input: undefined,
			});
			respond(client, {
				id: null,
				error: getErrorShape({
					config: router._def._config,
					error,
					type: "unknown",
					path: undefined,
					input: undefined,
					ctx: undefined,
				}),
			});
		}
	}

	async function handleRequest(
		client: ServerWebSocket<TrpcBunWsClientCtx<inferRouterContext<TRouter>>>,
		msg: TRPCClientOutgoingMessage,
	) {
		if (!msg.id) {
			throw new TRPCError({ code: "BAD_REQUEST", message: "`id` is required" });
		}

		if (msg.method === "subscription.stop") {
			client.data.abortControllers.get(msg.id)?.abort();
			client.data.abortControllers.delete(msg.id);
			return;
		}

		const { id, method, jsonrpc } = msg;
		const type = method as "query" | "mutation" | "subscription";
		const { path, lastEventId } = msg.params;
		const req = client.data.req;
		const clientAbortControllers = client.data.abortControllers;
		let { input } = msg.params;
		const ctx = await client.data.ctx;

		try {
			if (lastEventId !== undefined) {
				if (isObject(input)) {
					input = { ...input, lastEventId };
				} else {
					input ??= { lastEventId };
				}
			}

			if (clientAbortControllers.has(id)) {
				throw new TRPCError({
					message: `Duplicate id ${id}`,
					code: "BAD_REQUEST",
				});
			}

			const abortController = new AbortController();
			// Reserve id early for all message types so duplicates are caught
			clientAbortControllers.set(id, abortController);
			const result = await callTRPCProcedure({
				router,
				path,
				getRawInput: () => Promise.resolve(input),
				ctx,
				type,
				signal: abortController.signal,
			});

			const isIterableResult = isAsyncIterable(result) || isObservable(result);

			if (type !== "subscription") {
				if (isIterableResult) {
					throw new TRPCError({
						code: "UNSUPPORTED_MEDIA_TYPE",
						message: `Cannot return an async iterable/observable from a ${type} procedure over WebSockets`,
					});
				}
				respond(client, {
					id,
					jsonrpc,
					result: { type: "data", data: result },
				});
				clientAbortControllers.delete(id);
				return;
			}

			if (!isIterableResult) {
				throw new TRPCError({
					message: `Subscription ${path} did not return an observable or a AsyncGenerator`,
					code: "INTERNAL_SERVER_ERROR",
				});
			}

			if ((client as unknown as { readyState?: number }).readyState !== 1) {
				return;
			}

			const iterable = isObservable(result)
				? observableToAsyncIterable(result, abortController.signal)
				: result;
			const iterator: AsyncIterator<unknown> = iterable[Symbol.asyncIterator]();

			const abortPromise = new Promise<"abort">((resolve) => {
				abortController.signal.onabort = () => resolve("abort");
			});

			run(async () => {
				while (true) {
					const raced: "abort" | Error | IteratorResult<unknown> =
						(await Promise.race([
							iterator.next().catch(getTRPCErrorFromUnknown),
							abortPromise,
						])) as unknown as "abort" | Error | IteratorResult<unknown>;

					if (raced === "abort") {
						await iterator.return?.();
						break;
					}

					if (raced instanceof Error) {
						const error = getTRPCErrorFromUnknown(raced);
						ops.onError?.({ error, path, type, ctx, req, input });
						respond(client, {
							id,
							jsonrpc,
							error: getErrorShape({
								config: router._def._config,
								error,
								type,
								path,
								input,
								ctx,
							}),
						});
						break;
					}

					if (raced.done) {
						break;
					}

					const value = raced.value as unknown;
					if (isTrackedEnvelope(value)) {
						const envelope = value as ReadonlyArray<unknown>;
						const eventId = envelope[0] as string | number;
						const eventData = envelope[1];
						respond(client, {
							id,
							jsonrpc,
							result: {
								type: "data",
								id: eventId,
								data: { id: eventId, data: eventData } as unknown,
							} as TRPCResultMessage<unknown>["result"],
						});
						continue;
					}

					respond(client, {
						id,
						jsonrpc,
						result: { type: "data", data: value },
					});
				}

				await iterator.return?.();
				respond(client, { id, jsonrpc, result: { type: "stopped" } });
			})
				.catch((cause) => {
					const error = getTRPCErrorFromUnknown(cause);
					ops.onError?.({ error, path, type, ctx, req, input });
					respond(client, {
						id,
						jsonrpc,
						error: getErrorShape({
							config: router._def._config,
							error,
							type,
							path,
							input,
							ctx,
						}),
					});
					abortController.abort();
				})
				.finally(() => {
					clientAbortControllers.delete(id);
				});

			respond(client, { id, jsonrpc, result: { type: "started" } });
		} catch (cause) {
			const error = getTRPCErrorFromUnknown(cause);
			ops.onError?.({ error, path, type, ctx, req, input });
			respond(client, {
				id,
				jsonrpc,
				error: getErrorShape({
					config: router._def._config,
					error,
					type,
					path,
					input,
					ctx,
				}),
			});
			clientAbortControllers.delete(id);
		}
	}

	return {
		open(client) {
			client.data.abortController = new AbortController();
			client.data.abortControllers = new Map();
			client.data.inflightIds = new Set();
			client.data.recentIds = new Set();

			const url = createURL(client);
			client.data.ctx = createClientCtx.bind(null, client, url);

			const connectionParams = url.searchParams.get("connectionParams") === "1";
			if (!connectionParams) {
				client.data.ctx = client.data.ctx(
					null as TRPCRequestInfo["connectionParams"],
				);
			}

			// register active client
			if (globalThis.activeTrpcClients) {
				globalThis.activeTrpcClients.add(
					client as unknown as ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>,
				);
			}
		},

		async close(client) {
			client.data.abortController.abort();
			await Promise.all(
				Array.from(client.data.abortControllers.values(), (ctrl) =>
					ctrl.abort(),
				),
			);

			// unregister client
			if (globalThis.activeTrpcClients) {
				globalThis.activeTrpcClients.delete(
					client as unknown as ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>,
				);
			}
		},

		async message(client, message) {
			const msgStr = message.toString();

			if (msgStr === "PONG") return;
			if (msgStr === "PING") {
				client.send("PONG");
				return;
			}

			try {
				const msgJSON: unknown = JSON.parse(msgStr);
				const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];

				if (client.data.ctx instanceof Function) {
					type ConnectionParamsMsg = {
						id: number | string | null;
						method: "connectionParams";
						data: unknown;
					};
					const msg = msgs.shift() as ConnectionParamsMsg;
					client.data.ctx = client.data.ctx(
						parseConnectionParamsFromUnknown(msg.data),
					);
				}

				const promises: Promise<void>[] = [];
				for (const raw of msgs) {
					const parsed = parseTRPCMessage(
						raw,
						router._def._config.transformer,
					) as TRPCClientOutgoingMessage;
					const id = parsed.id;
					const method = (parsed as { method?: string }).method;
					if (id != null && method !== "subscription.stop") {
						if (!client.data.inflightIds) client.data.inflightIds = new Set();
						const inflight = client.data.inflightIds;
						const recent = client.data.recentIds ?? new Set<string | number>();
						client.data.recentIds = recent;
						if (inflight.has(id) || recent.has(id)) {
							respond(client, {
								id,
								jsonrpc: (parsed as TRPCClientOutgoingMessage).jsonrpc,
								error: getErrorShape({
									config: router._def._config,
									error: new TRPCError({
										code: "BAD_REQUEST",
										message: `Duplicate id ${String(id)}`,
									}),
									type:
										(method as "query" | "mutation" | "subscription") ??
										"unknown",
									path: (
										parsed as TRPCClientOutgoingMessage & {
											params?: { path?: string };
										}
									).params?.path,
									input: (
										parsed as TRPCClientOutgoingMessage & {
											params?: { input?: unknown };
										}
									).params?.input,
									ctx: undefined,
								}),
							});
							continue;
						}
						inflight.add(id);
						const p = handleRequest(client, parsed).finally(() => {
							inflight.delete(id);
							// add to recent for a brief TTL window
							recent.add(id);
							setTimeout(() => recent.delete(id), 50);
						}) as Promise<void>;
						promises.push(p);
					} else {
						promises.push(handleRequest(client, parsed));
					}
				}
				await Promise.all(promises);
			} catch (cause) {
				const error = new TRPCError({ code: "PARSE_ERROR", cause });
				respond(client, {
					id: null,
					error: getErrorShape({
						config: router._def._config,
						error,
						type: "unknown",
						path: undefined,
						input: undefined,
						ctx: undefined,
					}),
				});
			}
		},
	};
}

function isAsyncIterable<TValue>(
	value: unknown,
): value is AsyncIterable<TValue> {
	return (
		isObject(value) &&
		typeof (value as { [Symbol.asyncIterator]?: unknown })[
			Symbol.asyncIterator
		] === "function"
	);
}

function run<TValue>(fn: () => TValue): TValue {
	return fn();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && !Array.isArray(value) && typeof value === "object";
}

function createURL(
	client: ServerWebSocket<TrpcBunWsClientCtx<AnyRouter>>,
): URL {
	try {
		const req = client.data.req;
		const protocol =
			hasEncrypted(client) && client.encrypted ? "https:" : "http:";
		const host = req.headers.get("host") ?? "localhost";
		return new URL(req.url, `${protocol}//${host}`);
	} catch (cause) {
		throw new TRPCError({ code: "BAD_REQUEST", message: "Invalid URL", cause });
	}
}

function hasEncrypted(value: unknown): value is { encrypted?: boolean } {
	return (
		typeof value === "object" &&
		value !== null &&
		"encrypted" in (value as object)
	);
}
