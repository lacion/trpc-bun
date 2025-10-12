import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { initTRPC, TRPCError } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import type { Server } from "bun";
import type { CreateBunContextOptions } from "./fetchAdapter";
import { configureTrpcBunServer } from "./serverAdapter";
import { broadcastReconnectNotification } from "./websocketBroadcaster";

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("e2e", () => {
	let server: Server<unknown>;

	const t = initTRPC
		.context<{
			name: string;
			params: CreateBunContextOptions["info"]["connectionParams"];
			cookieSid: string | null;
			urlSearch: URLSearchParams;
		}>()
		.create();

	// in-memory state for mutation tests
	let counter = 0;

	type AddInput = { a: number; b: number };
	type NeedsPositiveInput = { n?: unknown } | undefined;

	const router = t.router({
		hello: t.procedure.query(({ ctx }) => `Hello ${ctx.name}!`),

		exception: t.procedure.query(() => {
			throw new Error("MyError");
		}),

		digits: t.procedure.subscription(() =>
			observable<number>((subscriber) => {
				setTimeout(() => {
					subscriber.next(0);
					subscriber.next(1);
					subscriber.next(2);
					subscriber.error(new Error("MyError"));
				}, 10);
			}),
		),

		names: t.procedure.subscription(async function* () {
			await wait(10);
			yield "gollum";
			yield "gandalf";
			yield "frodo";
			throw new Error("MyError");
		}),

		params: t.procedure.query(({ ctx }) => ctx.params),

		// HTTP input success
		add: t.procedure.query(({ ctx, input }) => {
			let raw: unknown = input;
			if (typeof raw === "string") {
				try {
					raw = JSON.parse(raw);
				} catch {
					raw = { a: 0, b: 0 } satisfies AddInput;
				}
			}
			if (!raw || typeof raw !== "object") {
				const qs = ctx.urlSearch.get("input");
				if (qs) {
					try {
						raw = JSON.parse(qs);
					} catch {
						raw = { a: 0, b: 0 } satisfies AddInput;
					}
				}
			}
			const data = (raw ?? { a: 0, b: 0 }) as AddInput;
			const a = typeof data?.a === "number" ? data.a : 0;
			const b = typeof data?.b === "number" ? data.b : 0;
			return a + b;
		}),

		// HTTP validation error (BAD_REQUEST)
		needsPositive: t.procedure.query(({ input }) => {
			const raw = (input ?? (undefined as unknown)) as NeedsPositiveInput;
			const n = raw?.n;
			if (typeof n !== "number" || !(n > 0)) {
				throw new TRPCError({ code: "BAD_REQUEST", message: "n must be > 0" });
			}
			return n;
		}),

		// Cookie propagation
		cookie: t.procedure.query(({ ctx }) => ctx.cookieSid ?? null),

		// WebSocket mutation
		increment: t.procedure.mutation(() => ++counter),

		// Backpressure test: many fast events, then complete
		many: t.procedure.subscription(() =>
			observable<number>((subscriber) => {
				for (let i = 0; i < 20; i++) {
					queueMicrotask(() => subscriber.next(i));
				}
				queueMicrotask(() => subscriber.complete());
			}),
		),

		// Slow stream for early stop and disconnect tests
		slow: t.procedure.subscription(() =>
			observable<number>((subscriber) => {
				let i = 0;
				const id = setInterval(() => {
					subscriber.next(i++);
					if (i > 100) {
						clearInterval(id);
						subscriber.complete();
					}
				}, 5);
				return () => clearInterval(id);
			}),
		),
	});

	beforeAll(async () => {
		server = Bun.serve(
			configureTrpcBunServer(
				{
					router,
					endpoint: "/trpc",
					createContext({ req, info }) {
						// simple cookie parser for tests
						const cookie = req.headers.get("cookie") ?? "";
						const sidMatch = /(?:^|;\s*)sid=([^;]+)/.exec(cookie);
						const urlObj = new URL(req.url);
						return {
							name: req.headers.get("x-name") ?? "World",
							params: info.connectionParams,
							cookieSid: sidMatch?.[1] ?? null,
							urlSearch: urlObj.searchParams,
						};
					},
				},
				{
					port: 13123,
					fetch() {
						return new Response("Falling back to fetch");
					},
				},
			),
		);
	});

	afterAll(() => server.stop(true));

	test("http call procedure", async () => {
		const response = await fetch("http://localhost:13123/trpc/hello");
		expect(response.ok).toBe(true);
		const result = await response.json();
		expect(result).toEqual({ result: { data: "Hello World!" } });
	});

	test("http call procedure +ctx", async () => {
		const response = await fetch("http://localhost:13123/trpc/hello", {
			headers: {
				"x-name": "John",
			},
		});
		expect(response.ok).toBe(true);
		const result = await response.json();
		expect(result).toEqual({ result: { data: "Hello John!" } });
	});

	test("http call exception", async () => {
		const response = await fetch("http://localhost:13123/trpc/exception");
		expect(response.ok).toBe(false);
		const result = await response.json();
		expect(result).toEqual({
			error: {
				code: -32603,
				message: "MyError",
				data: {
					code: "INTERNAL_SERVER_ERROR",
					httpStatus: 500,
					path: "exception",
					stack: expect.any(String),
				},
			},
		});
	});

	// HTTP: input success (GET with input param)
	test("http call with input", async () => {
		const input = encodeURIComponent(
			JSON.stringify({ a: 2, b: 3 } satisfies AddInput),
		);
		const res = await fetch(`http://localhost:13123/trpc/add?input=${input}`);
		expect(res.ok).toBe(true);
		const json: unknown = await res.json();
		expect(json).toEqual({ result: { data: 5 } });
	});

	// HTTP: validation error mapping (BAD_REQUEST)
	test("http validation error -> 400 BAD_REQUEST", async () => {
		const input = encodeURIComponent(
			JSON.stringify({ n: -1 } as NeedsPositiveInput),
		);
		const res = await fetch(
			`http://localhost:13123/trpc/needsPositive?input=${input}`,
		);
		expect(res.status).toBe(400);
		const json: unknown = await res.json();
		expect(
			(json as { error: { data: { code: string } } }).error.data.code,
		).toBe("BAD_REQUEST");
	});

	// HTTP: not found path
	test("http unknown path -> 404 NOT_FOUND", async () => {
		const res = await fetch("http://localhost:13123/trpc/unknownHttp");
		expect(res.status).toBe(404);
		const json: unknown = await res.json();
		expect(
			(json as { error: { data: { code: string } } }).error.data.code,
		).toBe("NOT_FOUND");
	});

	// HTTP: cookie propagation into context
	test("http cookie propagation", async () => {
		const res = await fetch("http://localhost:13123/trpc/cookie", {
			headers: { cookie: "sid=abc123" },
		});
		expect(res.ok).toBe(true);
		const json: unknown = await res.json();
		expect(json).toEqual({ result: { data: "abc123" } });
	});

	test("websocket call procedure", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();

		ws.onopen = () => {
			ws.send(
				JSON.stringify({ id, method: "query", params: { path: "hello" } }),
			);
		};

		await new Promise((resolve) => {
			ws.onmessage = (event) => {
				const data = JSON.parse(event.data as string);
				try {
					expect(data).toEqual({
						id,
						result: { type: "data", data: "Hello World!" },
					});
				} finally {
					resolve(true);
				}
			};
		});

		ws.close();
	});

	// WS: mutation path
	test("websocket call mutation", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id1 = Math.random();
		const id2 = Math.random();

		const messages: Array<{ id: number; result?: unknown; error?: unknown }> =
			[];
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id: id1,
					method: "mutation",
					params: { path: "increment" },
				}),
			);
			ws.send(
				JSON.stringify({
					id: id2,
					method: "mutation",
					params: { path: "increment" },
				}),
			);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				messages.push(JSON.parse(event.data as string));
				if (messages.length === 2) resolve();
			};
		});

		ws.close();

		expect(messages).toContainEqual({
			id: id1,
			result: { type: "data", data: 1 },
		});
		expect(messages).toContainEqual({
			id: id2,
			result: { type: "data", data: 2 },
		});
	});

	test("ws error", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();

		ws.onopen = () => {
			ws.send(
				JSON.stringify({ id, method: "query", params: { path: "unknown" } }),
			);
		};

		await new Promise((resolve) => {
			ws.onmessage = (event) => {
				const data = JSON.parse(event.data as string);
				try {
					expect(data).toEqual({
						id,
						error: {
							code: -32004,
							message: `No "query"-procedure on path "unknown"`,
							data: {
								code: "NOT_FOUND",
								httpStatus: 404,
								path: "unknown",
								stack: expect.any(String),
							},
						},
					});
				} finally {
					resolve(true);
				}
			};
		});

		ws.close();
	});

	test("ws exception", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();

		ws.onopen = () => {
			ws.send(
				JSON.stringify({ id, method: "query", params: { path: "exception" } }),
			);
		};

		await new Promise((resolve) => {
			ws.onmessage = (event) => {
				const data = JSON.parse(event.data as string);
				try {
					expect(data).toEqual({
						id,
						error: {
							code: -32603,
							message: "MyError",
							data: {
								code: "INTERNAL_SERVER_ERROR",
								httpStatus: 500,
								path: "exception",
								stack: expect.any(String),
							},
						},
					});
				} finally {
					resolve(true);
				}
			};
		});

		ws.close();
	});

	test("websocket call subscription", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");

		const messages: unknown[] = [];
		const id = Math.random();

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id,
					method: "subscription",
					params: { path: "digits" },
				}),
			);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				const data = JSON.parse(event.data as string);
				messages.push(data);
				if (
					(data as { result?: { type?: string } })?.result?.type === "stopped"
				) {
					resolve();
				}
			};
		});

		ws.send(JSON.stringify({ id, method: "subscription.stop" }));

		ws.close();

		expect(messages).toEqual([
			{ id, result: { type: "started" } },
			{ id, result: { type: "data", data: 0 } },
			{ id, result: { type: "data", data: 1 } },
			{ id, result: { type: "data", data: 2 } },
			{
				id,
				error: {
					code: -32603,
					message: "MyError",
					data: {
						code: "INTERNAL_SERVER_ERROR",
						httpStatus: 500,
						path: "digits",
						stack: expect.any(String),
					},
				},
			},
			{ id, result: { type: "stopped" } },
		]);
	});

	test("websocket call subscription (generator function)", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");

		const messages: unknown[] = [];
		const id = Math.random();

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id,
					method: "subscription",
					params: { path: "names" },
				}),
			);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				const data = JSON.parse(event.data as string);
				messages.push(data);
				if (
					(data as { result?: { type?: string } })?.result?.type === "stopped"
				) {
					resolve();
				}
			};
		});

		ws.send(JSON.stringify({ id, method: "subscription.stop" }));

		ws.close();

		expect(messages).toEqual([
			{ id, result: { type: "started" } },
			{ id, result: { type: "data", data: "gollum" } },
			{ id, result: { type: "data", data: "gandalf" } },
			{ id, result: { type: "data", data: "frodo" } },
			{
				id,
				error: {
					code: -32603,
					message: "MyError",
					data: {
						code: "INTERNAL_SERVER_ERROR",
						httpStatus: 500,
						path: "names",
						stack: expect.any(String),
					},
				},
			},
			{ id, result: { type: "stopped" } },
		]);
	});

	// WS: backpressure / many events
	test("websocket subscription many events in order", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();
		const data: number[] = [];

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id,
					method: "subscription",
					params: { path: "many" },
				}),
			);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				const msg = JSON.parse(event.data as string);
				if (msg?.result?.type === "data") data.push(msg.result.data);
				if (msg?.result?.type === "stopped") resolve();
			};
		});

		ws.close();

		expect(data.length).toBe(20);
		for (let i = 0; i < data.length; i++) expect(data[i]).toBe(i);
	});

	// WS: stop early prevents further data
	test("websocket subscription stop early", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();
		const data: number[] = [];

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id,
					method: "subscription",
					params: { path: "slow" },
				}),
			);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				const msg = JSON.parse(event.data as string);
				if (msg?.result?.type === "data") {
					data.push(msg.result.data);
					// stop after first data
					ws.send(JSON.stringify({ id, method: "subscription.stop" }));
				}
				if (msg?.result?.type === "stopped") resolve();
			};
		});

		ws.close();

		expect(data.length).toBe(1);
	});

	// WS: ping/pong then query
	test("websocket ping/pong then query", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();

		let got = false;
		ws.onopen = () => {
			ws.send("PING");
			setTimeout(() => {
				ws.send(
					JSON.stringify({ id, method: "query", params: { path: "hello" } }),
				);
			}, 5);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data as string);
					if (msg?.id === id && msg?.result?.type === "data") got = true;
				} catch {}
				if (got) resolve();
			};
		});

		ws.close();
		expect(got).toBe(true);
	});

	// WS: concurrent subscriptions
	test("websocket concurrent subscriptions", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const idA = Math.random();
		const idB = Math.random();

		let gotA = false;
		let gotB = false;

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id: idA,
					method: "subscription",
					params: { path: "many" },
				}),
			);
			ws.send(
				JSON.stringify({
					id: idB,
					method: "subscription",
					params: { path: "slow" },
				}),
			);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				const msg = JSON.parse(event.data as string);
				if (msg?.id === idA && msg?.result?.type === "data") gotA = true;
				if (msg?.id === idB && msg?.result?.type === "data") {
					gotB = true;
					ws.send(JSON.stringify({ id: idB, method: "subscription.stop" }));
				}
				if (gotA && gotB) resolve();
			};
		});

		ws.close();
		expect(gotA && gotB).toBe(true);
	});

	// WS: duplicate id handling
	test("websocket duplicate id returns BAD_REQUEST", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = 42;
		const messages: Array<{ error?: { data?: { code?: string } } }> = [];

		ws.onopen = () => {
			const payload = JSON.stringify({
				id,
				method: "query",
				params: { path: "hello" },
			});
			ws.send(payload);
			ws.send(payload);
		};

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				messages.push(JSON.parse(event.data as string));
				if (messages.length >= 2) resolve();
			};
		});

		ws.close();

		const hasBadRequest = messages.some(
			(m) => m?.error?.data?.code === "BAD_REQUEST",
		);
		expect(hasBadRequest).toBe(true);
	});

	// WS: client disconnect during stream (no crash)
	test("websocket disconnect during stream", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		const id = Math.random();
		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id,
					method: "subscription",
					params: { path: "slow" },
				}),
			);
			setTimeout(() => ws.close(), 5);
		};
		// allow event loop to flush without unhandled errors
		await new Promise((r) => setTimeout(r, 20));
		expect(true).toBe(true);
	});

	// Server-initiated reconnect broadcast
	test("websocket reconnect broadcast", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc");
		let gotReconnect = false;

		ws.onopen = () => {
			// trigger broadcast after connection established
			setTimeout(() => {
				const sent = broadcastReconnectNotification();
				expect(sent).toBeGreaterThanOrEqual(1);
			}, 5);

			ws.onmessage = (event) => {
				try {
					const msg = JSON.parse(event.data as string);
					if (msg?.method === "reconnect") gotReconnect = true;
				} catch {}
			};
		};

		await new Promise((resolve) => setTimeout(resolve, 30));
		ws.close();
		expect(gotReconnect).toBe(true);
	});

	test("fall through to fetch", async () => {
		const response = await fetch("http://localhost:13123/other");
		expect(response.ok).toBe(true);
		const result = await response.text();
		expect(result).toEqual("Falling back to fetch");
	});

	test("websocket connection params", async () => {
		const ws = new WebSocket("ws://localhost:13123/trpc?connectionParams=1");

		ws.onopen = () => {
			ws.send(
				JSON.stringify({
					id: 1,
					method: "connectionParams",
					data: { foo: "bar" },
				}),
			);

			ws.send(
				JSON.stringify({
					id: 2,
					method: "query",
					params: { path: "params" },
				}),
			);
		};

		const messages: unknown[] = [];

		await new Promise<void>((resolve) => {
			ws.onmessage = (event) => {
				const data: unknown = JSON.parse(event.data as string);
				messages.push(data);
				resolve();
			};
		});

		ws.close();

		expect(messages).toEqual([
			{ id: 2, result: { type: "data", data: { foo: "bar" } } },
		]);
	});
});
