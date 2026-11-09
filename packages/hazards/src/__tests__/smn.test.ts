import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseCap } from "../formats/cap.js";
import { catalogFeed, parseContext } from "./helpers/hazards-feed.js";

const body = readFileSync(new URL("./fixtures/smn/cap-1.xml", import.meta.url));
it("projects SMN Spanish text, country, CAP identity, geometry and zoned validity", () => {
  const out = parseCap(
    catalogFeed("ar-smn-alerts"),
    { alerts: [body] },
    parseContext("2026-11-07T15:48:00Z"),
  );
  expect(out.situations).toHaveLength(1);
  const s = out.situations[0]!;
  expect(s).toMatchObject({
    kind: "alert",
    type: "other",
    location: { admin: { country: "AR" }, geometry: { type: "Polygon" } },
  });
  expect(JSON.stringify(s)).toContain("Evitá salir");
  expect(JSON.stringify(s)).toContain("2026-11-07T09:01:37-03:00");
  expect(out.observations).toEqual([]);
});
it("rejects a partial SMN CAP parse rather than withdrawing failed messages", () => {
  expect(() =>
    parseCap(
      catalogFeed("ar-smn-alerts"),
      { alerts: [body, Buffer.from("<html>down</html>")] },
      parseContext("2026-11-07T15:48:00Z"),
    ),
  ).toThrow();
});

it("keeps polygon messages with a shared predecessor distinct and accounts duplicate identifiers", () => {
  const sibling = Buffer.from(
    body.toString().replace(/(<identifier>)(.*?)(<\/identifier>)/, "$1$2.sibling$3"),
  );
  const out = parseCap(
    catalogFeed("ar-smn-alerts"),
    { alerts: [body, sibling, body] },
    parseContext("2026-11-07T15:48:00Z"),
  );
  expect(out.situations).toHaveLength(2);
  expect(new Set(out.situations.map((s) => s["id"])).size).toBe(2);
  expect(out.records).toMatchObject({ inputCount: 3, uniqueCount: 2, duplicates: 1 });
});
it("withholds Test, Private, Restricted and expired CAP; refuses missing namespace and unreviewed resources", () => {
  for (const text of [
    body.toString().replace("Actual", "Test"),
    body.toString().replace("Public", "Private"),
    body.toString().replace("Public", "Restricted"),
  ]) {
    expect(
      parseCap(
        catalogFeed("ar-smn-alerts"),
        { alerts: [Buffer.from(text)] },
        parseContext("2026-11-07T15:48:00Z"),
      ).situations,
    ).toEqual([]);
  }
  expect(
    parseCap(catalogFeed("ar-smn-alerts"), { alerts: [body] }, parseContext("2026-11-08T15:48:00Z"))
      .situations,
  ).toEqual([]);
  for (const text of [
    body.toString().replace(' xmlns="urn:oasis:names:tc:emergency:cap:1.2"', ""),
    body
      .toString()
      .replace(
        "</info>",
        "<resource><resourceDesc>third party</resourceDesc><mimeType>image/png</mimeType><uri>https://third-party.test/a.png</uri></resource></info>",
      ),
    body.toString().replace(/<info>.*<\/info>/s, ""),
  ]) {
    expect(() =>
      parseCap(
        catalogFeed("ar-smn-alerts"),
        { alerts: [body, Buffer.from(text)] },
        parseContext("2026-11-07T15:48:00Z"),
      ),
    ).toThrow();
  }
});
it("validity begins at effective or sent and preserves forecast onset separately", () => {
  const forecast = Buffer.from(
    body
      .toString()
      .replace(
        /<onset>.*?<\/onset>/,
        "<effective>2026-11-07T10:00:00-03:00</effective><onset>2026-11-07T14:00:00-03:00</onset>",
      ),
  );
  const s = parseCap(
    catalogFeed("ar-smn-alerts"),
    { alerts: [forecast] },
    parseContext("2026-11-07T15:48:00Z"),
  ).situations[0]!;
  expect(s["validity"]).toMatchObject({ start: "2026-11-07T10:00:00-03:00" });
  expect(s["details"]).toMatchObject({ cap: { onset: "2026-11-07T14:00:00-03:00" } });
});

