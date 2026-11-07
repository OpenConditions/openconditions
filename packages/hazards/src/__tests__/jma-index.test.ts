import { expect, test } from "vitest";
import { jmaDataUrl, readJmaIndex } from "../jma/index.js";

const url = "https://www.data.jma.go.jp/developer/xml/data/20261106104521_0_VXSE53_010000.xml";
test("only the requested families survive before fetching", () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-07T00:00:00Z</updated><entry><id>${url}</id><link href="${url}"/></entry><entry><id>https://www.data.jma.go.jp/developer/xml/data/20261106104521_0_VPTW40_010000.xml</id><link href="https://evil.invalid/a"/></entry></feed>`;
  expect(readJmaIndex(Buffer.from(xml), ["VXSE53"]).urls).toEqual([url]);
});
test.each([
  url.replace("https:", "http:"),
  url + "?x=1",
  url.replace("www.data.jma.go.jp", "www.data.jma.go.jp.attacker.invalid"),
  url.replace("/data/", "/feed/"),
  url.replace("https://", "https://x@"),
])("reject hostile data URL %s", (u) => {
  expect(() => jmaDataUrl(u)).toThrow();
});
test("invalid or empty documents fail; valid empty Atom stays empty", () => {
  expect(() => readJmaIndex(Buffer.from("<feed>"), ["VXSE53"])).toThrow();
  expect(
    readJmaIndex(
      Buffer.from(
        '<feed xmlns="http://www.w3.org/2005/Atom"><updated>2026-11-07T00:00:00Z</updated></feed>',
      ),
      ["VXSE53"],
    ).urls,
  ).toEqual([]);
});
