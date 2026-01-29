import formidable from "formidable";

export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  console.log("✅ FUNCTION STARTED");
  console.log("📦 formidable loaded");

  const form = formidable();

  form.parse(req, (err) => {
    if (err) {
      console.error("❌ formidable error:", err);
      return res.status(500).json({ error: "formidable failed" });
    }

    res.status(200).json({
      ok: true,
      message: "formidable works",
    });
  });
}
