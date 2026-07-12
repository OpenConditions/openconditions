import { describe, expect, it } from "vitest";
import { evidenceRowsToLedger, type ReportEvidenceRow } from "../evidence-ledger.js";

const NOW = "2026-07-11T12:00:00.000Z";

function row(overrides: Partial<ReportEvidenceRow> = {}): ReportEvidenceRow {
  return {
    id: 1,
    observationId: "obs-1",
    evidenceKind: "report",
    actorKeyId: "key-a",
    sourceId: null,
    occurredAt: "2026-07-11T11:00:00.000Z",
    details: {},
    ...overrides,
  };
}

describe("evidenceRowsToLedger — kind mapping", () => {
  it("sets ledger.now from the passed instant and passes entries through", () => {
    const ledger = evidenceRowsToLedger([row()], NOW);
    expect(ledger.now).toBe(NOW);
    expect(ledger.entries).toHaveLength(1);
  });

  it("maps report → report and carries id/at/reporterKey", () => {
    const [entry] = evidenceRowsToLedger(
      [row({ id: 7, evidenceKind: "report", actorKeyId: "key-x", occurredAt: NOW })],
      NOW
    ).entries;
    expect(entry).toMatchObject({ id: "7", at: NOW, kind: "report", reporterKey: "key-x" });
  });

  it("stringifies a numeric id", () => {
    const [entry] = evidenceRowsToLedger([row({ id: 42 })], NOW).entries;
    expect(entry!.id).toBe("42");
  });

  it("maps confirm → confirm", () => {
    const [entry] = evidenceRowsToLedger([row({ evidenceKind: "confirm" })], NOW).entries;
    expect(entry!.kind).toBe("confirm");
  });

  it("maps negate → negate", () => {
    const [entry] = evidenceRowsToLedger([row({ evidenceKind: "negate" })], NOW).entries;
    expect(entry!.kind).toBe("negate");
  });

  it("maps official_match → external official confirmed by default (no details.outcome)", () => {
    const [entry] = evidenceRowsToLedger(
      [row({ evidenceKind: "official_match", details: {} })],
      NOW
    ).entries;
    expect(entry!.kind).toBe("external");
    expect(entry!.external).toEqual({ source: "official", outcome: "confirmed" });
  });

  it("maps official_match → external official rejected when details.outcome says so", () => {
    const [entry] = evidenceRowsToLedger(
      [row({ evidenceKind: "official_match", details: { outcome: "rejected" } })],
      NOW
    ).entries;
    expect(entry!.external).toEqual({ source: "official", outcome: "rejected" });
  });

  it("maps official_match with explicit confirmed outcome", () => {
    const [entry] = evidenceRowsToLedger(
      [row({ evidenceKind: "official_match", details: { outcome: "confirmed" } })],
      NOW
    ).entries;
    expect(entry!.external).toEqual({ source: "official", outcome: "confirmed" });
  });

  it("defaults official_match to confirmed only when the outcome is genuinely absent", () => {
    for (const details of [undefined, null, {}, { outcome: undefined }, { other: "x" }]) {
      const [entry] = evidenceRowsToLedger(
        [row({ evidenceKind: "official_match", details })],
        NOW
      ).entries;
      expect(entry!.external).toEqual({ source: "official", outcome: "confirmed" });
    }
  });

  it("throws TypeError on a PRESENT but unrecognized official_match outcome (never coerce to confirmed)", () => {
    for (const outcome of ["REJECTED", "reject", "", 0, true]) {
      expect(() =>
        evidenceRowsToLedger(
          [row({ id: 99, evidenceKind: "official_match", details: { outcome } })],
          NOW
        )
      ).toThrow(TypeError);
    }
  });

  it("names the row id and the bad outcome value in the error", () => {
    expect(() =>
      evidenceRowsToLedger(
        [row({ id: 99, evidenceKind: "official_match", details: { outcome: "REJECTED" } })],
        NOW
      )
    ).toThrow(/99.*REJECTED/);
  });

  it("maps reviewer_accept → external reviewer confirmed", () => {
    const [entry] = evidenceRowsToLedger([row({ evidenceKind: "reviewer_accept" })], NOW).entries;
    expect(entry!.kind).toBe("external");
    expect(entry!.external).toEqual({ source: "reviewer", outcome: "confirmed" });
  });

  it("maps reviewer_reject → external reviewer rejected", () => {
    const [entry] = evidenceRowsToLedger([row({ evidenceKind: "reviewer_reject" })], NOW).entries;
    expect(entry!.external).toEqual({ source: "reviewer", outcome: "rejected" });
  });

  it("ignores expired rows (expiry is derived, never input)", () => {
    const ledger = evidenceRowsToLedger(
      [row({ id: 1, evidenceKind: "report" }), row({ id: 2, evidenceKind: "expired" })],
      NOW
    );
    expect(ledger.entries).toHaveLength(1);
    expect(ledger.entries[0]!.id).toBe("1");
  });

  it("sets reporterKey to undefined when actorKeyId is null/undefined", () => {
    const [nullKey] = evidenceRowsToLedger([row({ actorKeyId: null })], NOW).entries;
    expect(nullKey!.reporterKey).toBeUndefined();
    const [missing] = evidenceRowsToLedger(
      [{ id: 1, observationId: "o", evidenceKind: "report", occurredAt: NOW }],
      NOW
    ).entries;
    expect(missing!.reporterKey).toBeUndefined();
  });

  it("throws TypeError on an unknown evidence_kind (corrupt ledger, fail loudly)", () => {
    expect(() => evidenceRowsToLedger([row({ evidenceKind: "bogus" })], NOW)).toThrow(TypeError);
  });
});
