export default async function handler(req, res) {
  console.log("✅ FUNCTION STARTED");

  res.status(200).json({
    ok: true,
    message: "API is running",
  });
}
