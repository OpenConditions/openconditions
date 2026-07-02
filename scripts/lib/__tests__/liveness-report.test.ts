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
});
