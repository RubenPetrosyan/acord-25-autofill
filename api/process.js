import formidable from "formidable";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import XLSX from "xlsx";
import mammoth from "mammoth";
import { PDFDocument } from "pdf-lib";
import Tesseract from "tesseract.js";

export const config = {
  api: {
    bodyParser: false,
  },
};

/* ================================
   HELPER FUNCTIONS (CHECKBOX / RADIO)
================================ */
function isTruthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "yes", "checked", "1"].includes(value.toLowerCase());
  }
  return false;
}

/* ================================
   LOAD EXTRACTION SCHEMA
================================ */
function loadSchema() {
  const schemaPath = path.join(
    process.cwd(),
    "public/schema/Mapping schema.xlsx"
  );

  const workbook = XLSX.readFile(schemaPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json(sheet);
}

/* ================================
   EXTRACT TEXT FROM ONE FILE
================================ */
async function extractTextFromFile(file) {
  const buffer = fs.readFileSync(file.filepath);
  const name = file.originalFilename.toLowerCase();

  // TXT
  if (name.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  // PDF (OCR fallback)
  if (name.endsWith(".pdf")) {
    const pdfData = await pdf(buffer);

    if (pdfData.text && pdfData.text.trim().length > 50) {
      return pdfData.text;
    }

    const {
      data: { text },
    } = await Tesseract.recognize(buffer, "eng");

    return text;
  }

  // IMAGES → OCR
  if (name.match(/\.(png|jpg|jpeg)$/)) {
    const {
      data: { text },
    } = await Tesseract.recognize(buffer, "eng");

    return text;
  }

  // DOC / DOCX
  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  }

  // EXCEL AS CONTENT (NOT SCHEMA)
  if (name.endsWith(".xls") || name.endsWith(".xlsx")) {
    const workbook = XLSX.read(buffer);
    let text = "";

    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

      rows.forEach(row => {
        if (row.length) {
          text += row.join(" | ") + "\n";
        }
      });
    }

    return text;
  }

  throw new Error(`Unsupported file type: ${name}`);
}

/* ================================
   API HANDLER
================================ */
export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ message: "POST only" });
  }

  const form = formidable({
    multiples: true,
    maxFileSize: 10 * 1024 * 1024, // 10MB per file
  });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      const uploadedFiles = files.file
        ? Array.isArray(files.file)
          ? files.file
          : [files.file]
        : [];

      const extraText = fields.text || "";

      if (!uploadedFiles.length && !extraText.trim()) {
        return res.status(400).json({
          message: "No files or text provided",
        });
      }

      /* ================================
         MERGE ALL CONTENT
      ================================ */
      let combinedText = "";

      for (const file of uploadedFiles) {
        const text = await extractTextFromFile(file);

        combinedText += `
==============================
FILE: ${file.originalFilename}
==============================

${text}

`;
      }

      if (extraText.trim()) {
        combinedText += `
==============================
USER PROVIDED TEXT
==============================

${extraText}
`;
      }

      if (!combinedText.trim()) {
        return res.status(400).json({
          message: "No readable content extracted",
        });
      }

      /* ================================
         LOAD SCHEMA
      ================================ */
      const schema = loadSchema();

      const schemaPrompt = schema
        .map(
          r =>
            `Field: ${r["Field Name"]}
Key: ${r["Mapping Key"]}
Instruction: ${r["What to Enter"]}`
        )
        .join("\n\n");

      /* ================================
         AI EXTRACTION (SINGLE REQUEST)
      ================================ */
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

FIELD TYPE RULES:
- Text fields → string
- Checkbox fields → true or false
- Radio fields → exact option value

SCHEMA:
${schemaPrompt}

DOCUMENT:
${combinedText}
`,
              },
            ],
          }),
        }
      );

      const aiData = await aiResponse.json();

      let extracted;

try {
  const textOutput = aiData.output
    ?.flatMap(o => o.content)
    ?.find(c => c.type === "output_text")
    ?.text;

  if (!textOutput) {
    console.error("No output_text found:", aiData);
    throw new Error("Missing AI output");
  }

  extracted = JSON.parse(textOutput);
} catch (e) {
  console.error("AI PARSE ERROR:", e);
  console.error(aiData);
  return res.status(500).json({
    message: "AI returned invalid JSON",
  });
}


      // Drop empty values
      Object.keys(extracted).forEach(k => {
        if (extracted[k] === "" || extracted[k] == null) {
          delete extracted[k];
        }
      });

      /* ================================
         FILL ACORD 25 PDF (TEXT + CHECKBOX + RADIO)
      ================================ */
      const templatePath = path.join(
        process.cwd(),
        "public/templates/ACORD_0025_2016-03_Acroform.pdf"
      );

      

      const pdfTemplate = fs.readFileSync(templatePath);
      const pdfDoc = await PDFDocument.load(pdfTemplate);
      const pdfForm = pdfDoc.getForm();

      let filledCount = 0;
const missingFields = [];

for (const key in extracted) {
  const value = extracted[key];
  let filled = false;

  // 1️⃣ Text field
  try {
    pdfForm.getTextField(key).setText(String(value));
    filled = true;
  } catch {}

  // 2️⃣ Checkbox
  if (!filled) {
    try {
      const checkbox = pdfForm.getCheckBox(key);
      isTruthy(value) ? checkbox.check() : checkbox.uncheck();
      filled = true;
    } catch {}
  }

  // 3️⃣ Radio group
  if (!filled) {
    try {
      const radio = pdfForm.getRadioGroup(key);
      radio.select(String(value));
      filled = true;
    } catch {}
  }

  if (filled) {
    filledCount++;
  } else {
    missingFields.push(key);
  }
}

console.log("✅ Filled fields count:", filledCount);
console.log("⚠️ Fields not found in PDF:", missingFields);


      for (const key in extracted) {
        const value = extracted[key];

        // 1️⃣ Text field
        try {
          pdfForm.getTextField(key).setText(String(value));
          continue;
        } catch {}

        // 2️⃣ Checkbox
        try {
          const checkbox = pdfForm.getCheckBox(key);
          isTruthy(value) ? checkbox.check() : checkbox.uncheck();
          continue;
        } catch {}

        // 3️⃣ Radio group
        try {
          const radio = pdfForm.getRadioGroup(key);
          radio.select(String(value));
          continue;
        } catch {}

        // Ignore unsupported fields
      }

      pdfForm.flatten();

      const finalPdfBytes = await pdfDoc.save();

      /* ================================
         RETURN PDF
      ================================ */
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="ACORD_25_Filled.pdf"'
      );

      res.send(Buffer.from(finalPdfBytes));
    } catch (e) {
      console.error("PROCESS ERROR:", e);
      res.status(500).json({
        message: "Processing failed",
      });
    }
  });
}
