import { describe, expect, it } from "vitest";
import { nextLinkTarget, parseLinkHeader } from "../link-header.js";

describe("parseLinkHeader", () => {
  it("reads the OCPI example", () => {
    expect(
      nextLinkTarget(
        '<https://www.server.com/ocpi/cpo/2.2.1/cdrs/?offset=150&limit=50>; rel="next"',
      ),
    ).toBe("https://www.server.com/ocpi/cpo/2.2.1/cdrs/?offset=150&limit=50");
  });

  it("splits links on commas outside targets and quoted strings", () => {
    const links = parseLinkHeader(
      '<https://h.test/a?x=1,2>; rel="prev"; title="a, b", <https://h.test/b>; REL=next',
    );
    expect(links.map((l) => [l.target, l.rels])).toEqual([
      ["https://h.test/a?x=1,2", ["prev"]],
      ["https://h.test/b", ["next"]],
    ]);
    expect(links[0]!.params.get("title")).toBe("a, b");
  });

  it("reads a relation among several, case-insensitively", () => {
    expect(nextLinkTarget('</p2>; rel="last NEXT"')).toBe("/p2");
  });

  it("ignores a second rel parameter (RFC 8288 §3.3)", () => {
    expect(nextLinkTarget('</p2>; rel="prev"; rel="next"')).toBeUndefined();
  });

  it("does not take a link about another resource for the next page", () => {
    expect(nextLinkTarget('</p2>; rel="next"; anchor="#x"')).toBeUndefined();
  });

  it("names no next page without the header or without such a link", () => {
    expect(nextLinkTarget(null)).toBeUndefined();
    expect(nextLinkTarget('</p0>; rel="first"')).toBeUndefined();
    expect(nextLinkTarget("")).toBeUndefined();
  });

  it("unescapes quoted strings", () => {
    expect(parseLinkHeader('</a>; title="say \\"hi\\""')[0]!.params.get("title")).toBe('say "hi"');
  });

  it("throws on a value outside the grammar", () => {
    for (const bad of [
      '</a; rel="next"',
      'https://h.test/a; rel="next"',
      '</a> rel="next"',
      '</a>; rel="next',
    ]) {
      expect(() => parseLinkHeader(bad)).toThrow(/malformed Link header/);
    }
  });
});
