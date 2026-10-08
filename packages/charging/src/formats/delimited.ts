import { StringDecoder } from "node:string_decoder";

/** One record of a delimited file, holding only the columns asked for. */
export type DelimitedRow = Record<string, string>;

export interface DelimitedOptions {
  delimiter: string;
  /** The columns to keep, by header name; a column the header lacks is absent from every row. */
  columns: readonly string[];
  /**
   * The header is the first record whose first cell is this; the records
   * before it (a register's title and notes) are skipped. Without it the
   * first record is the header.
   */
  headerStartsWith?: string;
  /** Bytes decoded at a time; the file is never held as one string. */
  chunkBytes?: number;
}

const CHUNK_BYTES = 1 << 20;

/**
 * Reads a delimited text record by record, calling `onRow` with the wanted
 * columns only. Double-quoted cells (doubled quotes, delimiters and newlines
 * inside) are honoured, a leading byte order mark and CRLF line ends are
 * read as the publisher wrote them. The text is decoded in chunks and a cell
 * of a column nobody asked for is never accumulated, so a file of many
 * columns costs the memory of the columns kept, not of the whole record.
 * Values are trimmed. Rows that are entirely empty are skipped.
 */
export function readDelimited(
  payload: Buffer,
  options: DelimitedOptions,
  onRow: (row: DelimitedRow) => void,
): void {
  const { delimiter, headerStartsWith } = options;
  const wanted = new Set(options.columns);
  const chunkBytes = Math.max(1, options.chunkBytes ?? CHUNK_BYTES);
  const decoder = new StringDecoder("utf8");

  /** Column index → name, for the wanted columns the header holds. */
  let kept: Map<number, string> | undefined;
  let record: string[] | DelimitedRow = [];
  let cellIndex = 0;
  let cell = "";
  let quoted = false;
  /** Whether the cell has had a non-blank character, kept whether or not the cell is accumulated. */
  let cellStarted = false;
  let quoteSeen = false;
  let touched = false;
  let sawCr = false;
  let started = false;

  const keeps = (): boolean => kept === undefined || kept.has(cellIndex);

  const endCell = (): void => {
    if (kept === undefined) (record as string[]).push(cell.trim());
    else {
      const name = kept.get(cellIndex);
      if (name !== undefined) (record as DelimitedRow)[name] = cell.trim();
    }
    cell = "";
    cellStarted = false;
    cellIndex++;
  };

  const endRecord = (): void => {
    endCell();
    const wasTouched = touched;
    touched = false;
    if (kept === undefined) {
      const cells = record as string[];
      const isHeader =
        headerStartsWith === undefined
          ? wasTouched || cells.some((c) => c !== "")
          : cells[0] === headerStartsWith;
      if (isHeader) {
        const names = new Map<number, string>();
        cells.forEach((name, i) => {
          if (wanted.has(name) && ![...names.values()].includes(name)) names.set(i, name);
        });
        kept = names;
      }
    } else {
      const row = record as DelimitedRow;
      if (Object.values(row).some((v) => v !== "")) onRow(row);
    }
    record = kept === undefined ? [] : {};
    cellIndex = 0;
  };

  const feed = (text: string): void => {
    for (let i = 0; i < text.length; i++) {
      const ch = text.charAt(i);
      if (!started) {
        started = true;
        if (ch === "﻿") continue;
      }
      if (sawCr) {
        sawCr = false;
        if (ch === "\n") continue;
      }
      if (quoteSeen) {
        quoteSeen = false;
        if (ch === '"') {
          if (keeps()) cell += '"';
          continue;
        }
        quoted = false;
      }
      if (quoted) {
        if (ch === '"') quoteSeen = true;
        else if (keeps()) cell += ch;
        continue;
      }
      if (ch === '"' && !cellStarted) {
        cell = "";
        quoted = true;
        cellStarted = true;
        touched = true;
      } else if (ch === delimiter) {
        endCell();
        touched = true;
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r") sawCr = true;
        endRecord();
      } else {
        if (ch !== " " && ch !== "\t") cellStarted = true;
        if (keeps()) cell += ch;
      }
    }
  };

  for (let offset = 0; offset < payload.length; offset += chunkBytes) {
    feed(decoder.write(payload.subarray(offset, offset + chunkBytes)));
  }
  feed(decoder.end());
  if (quoteSeen) {
    quoteSeen = false;
    quoted = false;
  }
  if (cell.length > 0 || cellStarted || cellIndex > 0 || touched) endRecord();
}
