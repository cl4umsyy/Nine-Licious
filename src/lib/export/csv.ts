/**
 * NINE LICIOUS POS — CSV GENERATOR & FORMULA INJECTION SANITIZER
 * File: src/lib/export/csv.ts
 *
 * Sesuai Standar RFC 4180 dan Panduan Keamanan OWASP CSV Injection:
 * 1. Menambahkan UTF-8 BOM (\uFEFF) agar Microsoft Excel langsung mengenali encoding UTF-8.
 * 2. Mencegah CSV Formula Injection (DDE) jika nilai diawali karakter =, +, -, @, \t, atau \r.
 * 3. Menangani escaping karakter spesial (koma, tanda kutip ganda, dan newline).
 */

export const UTF8_BOM = "\uFEFF";

/**
 * Membersihkan nilai sel dari potensi eksekusi formula di Excel/Calc
 * dan melakukan escaping RFC 4180.
 */
export function sanitizeCsvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  let str = String(value);

  // Mencegah Formula Injection:
  // Karakter berbahaya pembuka formula: =, +, @, \t, \r
  // Khusus karakter '-', jika bukan murni angka desimal/negatif biasa, cegah dengan prepend "'"
  const firstChar = str.charAt(0);
  const dangerousFormulaChars = ["=", "+", "@", "\t", "\r"];

  if (dangerousFormulaChars.includes(firstChar)) {
    str = `'${str}`;
  } else if (firstChar === "-") {
    // Periksa apakah str murni angka negatif standar (misal -50000 atau -12.5)
    // Jika mengandung teks lain (misal "-cmd|'/C calc'!A0" atau "- Rp 10.000"), prefix dengan "'"
    const isPureNegativeNumber = /^-?\d+(\.\d+)?$/.test(str.trim());
    if (!isPureNegativeNumber) {
      str = `'${str}`;
    }
  }

  // Escaping tanda kutip ganda (") menjadi ("") sesuai RFC 4180
  if (str.includes('"') || str.includes(",") || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Menyusun satu baris CSV dari array kolom
 */
export function buildCsvRow(cells: (unknown)[]): string {
  return cells.map((cell) => sanitizeCsvCell(cell)).join(",");
}

/**
 * Menyusun dokumen CSV utuh dengan UTF-8 BOM
 */
export function buildCsvDocument(
  headers: string[],
  rows: (unknown)[][],
): string {
  const headerLine = buildCsvRow(headers);
  const dataLines = rows.map((row) => buildCsvRow(row));
  return UTF8_BOM + [headerLine, ...dataLines].join("\r\n");
}

/**
 * Menyusun dokumen CSV multi-seksi dengan pembatas judul seksi yang jelas
 */
export function buildMultiSectionCsv(
  sections: { title?: string; headers: string[]; rows: (unknown)[][] }[],
): string {
  const parts: string[] = [];

  for (const sec of sections) {
    if (sec.title) {
      parts.push(`=== ${sec.title.toUpperCase()} ===`);
    }
    parts.push(buildCsvRow(sec.headers));
    for (const r of sec.rows) {
      parts.push(buildCsvRow(r));
    }
    parts.push(""); // Baris kosong pemisah antar seksi
  }

  return UTF8_BOM + parts.join("\r\n");
}

/**
 * Format tanggal Asia/Jakarta untuk representasi CSV
 */
export function formatJakartaDateTime(isoString: string | null | undefined): string {
  if (!isoString) return "-";
  try {
    const d = new Date(isoString);
    return new Intl.DateTimeFormat("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return String(isoString);
  }
}

/**
 * Trigger file download di browser dari string CSV
 */
export function downloadCsvInBrowser(filename: string, csvContent: string): void {
  if (typeof window === "undefined") return;

  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  link.style.visibility = "hidden";
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
