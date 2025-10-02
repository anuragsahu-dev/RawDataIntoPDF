import express, { Request, Response, NextFunction } from "express";
import puppeteer, { Browser } from "puppeteer";
import { z } from "zod";

// Validate input: only title + cards[].title + cards[].description are required.
// Extra fields in the body are allowed and ignored.
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

// Extract S.No., English, Hindi cells from each <tr> (expects 3 <td> per row)
function extractRowsFromTableHTML(html: string): Row[] {
  const out: Row[] = [];
  const tbodyMatch = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i);
  const scope = tbodyMatch ? tbodyMatch[1] : html;

  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let tr;
  while ((tr = trRe.exec(scope)) !== null) {
    const cells: string[] = [];
    const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let td;
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
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans:wght@400;600&family=Noto+Sans+Devanagari:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm; }
  body { font-family: "Noto Sans", system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; color:#111; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  h2 { font-size: 16px; margin: 14px 0 6px; }
  table { width:100%; border-collapse: collapse; }
  th, td { border:1px solid #ddd; padding:8px; vertical-align: top; }
  th { background:#f5f5f5; font-weight:600; font-size:12px; }
  td { font-size:13px; }
  .hin { font-family: "Noto Sans Devanagari","Noto Sans",Mangal,"Hind",Arial,sans-serif; font-size:15px; }
  col.sno { width: 8%; }
  col.eng { width: 46%; }
  col.hin { width: 46%; }
  .section { break-inside: avoid; margin-bottom: 12px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${sections.map(s => `
  <div class="section">
    <h2>${escapeHtml(s.name)}</h2>
    <table>
      <colgroup><col class="sno"><col class="eng"><col class="hin"></colgroup>
      <thead><tr><th>S.No.</th><th>English</th><th>Hindi</th></tr></thead>
      <tbody>
        ${s.rows.map(r => `
          <tr>
            <td>${escapeHtml(r.sno)}</td>
            <td>${escapeHtml(r.en)}</td>
            <td class="hin">${escapeHtml(r.hi)}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  </div>
`).join("")}
</body></html>`;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

// Single endpoint that validates, parses, generates and streams the PDF
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

  let browser: Browser | null = null;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "14mm", right: "14mm", bottom: "14mm", left: "14mm" },
    });
    await page.close();
    await browser.close();
    browser = null;

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", 'attachment; filename="lesson-22.pdf"');
    return res.send(pdf);
  } catch {
    if (browser) await browser.close();
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
