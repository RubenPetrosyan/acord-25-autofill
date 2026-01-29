import formidable from "formidable";
import fs from "fs";
import pdf from "pdf-parse";
import Tesseract from "tesseract.js";
import XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";

export const config = {
  api: { bodyParser: false },
};

async function runOCR(filePath) {
  const result = await Tesseract.recognize(filePath, "eng");
  return result.data.text;
}

function loadSchema() {
  const workbook = XLSX.readFile("Mapping schema.xlsx");
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "POST only" });
  }

  const form = formidable();

  form.parse(req, async (err, fields, files) => {
    try {
      /* ---------- READ DOCUMENT ---------- */
      const file = files.file;
      if (!file) return res.status(400).json({ message: "No file uploaded" });

      let text = "";
      const buf = fs.readFileSync(file.filepath);
      const name = file.originalFilename.toLowerCase();

      if (name.endsWith(".txt")) {
        text = buf.toString("utf8");
      } else if (name.endsWith(".pdf")) {
        const pdfData = await pdf(buf);
        text =
          pdfData.text.trim().length > 50
            ? pdfData.text
            : await runOCR(file.filepath);
      } else if (name.match(/\.(png|jpg|jpeg)$/)) {
        text = await runOCR(file.filepath);
      } else {
        return res.status(400).json({ message: "Unsupported file type" });
      }

      /* ---------- LOAD SCHEMA ---------- */
      const schema = loadSchema();

      const schemaPrompt = schema
        .map(
          r =>
            `Field: ${r["Field Name"]}
Key: ${r["Mapping Key"]}
Instruction: ${r["What to Enter"]}`
        )
        .join("\n\n");

      /* ---------- AI EXTRACTION ---------- */
      const aiRes = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            messages: [
              {
                role: "user",
                content: `
Extract values strictly.

RULES:
- Extract ONLY if explicitly present
- NO guessing
- If missing, return empty string
- Output JSON only

SCHEMA:
${schemaPrompt}

DOCUMENT:
${text}
`,
              },
            ],
          }),
        }
      );

      const aiData = await aiRes.json();
      const extracted = JSON.parse(aiData.choices[0].message.content);

      Object.keys(extracted).forEach(k => {
        if (!extracted[k]) delete extracted[k];
      });

      /* ---------- FILL ACORD PDF ---------- */
      const pdfBytes = fs.readFileSync("ACORD_0025_2016-03_Acroform.pdf");
      const pdfDoc = await PDFDocument.load(pdfBytes);
      const formPdf = pdfDoc.getForm();

      for (const key in extracted) {
        try {
          const field = formPdf.getTextField(key);
          field.setText(String(extracted[key]));
        } catch {
          // ignore missing fields safely
        }
      }

      formPdf.flatten();

      const finalPdf = await pdfDoc.save();

      /* ---------- RETURN FILE ---------- */
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="ACORD_25_Filled.pdf"'
      );

      res.send(Buffer.from(finalPdf));
    } catch (e) {
      res.status(500).json({ message: "PDF generation failed" });
    }
  });
}
