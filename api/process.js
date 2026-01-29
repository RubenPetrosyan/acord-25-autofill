export const config = {
  api: { bodyParser: false },
};

export default async function handler(req, res) {
  console.log("🚀 /api/process invoked");

  if (req.method !== "POST") {
    return res.status(405).json({ message: "POST only" });
  }

  /* ================================
     ENV CHECK
  ================================ */
  console.log("🔑 OPENAI_API_KEY exists:", Boolean(process.env.OPENAI_API_KEY));

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY IS MISSING");
    return res.status(500).json({
      ok: false,
      error: "Missing OPENAI_API_KEY",
    });
  }

  /* ================================
     OPENAI CONNECTIVITY TEST
  ================================ */
  let response;
  let bodyText;

  try {
    console.log("🧠 Sending test request to OpenAI…");

    response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: "Return exactly this JSON: {\"status\":\"ok\"}",
      }),
    });

    console.log("🧠 OpenAI HTTP status:", response.status);

  } catch (err) {
    console.error("❌ NETWORK ERROR calling OpenAI:", err);
    return res.status(500).json({
      ok: false,
      error: "Network error calling OpenAI",
    });
  }

  try {
    bodyText = await response.text();
    console.log("🧠 OpenAI raw response:", bodyText);
  } catch (err) {
    console.error("❌ FAILED TO READ RESPONSE BODY:", err);
    return res.status(500).json({
      ok: false,
      error: "Failed to read OpenAI response body",
    });
  }

  /* ================================
     FINAL RESPONSE
  ================================ */
  return res.status(200).json({
    ok: true,
    openaiStatus: response.status,
    rawResponse: bodyText,
  });
}
