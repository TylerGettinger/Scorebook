// Vercel serverless function: POST /api/recap
// Keeps the Anthropic API key server-side. Set ANTHROPIC_API_KEY in Vercel's
// environment variables (Project → Settings → Environment Variables).

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: "ANTHROPIC_API_KEY is not set on the server." });
    return;
  }

  const { teamName, opponent, date, ourScore, theirScore, boxscore } = req.body || {};

  const prompt = `Write a warm, upbeat 150-220 word hometown-newspaper-style youth softball game recap. Plain text only, no markdown, no headline.
Team: ${teamName || "Our Team"}
Opponent: ${opponent || "the opponent"}
Date: ${date || ""}
Final score: ${teamName || "Us"} ${ourScore ?? "?"} - ${opponent || "them"} ${theirScore ?? "?"}
Box score:
${boxscore || ""}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1000,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      res.status(response.status).json({ error: data.error?.message || "Anthropic API error" });
      return;
    }
    const text = (data.content || []).map((b) => b.text || "").join("\n").trim();
    res.status(200).json({ report: text });
  } catch (e) {
    res.status(500).json({ error: "Failed to reach Anthropic API" });
  }
}
