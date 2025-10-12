### trpc-bun — Bun-native tRPC adapter (HTTP + WebSocket)

[![CI](https://github.com/lacion/trpc-bun/actions/workflows/ci.yml/badge.svg)](https://github.com/lacion/trpc-bun/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/trpc-bun.svg)](https://www.npmjs.com/package/trpc-bun)
![bun](https://img.shields.io/badge/Bun-%3E%3D1.3.0-black?logo=bun)
![tRPC](https://img.shields.io/badge/tRPC-%3E%3D11.6.0-2596be)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE.txt)

- **What**: A tiny, Bun-native adapter for running tRPC over Bun.serve with first-class HTTP and WebSocket support.
- **Why**: Use Bun’s latest APIs with tRPC v11 — no Node.js shims.
- **How**: HTTP via `fetch` adapter + Bun’s `upgrade`; WS via Bun’s `websocket` handler; one-liner server composer; optional reconnect broadcast.

---

### Table of Contents
- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quickstart](#quickstart)
- [Usage](#usage)
  - [HTTP only](#http-only)
  - [WebSocket only](#websocket-only)
  - [Combined server](#combined-server)
  - [Reconnect broadcast](#reconnect-broadcast)
- [API](#api)
- [Repository overview](#repository-overview)
- [Contributing](#contributing)
- [License](#license)
- [Acknowledgments](#acknowledgments)
- [Contact](#contact)

### Features
- Bun 1.3+ native HTTP (`Bun.serve`) + WS (`websocket` handler)
- tRPC 11.6+ using only public server APIs
- Simple adapters:
  - `createTrpcBunFetchAdapter` (HTTP)
  - `createTrpcBunWebSocketAdapter` (WS)
  - `configureTrpcBunServer` (compose HTTP + WS for `Bun.serve`)
  - `broadcastReconnectNotification` (server-initiated WS notification)
- Connection params over WS, subscriptions, mutations, error shaping
- Duplicate id protection, graceful stop/disconnect handling
- Test suite with `bun test` and GitHub Actions CI

### Requirements
- Bun ≥ 1.3.0
- @trpc/server ≥ 11.6.0
- TypeScript ≥ 5

### Install

```bash
# with bun
bun add trpc-bun @trpc/server

# or npm
npm install trpc-bun @trpc/server
```

Peer dependencies: Bun runtime, TypeScript.

### Quickstart

```ts
import { initTRPC } from "@trpc/server";
import { configureTrpcBunServer } from "trpc-bun";

const t = initTRPC.create();
const appRouter = t.router({
	hello: t.procedure.query(() => "world"),
});

Bun.serve(
	configureTrpcBunServer({
		router: appRouter,
		endpoint: "/trpc",
	}),
);
```

- Uses `globalThis.Bun.Serve.Options<T>` (not deprecated `ServeOptions`).

### Usage

#### HTTP only
```ts
import { initTRPC } from "@trpc/server";
import { createTrpcBunFetchAdapter } from "trpc-bun";

const t = initTRPC.create();
const router = t.router({ hello: t.procedure.query(() => "world") });

const trpcFetch = createTrpcBunFetchAdapter({ router, endpoint: "/trpc" });

Bun.serve({
	fetch(req, server) {
		return trpcFetch(req, server) ?? new Response("fallback");
	},
});
```

#### WebSocket only
```ts
import { initTRPC } from "@trpc/server";
import { createTrpcBunWebSocketAdapter } from "trpc-bun";

const t = initTRPC.create();
const router = t.router({
	numbers: t.procedure.subscription(() =>
		async function* () { yield 1; yield 2; }
	),
});

Bun.serve({
	fetch() { return new Response("OK"); },
	websocket: createTrpcBunWebSocketAdapter({ router }),
});
```

#### Combined server
```ts
import { configureTrpcBunServer } from "trpc-bun";

Bun.serve(
	configureTrpcBunServer({ router, endpoint: "/trpc" })
);
```

#### Reconnect broadcast
```ts
import { broadcastReconnectNotification } from "trpc-bun";

// Later in your deploy hook or admin path:
const sent = broadcastReconnectNotification();
console.log(`sent ${sent} reconnect notifications`);
```

### API
- `createTrpcBunFetchAdapter<TRouter, WSData>(opts)`
  - `endpoint?: string` route prefix (e.g. "/trpc")
  - `createContext?(opts)` standard tRPC fetch context
  - Uses Bun’s `server.upgrade` when `emitWsUpgrades` is enabled by the composer
- `createTrpcBunWebSocketAdapter<TRouter>(opts)`
  - `createContext?(opts)` provides `req`, `res` (ServerWebSocket), and `info`
  - Supports `connectionParams` handshake and subscriptions
- `configureTrpcBunServer<TRouter>(opts, serveOptions?)`
  - Returns `globalThis.Bun.Serve.Options<WebSocketData>` with `fetch` and `websocket`
  - Forwards non-matching routes to your own `serveOptions.fetch`
- `broadcastReconnectNotification()`
  - Broadcasts `{ id: null, method: "reconnect" }` to all open sockets managed by the adapter

For advanced usage, explore `src/` and tests.

### Repository overview
```
.
├─ src/
│  ├─ fetchAdapter.ts              # HTTP adapter (Bun fetch + upgrade)
│  ├─ websocketAdapter.ts          # WebSocket adapter (Bun websocket handler)
│  ├─ serverAdapter.ts             # Composer for Bun.serve
│  ├─ websocketBroadcaster.ts      # Reconnect broadcast helper
│  └─ e2e.test.ts                  # bun:test suite
├─ .github/workflows/ci.yml        # CI with bun lint/test/typecheck
└─ README.md
```

### Contributing
- Issues and PRs welcome! Please:
  - Run `bun run lint && bun run typecheck && bun test` before submitting
  - Keep changes small and well-documented
  - Add/extend tests when changing behavior

Local dev scripts:
```bash
bun run lint
bun run format
bun run typecheck
bun test
```

### License
MIT — see [`LICENSE.txt`](LICENSE.txt)

### Acknowledgments
- tRPC team for excellent server primitives

### Contact
- Author: Luis — `luismmorales@gmail.com`
- GitHub: [`lacion`](https://github.com/lacion)