it("enforces ACP qualification and refuses complete-snapshot authority in catalogue lint", async () => {
  const { hazardsDomain } = await import("../domain.js");
  expect(
    hazardsDomain.lintFeed?.({ ...catalogFeed("ar-smn-acp-alerts"), disabled: undefined }),
  ).toEqual(["SMN ACP requires a real active CAP capture before activation"]);
  expect(
    hazardsDomain.lintFeed?.({
      ...catalogFeed("ar-smn-alerts"),
      snapshot: { completeness: "complete" },
    }),
  ).toEqual(["SMN RSS requires rolling CAP acquisition without complete-snapshot authority"]);
});

it("admits the selected CAP licence and denies unknown, NC and share-alike own/upstream rights", async () => {
  const { isPublicRecord } = await import("@openconditions/ingest-framework");
  const license = catalogFeed("ar-smn-alerts").license;
  expect(isPublicRecord({ provenance: { attribution: { license } } })).toBe(true);
  for (const denied of [
    "NOASSERTION",
    "unregistered-provider-rights",
    "CC-BY-NC-4.0",
    "CC-BY-SA-4.0",
  ]) {
    expect(isPublicRecord({ provenance: { attribution: { license: denied } } })).toBe(false);
    expect(
      isPublicRecord({ provenance: { attribution: { license }, upstream: [{ license: denied }] } }),
    ).toBe(false);
  }
});

it("refuses a malformed secondary hazard while generic CAP stays tolerant", () => {
  const text = body.toString();
  const info = text.match(/<info>.*<\/info>/s)![0]!;
  const mixed = Buffer.from(
    text.replace(
      "</alert>",
      info.replace("<severity>Moderate</severity>", "<severity>INVALID</severity>") + "</alert>",
    ),
  );
  const feed = catalogFeed("ar-smn-alerts");
  const ctx = parseContext("2026-11-07T15:48:00Z");
  expect(() => parseCap(feed, { alerts: [mixed] }, ctx)).toThrow("unusable");
  const generic = {
    ...feed,
    endpoints: { alerts: { url: "https://example.org/cap", cadenceSec: 180 } },
  };
  expect(parseCap(generic, { alerts: [mixed] }, ctx).situations).toHaveLength(1);
});

// Byte-faithful full capture; the clock is the recorded capture instant.
it("projects every independent captured variant without fabricating reference authority", () => {
  const alerts = Array.from({ length: 41 }, (_, n) =>
    readFileSync(
      new URL(
        `./fixtures/smn/generation-20261109/ar-${String(n).padStart(3, "0")}.xml`,
        import.meta.url,
      ),
    ),
  );
  for (const order of [alerts, [...alerts].reverse()]) {
    const out = parseCap(
      catalogFeed("ar-smn-alerts"),
      { alerts: [...order, order[0]!] },
      parseContext("2026-11-09T07:11:40Z"),
    );
    expect(out.situations).toHaveLength(33);
    expect(new Set(out.situations.map((s) => s["id"])).size).toBe(33);
    expect(out.records).toMatchObject({
      uniqueCount: 41,
      duplicates: 1,
      terminal: 8,
      accepted: 33,
    });
    expect(out.smn).toMatchObject({ partial: true, expired: 8, withheld: 0 });
    expect(out.smn?.diagnostics).toHaveLength(41);
    for (const s of out.situations) {
      expect(s["relations"]).toBeUndefined();
      expect(s["groupId"]).toBeUndefined();
      expect(s["externalIds"]).toMatchObject([{ scheme: "cap", authority: "smn@smn.gob.ar" }]);
    }
    expect(out.observations).toEqual([]);
  }
});

