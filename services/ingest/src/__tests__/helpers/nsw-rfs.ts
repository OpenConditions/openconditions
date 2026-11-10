/** Constructed adverse payloads, never evidence of native RFS lifecycle behavior. */
export function revisionCycle(xml: string, count: number): string {
  const object = xml.match(/<contentObject>[\s\S]*?<\/contentObject>/)![0];
  const id = object.match(/<identifier>(.*?)<\/identifier>/)![1];
  const sent = object.match(/<sent>(.*?)<\/sent>/)![1];
  const revisions = Array.from({ length: count }, (_, i) =>
    object
      .replace(`<identifier>${id}</identifier>`, `<identifier>cycle-${i}</identifier>`)
      .replace("<msgType>Alert</msgType>", "<msgType>Update</msgType>")
      .replace(
        "<incidents>",
        `<references>webmaster@rfs.nsw.gov.au,cycle-${(i + 1) % count},${sent}</references><incidents>`,
      ),
  );
  return xml.replace(object, revisions.join(""));
}

export const malformedInfo = [
  "<parameter><valueName></valueName><value>Evacuate immediately</value></parameter>",
  "<audience><instruction>Evacuate immediately</instruction></audience>",
  "<parameter><value>Evacuate immediately</value></parameter>",
  "<parameter><valueName>Extra</valueName></parameter>",
  "<eventCode><value>unknown</value></eventCode>",
  "<area><areaDesc>Place</areaDesc><geocode><value>code</value></geocode></area>",
  "<resource><mimeType>text/html</mimeType></resource>",
  "<unknown>unaccounted</unknown>",
  "<parameter>unreadable</parameter>",
];
