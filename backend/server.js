import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Load .env from parent directory
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.BACKEND_PORT || 3001;
const LEONARDO_API_KEY = process.env.LEONARDO_API_KEY;
const LEONARDO_BASE = "https://cloud.leonardo.ai/api/rest/v1";

if (!LEONARDO_API_KEY) {
  console.error("❌  LEONARDO_API_KEY is missing. Copy .env.example to .env and add your key.");
  process.exit(1);
}

app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── POST /api/generate ─────────────────────────────────────────────────────
// Starts a Leonardo generation job and returns the generationId.
app.post("/api/generate", async (req, res) => {
  const { modelId, prompt, width, height, num_images = 1, quality } = req.body;

  if (!prompt) {
    return res.status(400).json({ message: "prompt is required" });
  }

  // Map quality to Leonardo's guidance scale / alchemy settings
  const qualitySettings = {
    low:    { alchemy: false, guidance_scale: 7,  num_inference_steps: 15 },
    medium: { alchemy: true,  guidance_scale: 7,  num_inference_steps: 25 },
    high:   { alchemy: true,  guidance_scale: 8,  num_inference_steps: 40 },
  };
  const qs = qualitySettings[quality] || qualitySettings.medium;

  try {
    const response = await fetch(`${LEONARDO_BASE}/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${LEONARDO_API_KEY}`,
      },
      body: JSON.stringify({
        modelId: modelId || "b24e16ff-06e3-43eb-8d33-4416c2d75876",
        prompt,
        width: width || 1024,
        height: height || 1024,
        num_images: Math.min(num_images, 4),
        presetStyle: "DYNAMIC",
        ...qs,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Leonardo error:", data);
      return res.status(response.status).json({
        message: data?.error || "Leonardo API error",
      });
    }

    const generationId = data?.sdGenerationJob?.generationId;
    if (!generationId) {
      return res.status(500).json({ message: "No generationId returned from Leonardo" });
    }

    console.log(`✓ Generation started: ${generationId}`);
    return res.json({ generationId });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/generation/:id ─────────────────────────────────────────────────
// Polls Leonardo for the status of a generation job.
app.get("/api/generation/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const response = await fetch(`${LEONARDO_BASE}/generations/${id}`, {
      headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` },
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        message: data?.error || "Leonardo API error",
      });
    }

    const gen = data?.generations_by_pk;
    console.log(`  Poll ${id}: ${gen?.status} (${gen?.generated_images?.length || 0} images)`);

    return res.json(data);
  } catch (err) {
    console.error("Poll error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/library ────────────────────────────────────────────────────────
// Returns the authenticated user's recent generation history.
app.get("/api/library", async (req, res) => {
  const limit  = Math.min(parseInt(req.query.limit  || "40", 10), 100);
  const offset = parseInt(req.query.offset || "0", 10);

  try {
    // Step 1: resolve user id from the API key
    const meRes = await fetch(`${LEONARDO_BASE}/me`, {
      headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` },
    });
    const meData = await meRes.json();
    const userId = meData?.user_details?.[0]?.user?.id;
    if (!userId) {
      console.error("Could not resolve user id:", meData);
      return res.status(500).json({ message: "Could not resolve Leonardo user id" });
    }

    // Step 2: fetch generation history
    const histRes = await fetch(
      `${LEONARDO_BASE}/generations/user/${userId}?offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` } }
    );
    const histData = await histRes.json();

    if (!histRes.ok) {
      return res.status(histRes.status).json({ message: histData?.error || "Leonardo API error" });
    }

    // Flatten to a simple list of images with metadata
    const generations = histData?.generations || [];
    const images = [];
    for (const gen of generations) {
      for (const img of gen.generated_images || []) {
        images.push({
          id:        img.id,
          url:       img.url,
          prompt:    gen.prompt,
          width:     gen.width,
          height:    gen.height,
          modelId:   gen.modelId,
          createdAt: gen.createdAt,
        });
      }
    }

    console.log(`✓ Library: returned ${images.length} images (offset=${offset})`);
    return res.json({ images, total: images.length });
  } catch (err) {
    console.error("Library error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/models ─────────────────────────────────────────────────────────
// Returns available Leonardo platform models (optional, for dynamic model list).
app.get("/api/models", async (_req, res) => {
  try {
    const response = await fetch(`${LEONARDO_BASE}/platformModels`, {
      headers: { Authorization: `Bearer ${LEONARDO_API_KEY}` },
    });
    const data = await response.json();
    return res.json(data);
  } catch (err) {
    return res.status(500).json({ message: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`\n🚀  Leonardo proxy running on http://localhost:${PORT}`);
  console.log(`   API key: ${LEONARDO_API_KEY.slice(0, 8)}...${LEONARDO_API_KEY.slice(-4)}`);
  console.log(`\n   Endpoints:`);
  console.log(`   POST /api/generate     — start a generation`);
  console.log(`   GET  /api/generation/:id — poll for results`);
  console.log(`   GET  /api/models        — list available models\n`);
});
