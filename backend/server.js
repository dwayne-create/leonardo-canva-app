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

// Helper: resolve the API key to use — user-supplied key takes priority
function resolveKey(req) {
  return req.headers["x-leo-api-key"] || LEONARDO_API_KEY;
}

if (!LEONARDO_API_KEY) {
  console.error("❌  LEONARDO_API_KEY is missing. Copy .env.example to .env and add your key.");
  process.exit(1);
}

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "25mb" })); // allow large base64 payloads

// ─── Helper: upload a base64 image to Leonardo as an init-image ──────────────
// Returns the init_image id to use in a generation request.
async function uploadInitImage(base64DataUrl, apiKey) {
  const matches = base64DataUrl.match(/^data:([A-Za-z-+/]+);base64,(.+)$/);
  if (!matches) throw new Error("Invalid image data URL");
  const mimeType = matches[1];
  const base64Data = matches[2];
  const buffer = Buffer.from(base64Data, "base64");
  const ext = mimeType.includes("png") ? "png" : "jpg";

  // Step 1 — ask Leonardo for a presigned S3 upload URL
  const initRes = await fetch(`${LEONARDO_BASE}/init-image`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ extension: ext }),
  });
  const initData = await initRes.json();
  const { id, url, fields } = initData.uploadInitImage;

  // Step 2 — upload the image to S3 using the presigned URL
  const form = new FormData();
  const parsedFields = JSON.parse(fields);
  for (const [k, v] of Object.entries(parsedFields)) form.append(k, v);
  form.append("file", new Blob([buffer], { type: mimeType }));
  await fetch(url, { method: "POST", body: form });

  return id;
}

// ─── POST /api/generate ─────────────────────────────────────────────────────
// Starts a Leonardo generation job and returns the generationId.
// Real Leonardo model IDs — fallback if a placeholder or unknown ID is passed
const MODEL_ID_MAP = {
  "phoenix-1.0":        "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3",
  "flux-kontext":       "28aeddf8-bd19-4803-80fc-79602d1a9989",
  "flux-dev":           "b2614463-296c-462a-9586-aafdb8f00e36",
  "lucid-realism":      "05ce0082-2d80-4a2d-8653-4d1c85e2418e",
};
const DEFAULT_MODEL = "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3"; // Phoenix 1.0

function resolveModelId(id) {
  // If it's a known short key, map it
  if (MODEL_ID_MAP[id]) return MODEL_ID_MAP[id];
  // If it looks like a real UUID (8-4-4-4-12), use it as-is
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  // Otherwise it's a placeholder — fall back to default
  return DEFAULT_MODEL;
}

app.post("/api/generate", async (req, res) => {
  const { modelId, prompt, width, height, num_images = 1, quality, refImages } = req.body;
  const apiKey = resolveKey(req);

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

  // Upload first reference image as init-image if provided
  let init_image_id = null;
  if (refImages && refImages.length > 0) {
    try {
      init_image_id = await uploadInitImage(refImages[0], apiKey);
      console.log(`✓ Init image uploaded: ${init_image_id}`);
    } catch (e) {
      console.error("Init image upload failed:", e.message);
      // Non-fatal — generate without the reference image
    }
  }

  try {
    const response = await fetch(`${LEONARDO_BASE}/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        modelId: resolveModelId(modelId),
        prompt,
        width:      width  || 1024,
        height:     height || 1024,
        num_images: Math.min(num_images, 4),
        presetStyle: "DYNAMIC",
        ...(init_image_id ? { init_image_id, init_strength: 0.45 } : {}),
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
  const apiKey = resolveKey(req);

  try {
    const response = await fetch(`${LEONARDO_BASE}/generations/${id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
  const apiKey = resolveKey(req);

  try {
    // Step 1: resolve user id from the API key
    const meRes = await fetch(`${LEONARDO_BASE}/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
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
      { headers: { Authorization: `Bearer ${apiKey}` } }
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
          id:           img.id,
          generationId: gen.id,
          url:          img.url,
          prompt:       gen.prompt,
          width:        gen.width,
          height:       gen.height,
          modelId:      gen.modelId,
          createdAt:    gen.createdAt,
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

// ─── DELETE /api/generation/:id ──────────────────────────────────────────────
// Permanently deletes a generation (and all its images) from Leonardo.
app.delete("/api/generation/:id", async (req, res) => {
  const { id } = req.params;
  const apiKey = resolveKey(req);

  try {
    const response = await fetch(`${LEONARDO_BASE}/generations/${id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiKey}` },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return res.status(response.status).json({ message: data?.error || "Leonardo API error" });
    }

    console.log(`✓ Deleted generation: ${id}`);
    return res.json({ deleted: true });
  } catch (err) {
    console.error("Delete error:", err);
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
