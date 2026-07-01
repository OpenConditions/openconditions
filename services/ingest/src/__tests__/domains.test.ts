import { describe, expect, it } from "vitest";
import { DOMAIN_REGISTRY } from "../domains.js";

describe("DOMAIN_REGISTRY", () => {
  it("registers roads as an IngestDomain with name + parser dispatch", () => {
    const roads = DOMAIN_REGISTRY["roads"];
    expect(roads?.name).toBe("roads");
    expect(typeof roads?.parserFor).toBe("function");
    expect(typeof roads?.flowParserFor).toBe("function");
    expect(roads?.feeds.length).toBeGreaterThan(0);
  });
});
