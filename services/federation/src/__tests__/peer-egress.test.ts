import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveFederationSettings } from "../config.js";
import { peerFetch } from "../peer-egress.js";

const enabled = {
  OPENCONDITIONS_FEDERATION_ENABLED: "true",
  OPENCONDITIONS_INSTANCE_ID: "me.example.org",
  OPENCONDITIONS_FEDERATION_ACTOR: JSON.stringify({
    instanceId: "me.example.org",
    baseUrl: "https://me.example.org",
    operator: "Me",
    jurisdiction: "NL",
    coverage: {},
    license: "ODbL-1.0",
    trustTier: 1,
    capabilities: { protocolVersion: "0.1", convergenceBound: 300 },
  }),
};

/** A throwaway CA, a client certificate it issued, and a self-signed server certificate. */
let dir: string;
const file = (name: string) => join(dir, name);
const openssl = (...args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "federation-client-cert-"));
  const selfSigned = (cn: string, key: string, cert: string) =>
    openssl(
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      `/CN=${cn}`,
      "-keyout",
      file(key),
      "-out",
      file(cert),
    );
  selfSigned("test-ca", "ca.key", "ca.pem");
  selfSigned("localhost", "server.key", "server.pem");
  openssl(
    "req",
    "-new",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    "/CN=me.example.org",
    "-keyout",
    file("client.key"),
    "-out",
    file("client.csr"),
  );
  openssl(
    "x509",
    "-req",
    "-in",
    file("client.csr"),
    "-CA",
    file("ca.pem"),
    "-CAkey",
    file("ca.key"),
    "-set_serial",
    "1",
    "-days",
    "1",
    "-out",
    file("client.pem"),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("the client certificate settings", () => {
  const withFiles = (cert?: string, key?: string) => ({
    ...enabled,
    ...(cert !== undefined ? { OPENCONDITIONS_FEDERATION_CLIENT_CERT_FILE: cert } : {}),
    ...(key !== undefined ? { OPENCONDITIONS_FEDERATION_CLIENT_KEY_FILE: key } : {}),
  });

  it("are absent when neither file is named, and read once when both are", () => {
    expect(resolveFederationSettings(enabled).clientCertificate).toBeUndefined();
    expect(
      resolveFederationSettings(withFiles(file("client.pem"), file("client.key")))
        .clientCertificate,
    ).toEqual({
      cert: readFileSync(file("client.pem"), "utf8"),
      key: readFileSync(file("client.key"), "utf8"),
    });
  });

  it("fail the boot when one file is missing, unreadable, not PEM, or the key is another's", () => {
    expect(() => resolveFederationSettings(withFiles(file("client.pem")))).toThrow(/needs both/);
    expect(() => resolveFederationSettings(withFiles(undefined, file("client.key")))).toThrow(
      /needs both/,
    );
    expect(() =>
      resolveFederationSettings(withFiles(file("absent.pem"), file("client.key"))),
    ).toThrow(/CLIENT_CERT_FILE: cannot read .*absent\.pem \(ENOENT\)/);
    writeFileSync(file("garbage.pem"), "not a certificate");
    expect(() =>
      resolveFederationSettings(withFiles(file("garbage.pem"), file("client.key"))),
    ).toThrow(/is not a PEM certificate/);
    expect(() =>
      resolveFederationSettings(withFiles(file("client.pem"), file("garbage.pem"))),
    ).toThrow(/is not a PEM private key/);
    expect(() =>
      resolveFederationSettings(withFiles(file("client.pem"), file("server.key"))),
    ).toThrow(/is not the key of the certificate/);
  });

  it("never put what the files hold in a message", () => {
    const key = readFileSync(file("server.key"), "utf8");
    let message = "";
    try {
      resolveFederationSettings(withFiles(file("client.pem"), file("server.key")));
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/is not the key of the certificate/);
    expect(message).not.toContain(key.split("\n")[1]);
  });
});

describe("a request to a peer", () => {
  it("presents the configured client certificate, and none without one", async () => {
    const server = createServer(
      {
        key: readFileSync(file("server.key")),
        cert: readFileSync(file("server.pem")),
        ca: readFileSync(file("ca.pem")),
        requestCert: true,
      },
      (req, res) => {
        const socket = req.socket as TLSSocket;
        const presented = socket.getPeerCertificate();
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            authorized: socket.authorized,
            fingerprint: presented.fingerprint256 ?? null,
          }),
        );
      },
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    // The server's own certificate is self-signed, so the requests trust it by name.
    const serverCa = readFileSync(file("server.pem"), "utf8");
    const opts = {
      maxBytes: 1024 * 1024,
      timeoutMs: 5_000,
      maxRedirects: 0,
      allowedHosts: new Set(["localhost"]),
    };
    try {
      const settings = resolveFederationSettings({
        ...enabled,
        OPENCONDITIONS_FEDERATION_CLIENT_CERT_FILE: file("client.pem"),
        OPENCONDITIONS_FEDERATION_CLIENT_KEY_FILE: file("client.key"),
      });
      const withCert = await (
        await peerFetch(settings, opts, serverCa)(`https://localhost:${port}/`)
      ).json();
      expect(withCert).toEqual({
        authorized: true,
        fingerprint: new X509Certificate(readFileSync(file("client.pem"))).fingerprint256,
      });

      // Without one the server, which requires a certificate, ends the handshake.
      await expect(
        peerFetch(resolveFederationSettings(enabled), opts, serverCa)(`https://localhost:${port}/`),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
