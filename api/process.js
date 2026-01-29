import formidable from "formidable";
import fs from "fs";
import path from "path";
import pdf from "pdf-parse";
import XLSX from "xlsx";
import mammoth from "mammoth";
import { PDFDocument } from "pdf-lib";

export const config = {
  api: { bodyParser: false },
};

/* ================================
   HELPERS
================================ */
function isTruthy(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["true", "yes", "checked", "1"].includes(value.toLowerCase());
  }
  return false;
}

/* ================================
   LOAD SCHEMA
================================ */
function loadSchema() {
  const schemaPath = path.join(
    process.cwd(),
    "public/schema/Mapping schema.xlsx"
  );

  console.log("📄 Loading schema:", schemaPath);

  const workbook = XLSX.readFile(schemaPath);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const schema = XLSX.utils.sheet_to_json(sheet);

  console.log("📊 Schema rows:", schema.length);
  return schema;
}

/* ================================
   EXTRACT TEXT (NO OCR)
================================ */
async function extractTextFromFile(file) {
  const buffer = fs.readFileSync(file.filepath);
  const name = file.originalFilename.toLowerCase();

  console.log("📥 Extracting:", name);

  if (name.endsWith(".txt")) {
    return buffer.toString("utf8");
  }

  if (name.endsWith(".pdf")) {
    const pdfData = await pdf(buffer);
    return pdfData.text || "";
  }

  if (name.endsWith(".docx") || name.endsWith(".doc")) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value || "";
  }

  if (name.endsWith(".xls") || name.endsWith(".xlsx")) {
    const workbook = XLSX.read(buffer);
    let text = "";

    for (const sheetName of workbook.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(
        workbook.Sheets[sheetName],
        { header: 1 }
      );
      rows.forEach(r => r.length && (text += r.join(" | ") + "\n"));
    }
    return text;
  }

  throw new Error(`Unsupported file type: ${name}`);
}

/* ================================
   API HANDLER
================================ */
export default async function handler(req, res) {
  console.log("🚀 /api/process hit");

  if (req.method !== "POST") {
    return res.status(405).json({ message: "POST only" });
  }

  console.log("🔐 OpenAI key exists:", Boolean(process.env.Acord25));

  const form = formidable({
    multiples: true,
    maxFileSize: 10 * 1024 * 1024,
  });

  form.parse(req, async (err, fields, files) => {
    try {
      if (err) throw err;

      const uploadedFiles = files.file
        ? Array.isArray(files.file)
          ? files.file
          : [files.file]
        : [];

      console.log("📎 Uploaded files:", uploadedFiles.length);

      let combinedText = "";

      for (const file of uploadedFiles) {
        const text = await extractTextFromFile(file);
        combinedText += `\n--- ${file.originalFilename} ---\n${text}\n`;
      }

      if (fields.text?.trim()) {
        combinedText += `\n--- USER TEXT ---\n${fields.text}\n`;
      }

      console.log("🧾 Combined text length:", combinedText.length);

      if (!combinedText.trim()) {
        return res.status(400).json({ message: "No readable content" });
      }

      /* ================================
         SCHEMA
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
         OPENAI
      ================================ */
      console.log("🧠 Sending request to OpenAI");

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
                  "Extract insurance data. Never guess. Return valid JSON only.",
              },
              {
                role: "user",
                content: `
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

      console.log("🧠 OpenAI status:", aiResponse.status);

      const aiData = await aiResponse.json();

      const textOutput =
        aiData?.output?.[0]?.content?.find(c => c.type === "output_text")
          ?.text;

      if (!textOutput) {
        console.error("❌ No AI output text", aiData);
        return res.status(500).json({ message: "AI failed" });
      }

      let extracted;
      try {
        extracted = JSON.parse(textOutput);
      } catch (e) {
        console.error("❌ JSON parse failed", textOutput);
        return res.status(500).json({ message: "Invalid AI JSON" });
      }

      console.log("✅ Extracted fields:", Object.keys(extracted).length);

      /* ================================
         PDF FILL
      ================================ */
      const templatePath = path.join(
        process.cwd(),
        "public/templates/ACORD_0025_2016-03_Acroform.pdf"
      );

      const pdfDoc = await PDFDocument.load(
        fs.readFileSync(templatePath)
      );
      const pdfForm = pdfDoc.getForm();

      let filled = 0;
      let missing = [];

      for (const key in extracted) {
        const val = extracted[key];
        let done = false;

        try {
          pdfForm.getTextField(key).setText(String(val));
          done = true;
        } catch {}

        if (!done) {
          try {
            const cb = pdfForm.getCheckBox(key);
            isTruthy(val) ? cb.check() : cb.uncheck();
            done = true;
          } catch {}
        }

        if (!done) {
          try {
            pdfForm.getRadioGroup(key).select(String(val));
            done = true;
          } catch {}
        }

        done ? filled++ : missing.push(key);
      }

      console.log("✅ Filled fields:", filled);
      console.log("⚠️ Missing fields:", missing);

      pdfForm.flatten();
      const bytes = await pdfDoc.save();

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="ACORD_25_Filled.pdf"'
      );
      res.send(Buffer.from(bytes));
    } catch (e) {
      console.error("🔥 PROCESS ERROR:", e);
      res.status(500).json({ message: "Processing failed" });
    }
  });
}
