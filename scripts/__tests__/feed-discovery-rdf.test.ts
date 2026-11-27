import { describe, expect, it } from "vitest";
import { licenseOf } from "../lib/feed-discovery/normalize.js";
import { parseRdf } from "../lib/feed-discovery/rdf.js";

const ns =
  'xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://www.w3.org/ns/dcat#" xmlns:t="http://purl.org/dc/terms/" xmlns:m="http://w3id.org/mobilitydcat-ap#" xmlns:a="http://www.w3.org/ns/adms#"';
const wrap = (body: string) => `<r:RDF ${ns}>${body}</r:RDF>`;
const dataset = (body: string) =>
  `<c:Dataset r:about="https://example.org/dataset?unknown=secret"><t:identifier>44751</t:identifier><t:title xml:lang="lv">Darbi</t:title><t:title xml:lang="en">Roadworks</t:title>${body}</c:Dataset>`;
describe("bounded mobilityDCAT RDF/XML subset", () => {
  it("joins aliased namespace Description types and referenced blank nodes without losing HTTP/MQTT siblings", () => {
    const result = parseRdf(
      wrap(
        `<c:Catalog r:about="https://example.org"><c:dataset r:resource="https://example.org/dataset?unknown=secret"/></c:Catalog>${dataset('<m:mobilityTheme r:resource="https://w3id.org/mobilitydcat-ap/mobility-theme/roadworks"/><c:distribution r:nodeID="a"/><c:distribution r:nodeID="b"/>')}<r:Description r:nodeID="a"><r:type r:resource="http://www.w3.org/ns/dcat#Distribution"/><c:accessURL r:resource="https://example.org/landing"/><m:applicationLayerProtocol r:resource="https://w3id.org/mobilitydcat-ap/application-layer-protocol/http-https"/><m:communicationMethod r:resource="https://w3id.org/mobilitydcat-ap/communication-method/push"/><t:license><t:LicenseDocument r:about="http://publications.europa.eu/resource/authority/licence/CC0"/></t:license><t:rights><t:RightsStatement><t:type r:resource="https://w3id.org/mobilitydcat-ap/conditions-for-access-and-usage/licence-provided"/></t:RightsStatement></t:rights><a:sample r:resource="https://example.org/sample"/></r:Description><c:Distribution r:nodeID="b"><c:accessURL r:resource="https://example.org/landing"/><m:applicationLayerProtocol r:resource="https://w3id.org/mobilitydcat-ap/application-layer-protocol/mqtt"/><t:license r:resource="http://publications.europa.eu/resource/authority/licence/CC0"/></c:Distribution>`,
      ),
    );
    expect(result.distributions[0]?.datasetIdentifierHint).toBe("44751");
    expect(result.datasets).toHaveLength(1);
    expect(result.distributions).toHaveLength(2);
    expect(result.missingDataset).toBe(false);
    expect(result.distributions[0]).toMatchObject({
      title: "Roadworks",
      countries: ["LV"],
      sampleUrls: ["https://example.org/sample"],
      licenses: {
        origin: "distribution",
        declarations: ["http://publications.europa.eu/resource/authority/licence/CC0"],
      },
    });
    expect(result.distributions.map((d) => d.protocols[0])).toEqual([
      "https://w3id.org/mobilitydcat-ap/application-layer-protocol/http-https",
      "https://w3id.org/mobilitydcat-ap/application-layer-protocol/mqtt",
    ]);
    expect(result.distributions[0]?.rights).toContain(
      "https://w3id.org/mobilitydcat-ap/conditions-for-access-and-usage/licence-provided",
    );
  });
  it("reports a catalog reference to a missing dataset", () => {
    expect(
      parseRdf(
        wrap(
          '<c:Catalog r:about="https://example.org"><c:dataset r:resource="https://example.org/missing"/></c:Catalog>',
        ),
      ).missingDataset,
    ).toBe(true);
  });
  it.each([
    '<!DOCTYPE r:RDF [<!ENTITY x "boom">]><r:RDF/>',
    wrap(dataset('<t:license r:resource="relative"/>')),
    wrap(dataset('<t:license r:parseType="Resource"/>')),
    wrap(dataset('<t:license custom="hidden rights"/>')),
    wrap(dataset('<t:license t:title="CC0"/>')),
    wrap(dataset("<t:license><r:Bag/></t:license>")),
    wrap(dataset("<r:li>hidden</r:li>")),
    wrap(dataset('<t:license r:ID="foo"/>')),
    `<?xml version="1.0" encoding="ISO-8859-1"?>${wrap(dataset(""))}`,
    wrap('<c:Dataset r:about="https://example.org" xml:base="https://example.org"/>'),
    wrap("<t:title>unrecognized shape</t:title>"),
    wrap(dataset(`<t:title>${"x".repeat(17000)}</t:title>`)),
    wrap(dataset(`${"<t:license>".repeat(60)}x${"</t:license>".repeat(60)}`)),
  ])("rejects unsupported or unsafe forms with a fixed diagnostic", (xml) =>
    expect(() => parseRdf(xml)).toThrow("xml_rejected"),
  );
});
it("detects missing catalog records and record primary-topic datasets", () => {
  expect(
    parseRdf(
      wrap(
        '<c:Catalog r:about="https://example.org"><c:record r:resource="https://example.org/missing"/></c:Catalog>',
      ),
    ).missingDataset,
  ).toBe(true);
  expect(
    parseRdf(
      wrap(
        '<c:Catalog r:about="https://example.org"><c:record><c:CatalogRecord><f:primaryTopic xmlns:f="http://xmlns.com/foaf/0.1/" r:resource="https://example.org/missing"/></c:CatalogRecord></c:record></c:Catalog>',
      ),
    ).missingDataset,
  ).toBe(true);
});

it.each([
  "<t:license><t:LicenseDocument><t:title>Proprietary</t:title></t:LicenseDocument></t:license>",
  '<t:license r:nodeID="missing"/>',
  "<t:license/>",
])("never replaces an unresolved distribution licence with dataset CC0: %s", (declaration) => {
  const d = parseRdf(
    wrap(
      dataset(
        `<t:license r:resource="http://publications.europa.eu/resource/authority/licence/CC0"/><c:distribution><c:Distribution>${declaration}<c:downloadURL r:resource="https://example.org/data"/></c:Distribution></c:distribution>`,
      ),
    ),
  ).distributions[0]!;
  expect(d.licenses.origin).toBe("distribution");
  expect(licenseOf(d.licenses)).toMatchObject({ state: "unmapped", public: false });
});
it.each([
  "<t:rights><t:RightsStatement><t:title>Proprietary</t:title></t:RightsStatement></t:rights>",
  '<t:rights r:nodeID="missing"/>',
])("preserves unresolved distribution rights instead of dataset fallback: %s", (declaration) => {
  const d = parseRdf(
    wrap(
      dataset(
        `<t:rights r:resource="https://example.org/free"/><c:distribution><c:Distribution>${declaration}</c:Distribution></c:distribution>`,
      ),
    ),
  ).distributions[0]!;
  expect(d.evidenceOrigins.rights).toBe("distribution");
  expect(d.rights).toContain("unresolved:blank-node");
  expect(d.rights).not.toContain("https://example.org/free");
});
it("does not count structural indentation as literal text", () => {
  expect(parseRdf(wrap(`${" ".repeat(18000)}${dataset(" ")}`)).datasets).toHaveLength(1);
});
