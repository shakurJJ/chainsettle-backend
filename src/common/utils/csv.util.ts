export function buildCsvFromRows(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) {
    return '';
  }

  const headers = Object.keys(rows[0]);
  const escapeValue = (value: unknown) => {
    if (value === null || value === undefined) {
      return '';
    }

    const stringValue = String(value);
    if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
      return `"${stringValue.replace(/"/g, '""')}"`;
    }

    return stringValue;
  };

  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escapeValue(row[header])).join(','));
  }

  return `${lines.join('\n')}\n`;
}
