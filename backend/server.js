import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
// import Anthropic from "@anthropic-ai/sdk"; // swap back when ANTHROPIC_API_KEY is available

// Load .env from parent directory
const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, "..", ".env") });

const app = express();
const PORT = process.env.BACKEND_PORT || 3001;
const LEONARDO_API_KEY = process.env.LEONARDO_API_KEY;
const LEONARDO_BASE    = "https://cloud.leonardo.ai/api/rest/v1";
const LEONARDO_V2_BASE = "https://cloud.leonardo.ai/api/rest/v2";

// Anthropic client placeholder — swap back in when ANTHROPIC_API_KEY is available
// const anthropic = process.env.ANTHROPIC_API_KEY
//   ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
//   : null;

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
// Returns the uploaded image id to use in guidances.image_reference.
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
// Starts a Leonardo V2 generation job via the REST v2 endpoint.
//
// V2 REST endpoint: POST https://cloud.leonardo.ai/api/rest/v2/generations
// Body: { model: "gpt-image-2", public: false, parameters: { prompt, width, height, quantity, quality?, guidances? } }
//
// V2 model string IDs:
//   gpt-image-2       GPT Image 2       (quality: LOW/MEDIUM/HIGH; no ref strength)
//   gemini-image-2    Nano Banana Pro   (grid dims; ref strength: LOW/MID/HIGH)
//   seedream-4.5      Seedream 4.5      (mod-8, 512-4096; ref strength)
//   flux-2-pro        Flux.2 Pro        (mod-8, 256-1440; ref strength)

// Models where quality param (LOW/MEDIUM/HIGH) is supported
const MODELS_WITH_QUALITY = new Set(["gpt-image-2", "gpt-image-1.5", "ideogram-v3.0"]);

// Models that support image_reference strength inside guidances
// GPT Image 2 does NOT use strength — omit it for that model
const MODELS_WITH_REF_STRENGTH = new Set(["gemini-image-2", "seedream-4.5", "seedream-4.0", "flux-2-pro", "ideogram-v3.0"]);

