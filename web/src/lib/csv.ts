/**
 * RFC 4180, plus two concessions to the two programs that will actually open
 * these files (SPEC §11.6).
 *
 * Shared by the ledger export and the `raw_messages` dump. One implementation
 * because both files carry the same hazard — Arabic text and SMS bodies from
 * whoever sent them — and a second copy is a second chance to omit one of the
 * two lines below.
 *
 * The **BOM** is for Excel: without it, Excel reads a UTF-8 CSV as the local
 * codepage and every Arabic merchant name, biller and message body in the file
 * becomes mojibake. It is invisible to everything else.
 *
 * The **leading apostrophe** on `=`, `+` and `@` is formula injection: a
 * spreadsheet treats a cell beginning with one as a formula, and these cells
 * contain attacker-adjacent text — the raw dump is literally a table of strings
 * sent to your phone by third parties. `-` is left alone so that a negative
 * figure stays a number.
 */

export function toCsv(rows: Record<string, string>[], columns?: string[]): string {
  // A file with a BOM and nothing else. An empty CSV with no header row is
  // still a valid, openable file that says "no rows"; a zero-byte one looks
  // like a failed download.
  if (rows.length === 0 && !columns) return "﻿";

  const cols = columns ?? Object.keys(rows[0]);
  const lines = [cols.map(escape).join(",")];

  for (const row of rows) {
    lines.push(cols.map((c) => escape(row[c] ?? "")).join(","));
  }

  return `﻿${lines.join("\r\n")}\r\n`;
}

export function escape(value: string): string {
  const guarded = /^[=+@]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}
