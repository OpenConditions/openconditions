/** One row of MeteoAlarm's alias file: the EMMA id, the code standing for it, and that code's geocode name. */
export type MeteoAlarmAliasRow = readonly [emma: string, code: string, type: string];

/** The vendored alias file: where it came from, when, and its rows in file order. */
export interface MeteoAlarmAliasSnapshot {
  source: string;
  lastModified: string | null;
  retrievedAt: string;
  rows: readonly MeteoAlarmAliasRow[];
}

/**
 * The rows of MeteoAlarm's alias CSV (`CODE,ALIAS_CODE,ALIAS_TYPE`), header
 * dropped. A byte-order mark, quoted cells and CRLF line ends are read; a row
 * missing any of the three cells is skipped.
 */
export function readMeteoAlarmAliasCsv(text: string): MeteoAlarmAliasRow[] {
  const rows: MeteoAlarmAliasRow[] = [];
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/).slice(1)) {
    const [emma, code, type] = line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
    if (emma && code && type) rows.push([emma, code, type]);
  }
  return rows;
}

/** The EMMA regions each code stands for, keyed `<type>:<code>`. */
export function aliasIndex(rows: readonly MeteoAlarmAliasRow[]): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [emma, code, type] of rows) {
    const key = `${type}:${code}`;
    const regions = index.get(key) ?? [];
    if (!regions.includes(emma)) regions.push(emma);
    index.set(key, regions);
  }
  return index;
}