app.post("/api/generate", async (req, res) => {
  const { modelId, prompt, width, height, num_images = 1, quality, refImages, refImageIds } = req.body;
  const apiKey = resolveKey(req);

  if (!prompt) {
    return res.status(400).json({ message: "prompt is required" });
  }

  // Upload base64 reference images (from computer)
  const uploadedRefIds = [];
  if (refImages && refImages.length > 0) {
    for (const dataUrl of refImages) {
      try {
        const id = await uploadInitImage(dataUrl, apiKey);
        uploadedRefIds.push(id);
        console.log(`✓ Ref image uploaded: ${id}`);
      } catch (e) {
        console.error("Ref image upload failed:", e.message);
        // Non-fatal — skip this ref image
      }
    }
  }

  // Build quality param — only for models that support it
  const qualityMap = { low: "LOW", medium: "MEDIUM", high: "HIGH" };
  const qualityParam = MODELS_WITH_QUALITY.has(modelId)
    ? (qualityMap[quality] || "MEDIUM")
    : undefined;

  // Build guidances.image_reference combining uploaded + existing library images
  const hasRefStrength = MODELS_WITH_REF_STRENGTH.has(modelId);
  const allRefEntries = [
    ...uploadedRefIds.map(id => ({
      image: { id, type: "UPLOADED" },
      ...(hasRefStrength ? { strength: "MID" } : {}),
    })),
    ...(refImageIds || []).map((id) => ({
      image: { id, type: "GENERATED" },
      ...(hasRefStrength ? { strength: "MID" } : {}),
    })),
  ];
  const guidances = allRefEntries.length > 0
    ? { image_reference: allRefEntries }
    : undefined;

  try {
    const parameters = {
      prompt,
      width:    width  || 1024,
      height:   height || 1024,
      quantity: Math.min(num_images, 4),
      ...(qualityParam ? { quality: qualityParam } : {}),
      ...(guidances    ? { guidances }              : {}),
    };

    const body = {
      model:  modelId,
      public: false,
      parameters,
    };

    console.log(`  [DEBUG] V2 REST — model: ${modelId}, dims: ${parameters.width}x${parameters.height}, qty: ${parameters.quantity}${qualityParam ? `, quality: ${qualityParam}` : ""}${uploadedRefIds.length ? `, refs: ${uploadedRefIds.length}` : ""}`);

    const response = await fetch(`${LEONARDO_V2_BASE}/generations`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });

    const data = await response.json();

    if (!response.ok) {
      const errMsg = data?.message || data?.error || `Leonardo API error (${response.status})`;
      console.error(`  [DEBUG] V2 error (${response.status}):`, JSON.stringify(data));
      return res.status(response.status).json({ message: errMsg, debug: data });
    }

    // V2 REST response wraps result in a "generate" object: { generate: { generationId, apiCreditCost, cost } }
    const generationId = data?.generate?.generationId || data?.generationId;
    if (!generationId) {
      console.error(`  [DEBUG] Unexpected V2 response:`, JSON.stringify(data));
      return res.status(500).json({ message: "No generationId returned from Leonardo", debug: data });
    }

    console.log(`✓ Generation started: ${generationId}`);
    return res.json({ generationId });
  } catch (err) {
    console.error("Generate error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/generation/:id ─────────────────────────────────────────────────
// Polls Leonardo for the status of a generation job (v1 polling endpoint).
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

// ─── GET /api/balance ────────────────────────────────────────────────────────
// Returns the authenticated user's API credit balance.
// Returns ALL credit-related fields so the frontend can find the right one
// regardless of which Leonardo plan type the user has.
app.get("/api/balance", async (req, res) => {
  const apiKey = req.headers["x-leo-api-key"] || LEONARDO_API_KEY;

  try {
    const meRes = await fetch(`${LEONARDO_BASE}/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const meData = await meRes.json();
    const details = meData?.user_details?.[0];

    if (!details) {
      console.error("[balance] no user_details in response:", JSON.stringify(meData));
      return res.status(500).json({ message: "Could not resolve user details" });
    }

    // Return every field Leonardo might use for credits — frontend picks the first non-null
    return res.json({
      apiCredit:            details.apiCredit            ?? null,
      apiCreditBalance:     details.apiCreditBalance     ?? null,
      apiPaidTokens:        details.apiPaidTokens        ?? null,
      apiSubscriptionTokens: details.apiSubscriptionTokens ?? null,
      tokenBalance:         details.tokenBalance         ?? null,
      credits:              details.credits              ?? null,
      userApiCredit:        details.user?.apiCredit      ?? null,
      tokenRenewalDate:     details.user?.tokenRenewalDate ?? details.tokenRenewalDate ?? null,
    });
  } catch (err) {
    console.error("[balance] error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/test-key ───────────────────────────────────────────────────────
// Returns the FULL raw /me response for the user's API key.
// Used by the Settings tab "Test Connection" button for diagnostics.
app.get("/api/test-key", async (req, res) => {
  const apiKey = req.headers["x-leo-api-key"];
  if (!apiKey) {
    return res.status(400).json({ error: "No API key provided. Set x-leo-api-key header." });
  }
  try {
    const meRes = await fetch(`${LEONARDO_BASE}/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const meData = await meRes.json();
    const details = meData?.user_details?.[0];
    console.log("[test-key] raw user_details[0]:", JSON.stringify(details, null, 2));
    return res.json({
      httpStatus: meRes.status,
      userId:     details?.user?.id ?? null,
      username:   details?.user?.username ?? null,
      // All credit-related fields returned as-is
      creditFields: {
        apiCredit:            details?.apiCredit            ?? null,
        apiCreditBalance:     details?.apiCreditBalance     ?? null,
        apiPaidTokens:        details?.apiPaidTokens        ?? null,
        apiSubscriptionTokens: details?.apiSubscriptionTokens ?? null,
        tokenBalance:         details?.tokenBalance         ?? null,
        credits:              details?.credits              ?? null,
      },
      // Dump everything so nothing is hidden
      rawDetails: details ?? null,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/collections ────────────────────────────────────────────────────
// Returns the authenticated user's personal collections.
// Tries /personal-collections first; falls back to /datasets (some plan types).
app.get("/api/collections", async (req, res) => {
  const apiKey = resolveKey(req);
  try {
    const response = await fetch(`${LEONARDO_BASE}/personal-collections`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const raw = await response.text();
    console.log(`[collections] HTTP ${response.status} — raw: ${raw.slice(0, 500)}`);

    let data;
    try { data = JSON.parse(raw); } catch { data = {}; }

    if (!response.ok) {
      return res.status(response.status).json({
        message: data?.message || data?.error || `Leonardo returned ${response.status}`,
        debug: data,
      });
    }

    // Normalize across possible response shapes
    const collections =
      data?.personal_collections ||
      data?.collections ||
      (Array.isArray(data) ? data : []);

    console.log(`✓ Collections: returned ${collections.length} collections`);
    return res.json({ collections, _raw: data });
  } catch (err) {
    console.error("Collections error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/collections ───────────────────────────────────────────────────
// Creates a new personal collection with the given name.
app.post("/api/collections", async (req, res) => {
  const { name } = req.body;
  const apiKey = resolveKey(req);
  if (!name) return res.status(400).json({ message: "name is required" });
  try {
    const response = await fetch(`${LEONARDO_BASE}/personal-collections`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ name }),
    });
    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json({ message: data?.message || data?.error || "Leonardo API error" });
    }
    const created = data?.insert_personal_collections_one || data?.collection || data;
    console.log(`✓ Created collection: "${name}"`);
    return res.json({ collection: created });
  } catch (err) {
    console.error("Create collection error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── POST /api/collections/:collectionId/generations/:generationId ───────────
// Adds a generation to a personal collection.
app.post("/api/collections/:collectionId/generations/:generationId", async (req, res) => {
  const { collectionId, generationId } = req.params;
  const apiKey = resolveKey(req);
  try {
    const response = await fetch(
      `${LEONARDO_BASE}/personal-collections/${collectionId}/generations/${generationId}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ message: data?.message || data?.error || "Leonardo API error" });
    }
    console.log(`✓ Added generation ${generationId} to collection ${collectionId}`);
    return res.json({ added: true });
  } catch (err) {
    console.error("Add to collection error:", err);
    return res.status(500).json({ message: err.message });
  }
});

// ─── DELETE /api/collections/:collectionId/generations/:generationId ─────────
// Removes a generation from a personal collection.
app.delete("/api/collections/:collectionId/generations/:generationId", async (req, res) => {
  const { collectionId, generationId } = req.params;
  const apiKey = resolveKey(req);
  try {
    const response = await fetch(
      `${LEONARDO_BASE}/personal-collections/${collectionId}/generations/${generationId}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${apiKey}` },
      }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({ message: data?.message || data?.error || "Leonardo API error" });
    }
    console.log(`✓ Removed generation ${generationId} from collection ${collectionId}`);
    return res.json({ removed: true });
  } catch (err) {
    console.error("Remove from collection error:", err);
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

// ─── POST /api/magic-prompt ──────────────────────────────────────────────────
// Reads slide text from the Canva app, calls Gemini Flash to generate a
// Leonardo image prompt tailored to the selected model.
// Requires GEMINI_API_KEY env var.
// To swap to Anthropic later: replace the geminiGenerate() call with the
// Anthropic SDK call (see commented block below) and set ANTHROPIC_API_KEY.
const MODEL_STYLE_HINTS = {
  "gpt-image-2":    "photorealistic photography with rich detail and precise lighting",
  "gemini-image-2": "vibrant, painterly illustration with expressive color",
  "seedream-4.5":   "cinematic digital art with atmospheric depth",
  "flux-2-pro":     "crisp, high-fidelity professional imagery",
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

async function geminiGenerate(systemText, userText) {
  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      maxOutputTokens: 512,
      temperature: 0.9,
      thinkingConfig: { thinkingBudget: 0 },  // disable reasoning tokens — we want the full response as the prompt
    },
  };
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error?.message || `Gemini error ${res.status}`);
  }
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "";
}

app.post("/api/magic-prompt", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      message: "Spark Prompt requires GEMINI_API_KEY — add it to your Render environment variables.",
    });
  }

  const { slideText = "", modelId = "gpt-image-2", promptStyle = "Photography" } = req.body;
  const styleHint = MODEL_STYLE_HINTS[modelId] || "photorealistic, high-quality imagery";

  const system = `You are a creative director specialising in AI image generation prompts for Leonardo.AI. Your output is sent directly to the ${modelId} model, which excels at ${styleHint}.

The user has selected the visual style category: "${promptStyle}". The generated prompt MUST be in this style.

Rules:
- Write a single descriptive paragraph, 50–120 words
- Translate abstract ideas into concrete visual details: lighting, composition, colour palette, mood, textures
- Reflect the chosen style category clearly (e.g. for Photography: mention camera, lens, lighting; for Illustration: mention medium, linework, palette; for 3D / CGI: mention render engine, materials, lighting setup)
- Mention the style/medium explicitly at the end of the prompt
- Do NOT include explanation or preamble — return only the raw image prompt`;

  const user = slideText.trim()
    ? `The current Canva slide contains this text:\n\n"${slideText.trim()}"\n\nWrite a Leonardo image prompt that visually represents this content.`
    : `The current slide has no text. Write a polished, versatile Leonardo image prompt suitable for a professional presentation background.`;

  try {
    const prompt = await geminiGenerate(system, user);
    if (!prompt) return res.status(500).json({ message: "No prompt returned by Gemini" });
    console.log(`✓ Spark Prompt generated (${prompt.length} chars, model: ${modelId})`);
    return res.json({ prompt });
  } catch (err) {
    console.error("Spark Prompt error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, version: "v2-rest-15", endpoint: "cloud.leonardo.ai/api/rest/v2" }));

app.listen(PORT, () => {
  console.log(`\n🚀  Leonardo proxy running on http://localhost:${PORT}`);
  console.log(`   API key: ${LEONARDO_API_KEY.slice(0, 8)}...${LEONARDO_API_KEY.slice(-4)}`);
  console.log(`\n   Endpoints:`);
  console.log(`   POST /api/generate       — start a V2 generation`);
  console.log(`   GET  /api/generation/:id — poll for results`);
  console.log(`   GET  /api/models         — list available models\n`);
});
