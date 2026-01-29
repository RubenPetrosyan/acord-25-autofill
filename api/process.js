import formidable from "formidable";
import fs from "fs";
import pdf from "pdf-parse";
import XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";

export const config = {
  api: {
    bodyParser: false,
  },
};

/**
 * Load extraction schema from Excel
 */
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
      /* ---------- VALIDATE FILE ---------- */
      const file = files.file;
      if (!file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      /* ---------- READ DOCUMENT ---------- */
      let documentText = "";
      const buffer = fs.readFileSync(file.filepath);
      const filename = file.originalFilename.toLowerCase();

      // TXT
      if (filename.endsWith(".txt")) {
        documentText = buffer.toString("utf8");
      }

      // PDF (TEXT-BASED ONLY)
      else if (filename.endsWith(".pdf")) {
        const pdfData = await pdf(buffer);
        documentText = pdfData.text;
      }

      else {
        return res.status(400).json({
          message: "Unsupported file type (OCR disabled)",
        });
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
      const aiResponse = await fetch(
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
                role: "system",
                content:
                  "You extract insurance data. Never guess. Only return values explicitly present.",
              },
              {
                role: "user",
                content: `
RULES:
- Extract ONLY if explicitly present
- NO inference
- NO guessing
- If missing, return empty string
- Return JSON only

SCHEMA:
${schemaPrompt}

DOCUMENT:
${documentText}
`,
              },
            ],
          }),
        }
      );

      const aiData = await aiResponse.json();

      let extracted = {};
      try {
        extracted = JSON.parse(aiData.choices[0].message.content);
      } catch {
        return res
          .status(500)
          .json({ message: "AI returned invalid JSON" });
      }

      // Drop empty values
      Object.keys(extracted).forEach(k => {
        if (!extracted[k]) delete extracted[k];
      });

      /* ---------- FILL ACORD 25 PDF ---------- */
      const pdfTemplate = fs.readFileSync(
        "ACORD_0025_2016-03_Acroform.pdf"
      );

      const pdfDoc = await PDFDocument.load(pdfTemplate);
      const pdfForm = pdfDoc.getForm();

      for (const key in extracted) {
        try {
          const field = pdfForm.getTextField(key);
          field.setText(String(extracted[key]));
        } catch {
          // Ignore missing / non-text fields safely
        }
      }

      pdfForm.flatten();

      const finalPdfBytes = await pdfDoc.save();

      /* ---------- RETURN PDF ---------- */
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="ACORD_25_Filled.pdf"'
      );

      res.send(Buffer.from(finalPdfBytes));
    } catch (e) {
      res.status(500).json({
        message: "Processing failed",
      });
    }
  });
}