// Synthetic lifecycle sequences, built from one licensed captured message.
it("resolves only unique exact tuples and withholds ambiguous effects and affected assertions", () => {
  const original = body.toString();
  const id = original.match(/<identifier>(.*?)<\/identifier>/)![1]!;
  const sender = original.match(/<sender>(.*?)<\/sender>/)![1]!;
  const sent = original.match(/<sent>(.*?)<\/sent>/)![1]!;
  const variant = Buffer.from(original.replace("<instruction>", "<instruction>Otra instrucción. "));
  expect(variant.equals(body)).toBe(false);
  const action = (kind: string, refs: string, info = false) =>
    Buffer.from(
      original
        .replace(`<identifier>${id}</identifier>`, `<identifier>${id}.action</identifier>`)
        .replace(/<msgType>.*?<\/msgType>/, `<msgType>${kind}</msgType>`)
        .replace(/<references>.*?<\/references>/, `<references>${refs}</references>`)
        .replace(/<info>.*<\/info>/s, info ? original.match(/<info>.*<\/info>/s)![0]! : ""),
    );
  const tuple = `${sender},${id},${sent}`;
  const parse = (alerts: Buffer[]) =>
    parseCap(catalogFeed("ar-smn-alerts"), { alerts }, parseContext("2026-11-07T15:48:00Z"));
  for (const kind of ["Update", "Cancel"]) {
    const a = action(kind, tuple, kind === "Update");
    for (const alerts of [
      [body, a],
      [a, body],
    ]) {
      const out = parse(alerts);
      expect(out.situations).toHaveLength(kind === "Update" ? 1 : 0);
      expect(out.smn?.withheld).toBe(0);
      expect(out.smn?.diagnostics).toHaveLength(1);
      if (kind === "Update") expect(out.situations[0]!["relations"]).toHaveLength(1);
    }
    for (const alerts of [
      [body, variant, a],
      [a, variant, body],
    ]) {
      const out = parse(alerts);
      expect(out.situations).toEqual([]);
      expect(out.smn?.withheld).toBe(3);
      expect(out.records?.terminal).toBe(0);
      expect(out.smn?.diagnostics.some((d) => d.reason === "ambiguous-lifecycle")).toBe(true);
    }
    const missing = parse([body, action(kind, `${sender},MISSING,${sent}`, kind === "Update")]);
    expect(missing.situations).toHaveLength(kind === "Update" ? 2 : 1);
    expect(missing.smn?.withheld).toBe(kind === "Cancel" ? 1 : 0);
    const multiple = parse([
      body,
      action(kind, `${tuple} ${sender},MISSING,${sent}`, kind === "Update"),
    ]);
    expect(multiple.situations).toHaveLength(kind === "Update" ? 1 : 0);
    expect(multiple.smn?.withheld).toBe(kind === "Cancel" ? 2 : 0);
    const wrongSender = parse([
      body,
      action(kind, `other@sender,${id},${sent}`, kind === "Update"),
    ]);
    expect(wrongSender.situations).toHaveLength(kind === "Update" ? 2 : 1);
  }
});

it.each(["severity", "urgency", "certainty"])(
  "refuses expired SMN messages with malformed %s before lifecycle accounting",
  (field) => {
    const xml = body
      .toString()
      .replace(new RegExp(`<${field}>[^<]*</${field}>`), `<${field}>INVALID</${field}>`);
    const feed = catalogFeed("ar-smn-alerts");
    const ctx = parseContext("2026-11-09T07:11:40Z");
    expect(() => parseCap(feed, { alerts: [Buffer.from(xml)] }, ctx)).toThrow("unusable");
    const generic = {
      ...feed,
      endpoints: { alerts: { url: "https://example.org/cap", cadenceSec: 180 } },
    };
    expect(() => parseCap(generic, { alerts: [Buffer.from(xml)] }, ctx)).not.toThrow();
  },
);

it.each([false, true])(
  "validates each expired SMN info before grouping (reverse=%s)",
  (reverse) => {
    const xml = body.toString();
    const info = xml.match(/<info>.*<\/info>/s)![0]!;
    const bad = info.replace(/<event>.*?<\/event>/s, "<event></event>");
    const infos = reverse ? bad + info : info + bad;
    const grouped = Buffer.from(xml.replace(info, infos));
    const feed = catalogFeed("ar-smn-alerts");
    const ctx = parseContext("2026-11-09T07:11:40Z");
    expect(() => parseCap(feed, { alerts: [grouped] }, ctx)).toThrow("unusable");
    const generic = {
      ...feed,
      endpoints: { alerts: { url: "https://example.org/cap", cadenceSec: 180 } },
    };
    expect(() => parseCap(generic, { alerts: [grouped] }, ctx)).not.toThrow();
  },
);
