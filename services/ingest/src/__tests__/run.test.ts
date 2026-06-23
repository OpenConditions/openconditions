import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOpenlrClient } from "../pipeline/run.js";

describe("createOpenlrClient", () => {
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env["OPENLR_RESOLVER_URL"];
  });

  afterEach(() => {
    if (savedUrl === undefined) {
      delete process.env["OPENLR_RESOLVER_URL"];
    } else {
      process.env["OPENLR_RESOLVER_URL"] = savedUrl;
    }
  });

  it("returns null when OPENLR_RESOLVER_URL is not set", () => {
    delete process.env["OPENLR_RESOLVER_URL"];
    expect(createOpenlrClient()).toBeNull();
  });

  it("returns null when OPENLR_RESOLVER_URL is an empty string", () => {
    process.env["OPENLR_RESOLVER_URL"] = "";
    expect(createOpenlrClient()).toBeNull();
  });

  it("returns a MapMatchClient when OPENLR_RESOLVER_URL is set", () => {
    process.env["OPENLR_RESOLVER_URL"] = "https://openlr.example.com";
    const client = createOpenlrClient();
    expect(client).not.toBeNull();
    expect(typeof client!.resolve).toBe("function");
  });
});
