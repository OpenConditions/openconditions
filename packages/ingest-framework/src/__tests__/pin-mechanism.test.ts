import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Agent, fetch as undiciFetch } from "undici";

// guardedFetch's connection-pinning (see egress.ts) relies on undici honoring
// `Agent({ connect: { lookup } })`: dial the address the lookup returns while
// keeping the ORIGINAL hostname as the Host header + TLS SNI. That is exactly
// what closes the DNS-rebinding TOCTOU. A full end-to-end guardedFetch pin test
// is infeasible — the guard rejects the private/loopback IPs a local test
// server binds to — so this test locks in the underlying undici mechanism
// directly: dial a fixed 127.0.0.1 via a custom `lookup` while requesting an
// unrelated hostname, and assert the server saw that hostname in `Host`.

describe("undici connect.lookup pinning mechanism", () => {
  let server: Server;
  let port: number;
  let receivedHost: string | undefined;

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      receivedHost = req.headers.host;
      res.writeHead(200).end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("dials the pinned 127.0.0.1 address while preserving the requested hostname as Host", async () => {
    const agent = new Agent({
      connect: {
        lookup: (
          _hostname: string,
          _opts: unknown,
          cb: (err: Error | null, addrs: Array<{ address: string; family: number }>) => void
        ) => cb(null, [{ address: "127.0.0.1", family: 4 }]),
      },
    });
    try {
      const res = await undiciFetch(`http://pinned.example.test:${port}/`, {
        dispatcher: agent,
      });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(receivedHost).toBe(`pinned.example.test:${port}`);
    } finally {
      await agent.close();
    }
  });
});
