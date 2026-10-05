import type { LayoutBlock } from "./block.js";
import { type LayoutRow, pointFromFields } from "./row.js";

/** Cells of a delimited text, honouring double-quoted cells with doubled quotes and embedded newlines. */
function parseCells(text: string, delimiter: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let cell = "";
  let quoted = false;
  let touched = false;
  const endCell = (): void => {
    record.push(cell);
    cell = "";
  };
  const endRecord = (): void => {
    endCell();
    if (touched || record.some((c) => c.length > 0)) records.push(record);
    record = [];
    touched = false;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"' && cell.trim().length === 0) {
      cell = "";
      quoted = true;
      touched = true;
    } else if (ch === delimiter) {
      endCell();
      touched = true;
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      endRecord();
    } else cell += ch;
  }
  if (cell.length > 0 || record.length > 0 || touched) endRecord();
  return records;
}

/** The rows of a delimited text: the first record is the header, values are trimmed. */
export function decodeCsv(payload: Buffer, block: LayoutBlock): LayoutRow[] {
  let text = payload.toString(block.encoding === "latin1" ? "latin1" : "utf8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const [header, ...body] = parseCells(text, block.delimiter ?? ",");
  if (!header) return [];
  const names = header.map((h) => h.trim());
  return body.map((cells) => {
    const fields: Record<string, unknown> = {};
    names.forEach((name, i) => {
      fields[name] = (cells[i] ?? "").trim();
    });
    const point = pointFromFields(fields, block);
    return point ? { point, fields } : { fields };
  });
}
