import { describe, expect, it } from "vitest";
import {
  CapabilityNegotiationError,
  negotiateCapabilities,
  type NegotiableCapabilities,
} from "../capabilities.js";

function caps(overrides: Partial<NegotiableCapabilities> = {}): NegotiableCapabilities {
  return {
    protocolVersion: "1.0",
    schemaVersions: ["1", "2"],
    wireFormats: ["application/activity+json"],
    deliveryModes: ["pull", "webhook"],
    convergenceBound: 300,
    ...overrides,
  };
}

describe("negotiateCapabilities", () => {
  it("agrees the MAX mutually-supported protocol version", () => {
    const local = caps({ protocolVersion: "1.0", protocolVersions: ["1.0", "1.1", "2.0"] });
    const peer = caps({ protocolVersion: "1.1", protocolVersions: ["1.1", "1.2", "2.0"] });
    const negotiated = negotiateCapabilities(local, peer);
    expect(negotiated.protocolVersion).toBe("2.0");
  });

  it("agrees a single common protocol version when both advertise one string", () => {
    const negotiated = negotiateCapabilities(
      caps({ protocolVersion: "0.1", protocolVersions: undefined }),
      caps({ protocolVersion: "0.1", protocolVersions: undefined })
    );
    expect(negotiated.protocolVersion).toBe("0.1");
  });

  it("intersects schemaVersions, wireFormats and deliveryModes", () => {
    const local = caps({
      schemaVersions: ["1", "2", "3"],
      wireFormats: ["application/activity+json", "application/cbor"],
      deliveryModes: ["pull", "webhook", "sse"],
    });
    const peer = caps({
      schemaVersions: ["2", "3", "4"],
      wireFormats: ["application/cbor"],
      deliveryModes: ["pull", "sse"],
    });
    const negotiated = negotiateCapabilities(local, peer);
    expect(negotiated.schemaVersions).toEqual(["2", "3"]);
    expect(negotiated.wireFormats).toEqual(["application/cbor"]);
    expect(negotiated.deliveryModes).toEqual(["pull", "sse"]);
  });

  it("takes the MAX (looser) convergenceBound both can meet", () => {
    const negotiated = negotiateCapabilities(
      caps({ convergenceBound: 120 }),
      caps({ convergenceBound: 600 })
    );
    expect(negotiated.convergenceBound).toBe(600);
  });

  it("throws when there is NO common protocol version (peers cannot federate)", () => {
    const local = caps({ protocolVersion: "1.0", protocolVersions: ["1.0"] });
    const peer = caps({ protocolVersion: "2.0", protocolVersions: ["2.0"] });
    expect(() => negotiateCapabilities(local, peer)).toThrow(CapabilityNegotiationError);
  });

  it("compares versions numerically, not lexically (10 > 9)", () => {
    const local = caps({ protocolVersion: "1.9", protocolVersions: ["1.9", "1.10"] });
    const peer = caps({ protocolVersion: "1.10", protocolVersions: ["1.9", "1.10"] });
    expect(negotiateCapabilities(local, peer).protocolVersion).toBe("1.10");
  });

  it("returns an empty intersection (not an error) when schema sets are disjoint", () => {
    const negotiated = negotiateCapabilities(
      caps({ schemaVersions: ["1"] }),
      caps({ schemaVersions: ["2"] })
    );
    expect(negotiated.schemaVersions).toEqual([]);
  });
});
