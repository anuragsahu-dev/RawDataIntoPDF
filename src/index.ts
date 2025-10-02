import express, { Request, Response, NextFunction } from "express";
import puppeteer, { Browser } from "puppeteer";
import { z } from "zod";

// Input validation: require title + cards[].title + cards[].description.
// Extra fields are allowed and ignored.
const IncomingCard = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
}).passthrough();

const IncomingPayload = z.object({
  title: z.string().min(1),
  cards: z.array(IncomingCard).min(1),
}).passthrough();

type Row = { sno: string; en: string; hi: string };
type Section = { name: string; rows: Row[] };
type Normalized = { title: string; sections: Section[] };

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;" }[c]!));
}

// Extract S.No., English, Hindi from each table row (expects 3 <td>)
function extractRowsFromTableHTML(html: string): Row[] {
  const out: Row[] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const scope = tbodyMatch ? tbodyMatch[1] : html;

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr: RegExpExecArray | null;
  while ((tr = trRe.exec(scope)) !== null) {
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(tr[1])) !== null) {
      const text = td[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/\s+/g, " ")
        .trim();
      cells.push(text);
    }
    if (cells.length >= 3) {
      const [snoRaw, enRaw, hiRaw] = cells;
      if (snoRaw && enRaw && hiRaw) {
        out.push({
          sno: snoRaw.trim(),
          en: enRaw.trim(),
          hi: hiRaw.trim(),
        });
      }
    }
  }
  return out;
}

function buildHtmlDoc(data: Normalized): string {
  const { title, sections } = data;

  // helper to split rows into two columns
  const splitRows = (rows: Row[]) => {
    const mid = Math.ceil(rows.length / 2);
    return [rows.slice(0, mid), rows.slice(mid)];
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap" rel="stylesheet">
<style>
  /* Tight printable page with thin margins to utilize space */
  @page { size: A4; margin: 8mm; }

  /* Keep text font sizes; optimize spacing and layout */
  body { font-family: "Noto Sans", system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#111; }
  h1 { font-size: 18px; margin: 0 0 6px; }
  h2 { font-size: 14px; margin: 8px 0 6px; }

  /* Two-column layout for each section to double visible items */
  .section { break-inside: avoid; margin: 0 0 6px; }
  .twocol {
    column-count: 2;
    column-gap: 10mm;
  }
  .pane { break-inside: avoid; margin: 0 0 6px; }

  /* Tables remain bilingual with 3 columns: S.No. | English | Hindi */
  table { width: 100%; border-collapse: collapse; table-layout: fixed; margin: 0 0 6px; }
  th, td { border: 0.5px solid #ddd; padding: 4px 6px; vertical-align: top; }
  th { background: #f3f3f3; font-weight: 600; font-size: 11px; }
  td { font-size: 12.5px; line-height: 1.35; }
  .hin { font-family: "Noto Sans Devanagari","Noto Sans",Mangal,"Hind",Arial,sans-serif; font-size: 13.5px; line-height: 1.35; }

  /* Column widths tuned for narrower panes without changing text sizes */
  col.sno { width: 9%; }
  col.eng { width: 45%; }
  col.hin { width: 46%; }

  /* Allow rows to break across pages; avoid large gaps at page bottom */
  tr, thead, tbody { break-inside: auto; page-break-inside: auto; }
  table { page-break-inside: auto; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sections.map(s => {
  const [leftRows, rightRows] = splitRows(s.rows);
  const tableHtml = (rows: Row[]) => `
    <table>
      <colgroup><col class="sno"><col class="eng"><col class="hin"></colgroup>
      <thead><tr><th>S.No.</th><th>English</th><th>Hindi</th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(r.sno)}</td>
            <td>${escapeHtml(r.en)}</td>
            <td class="hin">${escapeHtml(r.hi)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  return `
  <div class="section">
    <h2>${escapeHtml(s.name)}</h2>
    <div class="twocol">
      <div class="pane">
        ${tableHtml(leftRows)}
      </div>
      <div class="pane">
        ${tableHtml(rightRows)}
      </div>
    </div>
  </div>`;
}).join("")}
</body></html>`;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

let browser: Browser | null = null;
async function getBrowser() {
  if (!browser) {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
  }
  return browser;
}

// Single endpoint: validate -> parse -> generate -> stream PDF
app.post("/pdf", async (req: Request, res: Response) => {
  const parsed = IncomingPayload.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Invalid payload", issues: parsed.error.issues });
  }
  const { title, cards } = parsed.data;

  const sections: Section[] = cards.map(c => ({
    name: c.title,
    rows: extractRowsFromTableHTML(c.description),
  })).filter(s => s.rows.length > 0);

  if (!sections.length) {
    return res.status(400).json({ error: "No rows extracted from provided HTML." });
  }

  const html = buildHtmlDoc({ title, sections });

  try {
    const browser = await getBrowser();
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true
      // CSS @page controls margins
    });
    await page.close();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="lesson-22.pdf"');
    return res.send(pdf);
  } catch (err) {
    console.error(err);
    if (browser) {
      try { await browser.close(); } catch {}
    }
    browser = null;
    return res.status(500).json({ error: "PDF generation failed" });
  }
});

// Health + error handler
app.get("/health", (_req, res) => res.json({ ok: true }));
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal Server Error" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`PDF service listening on http://localhost:${PORT}`);
});
