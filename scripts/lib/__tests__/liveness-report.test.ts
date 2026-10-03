import { describe, expect, it } from "vitest";
import { renderReport } from "../liveness-report.js";

describe("renderReport", () => {
  it("groups failures by feed with redacted error + maintainer @-mentions", () => {
    const md = renderReport([
      {
        feed: {
          id: "nl-ndw-events",
          name: "NDW (Netherlands)",
          domain: "roads",
          region: "nl",
          maintainers: [
            { name: "Ada", github: "ada" },
            { name: "Linus", github: "torvalds" },
          ],
        },
        level: "warning",
        message: "HTTP 503 fetching http://opendata.ndw.nu/actueel_beeld.xml.gz",
      },
      {
        feed: {
          id: "lu-cita-events",
          name: "CITA (Luxembourg)",
          domain: "roads",
          region: "lu",
          maintainers: [],
        },
        level: "error",
        message: "Unexpected token",
      },
    ]);

    expect(md).toContain("2 failing");
    expect(md).toContain("## NDW (Netherlands) (`nl-ndw-events`)");
    expect(md).toContain("- Region file: `feeds/roads/nl.jsonc`");
    expect(md).toContain("- Failure: fetch (network or HTTP)");
    expect(md).toContain("HTTP 503");
    expect(md).toContain("@ada @torvalds");
    // A feed with no maintainers gets the nudge, not an empty mention line.
    expect(md).toContain("## CITA (Luxembourg) (`lu-cita-events`)");
    expect(md).toContain("- Failure: parse");
    expect(md).toMatch(/none listed/i);
    expect(md).not.toContain("@ \n"); // never a dangling bare @
  });

  it("renders a stable, non-empty document for a single failure", () => {
    const md = renderReport([
      {
        feed: { id: "x", name: "X", domain: "roads", region: "nl", maintainers: [] },
        level: "error",
        message: "boom",
      },
    ]);
    expect(md.startsWith("Automated feed-liveness check")).toBe(true);
    expect(md).toContain("1 failing");
  });

  it("sanitizes untrusted feed error text so it cannot @-mention or break Markdown", () => {
    const md = renderReport([
      {
        feed: {
          id: "evil-feed",
          name: "Evil `Feed`",
          domain: "roads",
          region: "nl",
          maintainers: [{ name: "Ada", github: "ada" }],
        },
        level: "error",
        message: "boom @evil please review `x` and\nmerge",
      },
    ]);

    // The untrusted message's @-mention must be de-linked, not raw.
    expect(md).not.toMatch(/[^@]@evil\b/);
    expect(md).toContain("@​evil");
    // A trusted maintainer @-mention must still work normally.
    expect(md).toContain("@ada");
    // Backticks from untrusted fields must not survive verbatim.
    expect(md).not.toContain("`Feed`");
    expect(md).not.toContain("`x`");
  });
});
