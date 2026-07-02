import { describe, expect, it } from "vitest";
import { renderReport } from "../liveness-report.js";

describe("renderReport", () => {
  it("groups failures by feed with redacted error + maintainer @-mentions", () => {
    const md = renderReport([
      {
        domain: "roads",
        feed: {
          id: "ndw",
          name: "NDW (Netherlands)",
          country: "NL",
          maintainers: [
            { name: "Ada", github: "ada" },
            { name: "Linus", github: "torvalds" },
          ],
        },
        message: "HTTP 503 fetching http://opendata.ndw.nu/actueel_beeld.xml.gz",
      },
      {
        domain: "roads",
        feed: { id: "cita-lu", name: "CITA (Luxembourg)", country: "LU" },
        message: "parsed 0 observations",
      },
    ]);

    expect(md).toContain("2 failing");
    expect(md).toContain("## NDW (Netherlands) (`ndw`)");
    expect(md).toContain("HTTP 503");
    expect(md).toContain("@ada @torvalds");
    // A feed with no maintainers gets the nudge, not an empty mention line.
    expect(md).toContain("## CITA (Luxembourg) (`cita-lu`)");
    expect(md).toMatch(/none listed/i);
    expect(md).not.toContain("@ \n"); // never a dangling bare @
  });

  it("renders a stable, non-empty document for a single failure", () => {
    const md = renderReport([
      { domain: "roads", feed: { id: "x", name: "X", country: "NL" }, message: "boom" },
    ]);
    expect(md.startsWith("Automated feed-liveness check")).toBe(true);
    expect(md).toContain("1 failing");
  });

  it("sanitizes untrusted feed error text so it cannot @-mention or break Markdown", () => {
    const md = renderReport([
      {
        domain: "roads",
        feed: {
          id: "evil-feed",
          name: "Evil `Feed`",
          country: "@evil",
          maintainers: [{ name: "Ada", github: "ada" }],
        },
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
