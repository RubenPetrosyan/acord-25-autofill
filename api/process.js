import formidable from "formidable";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import XLSX from "xlsx";
import { PDFDocument } from "pdf-lib";
import Tesseract from "tesseract.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

/* ---------- LOAD EXTRACTION SCHEMA ---------- */
function loadSchema() {
  const schemaPath = path.join(
    process.cwd(),
    "public/schema/Mapping schema.xlsx"
  );

  const workbook = XLSX.readFile(schemaPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

/* ---------- TEXT EXTRACTION (WITH OCR) ---------- */
async function extractText(file) {
  const buffer = fs.readFileSync(file.filepath);
  const filename = file.originalFilename.toLowerCase();

  // TXT
  if (filename.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  // PDF (OCR fallback)
  if (filename.endsWith(".pdf")) {
    const pdfData = await pdf(buffer);

    if (pdfData.text && pdfData.text.trim().length > 50) {
      return pdfData.text;
    }

    // Scanned PDF → OCR
    const {
      data: { text },
    } = await Tesseract.recognize(buffer, "eng");

    return text;
  }

  // IMAGES → OCR
  if (
    filename.endsWith(".png") ||
    filename.endsWith(".jpg") ||
    filename.endsWith(".jpeg")
  ) {
    const {
      data: { text },
    } = await Tesseract.recognize(buffer, "eng");

    return text;
  }

  throw new Error("Unsupported file type");
}

/* ---------- API HANDLER ---------- */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "POST only" });
  }

  const form = formidable({ multiples: false });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) {
        throw err;
      }

      const file = files.file;
      if (!file) {
        return res.status(400).json({ message: "No file uploaded" });
      }

      /* ---------- EXTRACT DOCUMENT TEXT ---------- */
      const documentText = await extractText(file);

      if (!documentText || documentText.trim().length === 0) {
        return res.status(400).json({ message: "No text extracted" });
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

      /* ---------- OPENAI EXTRACTION ---------- */
      const aiResponse = await fetch(
        "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.Acord25}`,
          },
          body: JSON.stringify({
            model: "gpt-4.1-mini",
            input: [
              {
                role: "system",
                content:
                  "You extract insurance data. Never guess. Only return values explicitly present. Output valid JSON only.",
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

      let extracted;
      try {
        extracted = JSON.parse(aiData.output_text);
      } catch {
        return res
          .status(500)
          .json({ message: "AI returned invalid JSON" });
      }

      // Remove empty values
      Object.keys(extracted).forEach(k => {
        if (!extracted[k]) delete extracted[k];
      });

      /* ---------- LOAD ACORD 25 TEMPLATE ---------- */
      const templatePath = path.join(
        process.cwd(),
        "public/templates/ACORD_0025_2016-03_Acroform.pdf"
      );

      const pdfTemplate = fs.readFileSync(templatePath);
      const pdfDoc = await PDFDocument.load(pdfTemplate);
      const pdfForm = pdfDoc.getForm();

      /* ---------- FILL PDF ---------- */
      for (const key in extracted) {
        try {
          const field = pdfForm.getTextField(key);
          field.setText(String(extracted[key]));
        } catch {
          // ignore missing fields
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
      console.error(e);
      res.status(500).json({
        message: "Processing failed",
      });
    }
  });
}
