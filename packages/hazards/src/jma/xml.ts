import { XMLParser, XMLValidator } from "fast-xml-parser";

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: false,
});
const predefined: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function characters(value: string): string {
  return value.replace(/&([^;]*);|&/g, (reference, entity: string | undefined) => {
    if (entity !== undefined && Object.hasOwn(predefined, entity)) return predefined[entity]!;
    if (entity && /^(?:#[0-9]+|#x[0-9a-fA-F]+)$/.test(entity)) {
      const point = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (
        point === 9 ||
        point === 10 ||
        point === 13 ||
        (point >= 0x20 && point <= 0xd7ff) ||
        (point >= 0xe000 && point <= 0xfffd) ||
        (point >= 0x10000 && point <= 0x10ffff)
      )
        return String.fromCodePoint(point);
    }
    throw new Error("JMA: unsupported XML character reference " + reference);
  });
}
/** Decode scalar XML characters once, after parsing, so references cannot become markup.
 * DTDs, comments, CDATA and processing instructions have no admitted native contract.
 */
export function parseJmaXml(xml: string): unknown {
  const declaration =
    /^\uFEFF?<\?xml\s+version\s*=\s*(?:"1\.0"|'1\.0')(?:\s+encoding\s*=\s*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:\s+standalone\s*=\s*(?:"(?:yes|no)"|'(?:yes|no)'))?\s*\?>/;
  const content = xml.replace(declaration, "");
  if (/<!|<\?/.test(content) || XMLValidator.validate(xml) !== true)
    throw new Error("JMA: unsupported or invalid XML form");
  const decode = (value: unknown): unknown => {
    if (typeof value === "string") return characters(value);
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decode(child)]));
    return value;
  };
  return decode(parser.parse(xml));
}
