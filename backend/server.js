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
  const targetImages = Math.min(parseInt(req.query.limit || "40", 10), 360);
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

    // Step 2: paginate Leonardo — API hard-caps at 50 generations per request.
    // Increment offset by actual generations returned each loop to avoid skipping.
    const BATCH = 50;
    const images = [];
    let genOffset = 0;

    while (images.length < targetImages) {
      const histRes = await fetch(
        `${LEONARDO_BASE}/generations/user/${userId}?offset=${genOffset}&limit=${BATCH}`,
        { headers: { Authorization: `Bearer ${apiKey}` } }
      );
      const histData = await histRes.json();

      if (!histRes.ok) {
        return res.status(histRes.status).json({ message: histData?.error || "Leonardo API error" });
      }

      const generations = histData?.generations || [];
      if (generations.length === 0) break; // no more history

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
          if (images.length >= targetImages) break;
        }
        if (images.length >= targetImages) break;
      }

      // Advance by actual count returned; stop if we got a short page (end of history)
      genOffset += generations.length;
      if (generations.length < BATCH) break;
    }

    console.log(`✓ Library: returned ${images.length} images (batches from offset 0..${genOffset})`);
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

// slideImageB64: optional raw base64 JPEG string (no data: prefix) from user screenshot paste
async function geminiGenerate(systemText, userText, maxTokens = 2000, slideImageB64 = null) {
  // Build user parts — prepend slide image if provided
  const userParts = [];
  if (slideImageB64) {
    userParts.push({ inline_data: { mime_type: "image/jpeg", data: slideImageB64 } });
    userParts.push({ text: userText });
  } else {
    userParts.push({ text: userText });
  }

  const body = {
    system_instruction: { parts: [{ text: systemText }] },
    contents: [{ role: "user", parts: userParts }],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: 0.9,
      thinkingConfig: { thinkingBudget: 0 },
      // thinkingBudget:0 — forces ALL reasoning into the output text.
      // With thinking enabled, Gemini does the work internally then produces a brief output summary.
      // With thinking disabled, Gemini writes out every step in full — step4Match then carves out
      // just the Step 4 content, which is richer and more complete.
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
  const parts = data.candidates?.[0]?.content?.parts || [];
  let result = parts.map(p => p.text || "").join("").trim();

  // Strip any trailing metadata Gemini appends (word counts, char counts, "Note: ...")
  result = result
    .replace(/,?\s*\d+\s+(?:words?|characters?|chars?)\s*\.?\s*$/i, "")
    .replace(/\n+Note:.*$/is, "")
    .trim();

  return result;
}

app.post("/api/magic-prompt", async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.status(503).json({
      message: "Spark Prompt requires GEMINI_API_KEY — add it to your Render environment variables.",
    });
  }

  const { slideText = "", modelId = "gpt-image-2", promptStyle = "Photography", slideImage = null } = req.body;
  const hasSlideImage = typeof slideImage === "string" && slideImage.length > 0;
  console.log(`  Spark Prompt: style=${promptStyle}, slideImage=${hasSlideImage}, slideText="${slideText.slice(0, 60)}..."`);

  const isInfographic   = promptStyle === "Infographic";
  const isMagazineCover = promptStyle === "Magazine Cover";
  const isPrintAd       = promptStyle === "Print Ad";
  const isCanvafyMe     = promptStyle === "Canvafy Me";

  // ── PER-STYLE HINTS ───────────────────────────────────────────────────────
  // One-liner per style — tells Gemini what makes this medium visually distinctive.
  // No rules, no bans. Just the angle.
  const STYLE_HINT = {
    "Photography":          "Shoot it: decisive moment, real scene, lens choice, natural light, depth of field, human truth.",
    "Illustration":         "Draw it: bold editorial scene, expressive characters, graphic storytelling, strong colour contrast.",
    "Magazine Cover":       "Cover it: bold hero image, striking typography space, glossy editorial feel, aspirational mood, newsstand impact.",
    "3D / CGI":             "Render it: impossible materials, surreal precision, perfect lighting, things that can't be photographed.",
    "Cinematic / Film":     "Film it: cinematic shot, colour grade, anamorphic lens, atmosphere, dramatic silhouette.",
    "Abstract":             "Feel it: pure shapes, colour relationships, gestural marks, negative space, emotional tension.",
    "Stylized / Aesthetic": "Style it: dreamlike tones, nostalgic grain, aesthetic movement — vaporwave, brutalism, cottagecore.",
    "Print Ad":             "Sell it: single powerful visual, clean negative space, headline-ready composition, brand-quality polish, ad-grade production.",
    "Graphic Design":       "Design it: bold geometry, Swiss grid, limited palette, strong contrast, poster impact.",
    "Technical":            "Diagram it: cross-section, blueprint, clean linework, annotation style, engineering precision.",
    "Infographic":          "Map it: all real data, clear layout, sections, icons, editorial style, premium design.",
  };

  const styleHint = STYLE_HINT[promptStyle] || `Create a powerful ${promptStyle}-style image.`;

  // ── INFOGRAPHIC SYSTEM ────────────────────────────────────────────────────
  const infographicSystem = `You are an expert infographic designer and Leonardo.AI prompt engineer.

Read the slide content and write a detailed image generation brief for a premium editorial infographic.

Include: all real numbers and stats verbatim, clear section layout, how each data group is visualised (bars, icons, ratios), colour palette, typography style, background.

Output ONLY the brief — no preamble, no explanation. Under 1400 characters.`;

  const infographicUser = slideText.trim()
    ? `${hasSlideImage ? "Slide image is attached above.\n\n" : ""}Slide text:\n"${slideText.trim()}"\n\nWrite the full infographic brief. Include every data point. Output only the brief.`
    : `${hasSlideImage ? "Slide image is attached above.\n\n" : ""}No slide text. Write a clean editorial infographic brief for a professional data presentation.`;

  // ── MAGAZINE COVER SYSTEM ────────────────────────────────────────────────
  const magazineSystem = `You are an award-winning art director at a major design magazine (Wired, Fast Company, Time, Bloomberg Businessweek).

Read the slide content. Your job is to design a REAL magazine cover where the slide's actual words become the editorial content of the magazine — not just the visual mood.

You will output a Leonardo.AI image generation prompt that describes the full cover including rendered text, layout, and hero image.

Use the slide content as follows:
- MASTHEAD: invent a short magazine name that fits the slide's theme (2–4 words, e.g. "SIGNAL", "FUTURE", "WIRED", "CANVAS")
- HEADLINE: take the slide's most powerful claim or title — make it the big bold cover headline. Use the actual words.
- COVER LINES: 3–4 short story teasers pulled directly from the slide's sub-topics, data points, or key names. These appear as smaller text on the cover.
- TAGLINE: a short summary of the slide's thesis (6–10 words), placed near the bottom
- HERO VISUAL: a dramatic photographic or illustrated scene that visually represents the headline

Output format: one comma-separated Leonardo prompt. Include literal text strings in double quotes so Leonardo knows to render them. Describe placement (top, centre, bottom-left, etc.), typography weight (bold, condensed, italic), colour of each text element, and the hero image behind or beside the text. Under 1400 characters. Output the prompt ONLY — no preamble.`;

  const magazineUser = slideText.trim()
    ? `${hasSlideImage ? "Slide image attached above.\n\n" : ""}Slide text:\n"${slideText.trim()}"\n\nDesign the full magazine cover. Use the slide's actual words as real cover copy. Output the Leonardo prompt only.`
    : `${hasSlideImage ? "Slide image attached above.\n\n" : ""}No slide text. Design a premium editorial magazine cover for a professional design or technology publication. Output the Leonardo prompt only.`;

  // ── PRINT AD SYSTEM ───────────────────────────────────────────────────────
  const printAdSystem = `You are a senior creative director at a top advertising agency (Ogilvy, Droga5, Wieden+Kennedy).

Read the slide content. Your job is to design a full-page print advertisement where the slide's actual message, product name, and key claims become the real ad copy in the image.

You will output a Leonardo.AI image generation prompt that describes the complete ad including rendered text, layout, and hero visual.

Use the slide content as follows:
- HEADLINE: the slide's main message rewritten as a powerful ad headline. Bold, short, punchy. Use the actual brand or product name if present.
- BODY LINE: one supporting sentence drawn from the slide's key benefit or data point
- BRAND NAME / LOGO AREA: the product or brand name from the slide, placed prominently (bottom-right or centre)
- CTA: a short call-to-action if appropriate ("Join the future." / "Available now." etc.)
- HERO VISUAL: a single arresting image that makes the headline land harder

Output format: one comma-separated Leonardo prompt. Include literal text strings in double quotes. Describe placement, typography weight, colour, and the hero visual. Under 1400 characters. Output the prompt ONLY — no preamble.`;

  const printAdUser = slideText.trim()
    ? `${hasSlideImage ? "Slide image attached above.\n\n" : ""}Slide text:\n"${slideText.trim()}"\n\nDesign the full-page print ad. Use the slide's actual words as real ad copy. Output the Leonardo prompt only.`
    : `${hasSlideImage ? "Slide image attached above.\n\n" : ""}No slide text. Design a premium full-page print advertisement for a professional technology or design brand. Output the Leonardo prompt only.`;

  // ── CANVAFY ME SYSTEM ────────────────────────────────────────────────────
  const canvafySystem = `You are the world's best art director — the kind who wins D&AD Pencils, Cannes Lions, and One Show Golds. You work at the intersection of Pentagram, Apple's marketing team, and Bloomberg Businessweek's design desk.

Read the slide content carefully. Your job is to produce the single most visually stunning, polished, and professionally executed Leonardo.AI image prompt possible for this content.

Work through three things before writing a single word of output:

1. CHOOSE YOUR MEDIUM — based on what the slide is actually saying, pick the visual approach that would make it most powerful. Could be cinematic photography, editorial illustration, 3D/CGI, bold graphic design, or a deliberate mix. Choose based on what serves the content, not what looks generically impressive.

2. PULL FROM THE CONTENT — use the slide's actual words, concepts, tensions, data points, or names as raw material. The content should inspire the scene, metaphor, colour palette, and composition. Not a literal illustration — an elevated, felt interpretation. If the slide has a strong phrase or claim, it can appear as actual rendered text in the image.

3. DIRECT IT — describe the image as if briefing the world's best photographer, illustrator, or CGI studio. Specify: the precise scene or composition, exact colour palette (real colour names), quality of light, texture, finish, and why every element is there. Nothing accidental.${hasSlideImage ? "\n\nA screenshot of the slide is attached. Use the actual colours, layout, and visual identity you see to inform the palette and mood." : ""}

Output ONLY the Leonardo.AI image prompt — comma-separated descriptors, 400–900 characters, precise and specific, no explanation, no labels. This should be the prompt that produces an image a top creative director would put in their portfolio.`;

  const canvafyUser = slideText.trim()
    ? `${hasSlideImage ? "Slide image attached above.\n\n" : ""}Slide text:\n"${slideText.trim()}"\n\nChoose the best medium, pull from the content, direct it at the highest level. Output the Leonardo prompt only.`
    : `${hasSlideImage ? "Slide image attached above.\n\n" : ""}No slide text. Create a world-class, visually arresting Leonardo.AI prompt for a premium professional presentation. Choose the best medium and direct it at the highest possible level. Output the prompt only.`;

  // ── STANDARD SYSTEM (all other styles) ───────────────────────────────────
  const standardSystem = `You are a world-class creative director and Leonardo.AI prompt engineer.

Read the slide content. Understand the data, insight, and story it tells. Then write the best possible Leonardo.AI image generation prompt for it.

Style selected by the user: ${promptStyle}
${styleHint}

Your prompt must be grounded in what makes ${promptStyle} visually powerful — use what only this style can do.${hasSlideImage ? "\n\nThe user has pasted a screenshot of their slide. Use the actual colours, layout, and visual design you see in the image to inform the prompt." : ""}

If the slide is title-only with no data, mine the literal visual meaning of the words (e.g. "PRISM" → glass prism, light refraction, rainbow spectrum).

Output ONLY the prompt — comma-separated descriptors, 400–900 characters, specific real objects and colours, no explanation, no labels.`;

  const standardUser = slideText.trim()
    ? `${hasSlideImage ? "Slide image attached above.\n\n" : ""}Slide text:\n"${slideText.trim()}"\n\nWrite the Leonardo.AI image prompt. Style: ${promptStyle}. Output the prompt only.`
    : `${hasSlideImage ? "Slide image attached above.\n\n" : ""}No slide text. Write a powerful Leonardo.AI image prompt for a professional presentation background. Style: ${promptStyle}. Output the prompt only.`;

  const system = isInfographic   ? infographicSystem
               : isMagazineCover ? magazineSystem
               : isPrintAd       ? printAdSystem
               : isCanvafyMe     ? canvafySystem
               :                   standardSystem;
  const user   = isInfographic   ? infographicUser
               : isMagazineCover ? magazineUser
               : isPrintAd       ? printAdUser
               : isCanvafyMe     ? canvafyUser
               :                   standardUser;

  const LEONARDO_PROMPT_LIMIT = 1480; // Leonardo caps at ~1500 chars

  try {
    let prompt = await geminiGenerate(system, user, 2000, hasSlideImage ? slideImage : null);
    if (!prompt) return res.status(500).json({ message: "No prompt returned by Gemini" });

    // Truncate at last complete sentence/line if over Leonardo's limit
    if (prompt.length > LEONARDO_PROMPT_LIMIT) {
      prompt = prompt.slice(0, LEONARDO_PROMPT_LIMIT);
      const lastBreak = Math.max(prompt.lastIndexOf("\n"), prompt.lastIndexOf(". "));
      if (lastBreak > LEONARDO_PROMPT_LIMIT * 0.7) prompt = prompt.slice(0, lastBreak + 1);
      console.log(`  ⚠ Prompt truncated to ${prompt.length} chars`);
    }

    console.log(`✓ Spark Prompt generated (${prompt.length} chars, model: ${modelId})`);
    return res.json({ prompt });
  } catch (err) {
    console.error("Spark Prompt error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});

// ─── GET /api/proxy-image ─────────────────────────────────────────────────────
// Fetches a Leonardo CDN image server-side and streams it back so Canva can
// upload it without hitting CORS restrictions or URL expiry on the client.
// Usage: GET /api/proxy-image?url=<encodeURIComponent(leonardoUrl)>
app.get("/api/proxy-image", async (req, res) => {
  const { url } = req.query;
  if (!url || typeof url !== "string") {
    return res.status(400).json({ message: "Missing url query param" });
  }
  try {
    const imgRes = await fetch(url);
    if (!imgRes.ok) {
      return res.status(imgRes.status).json({ message: `Upstream fetch failed: ${imgRes.status}` });
    }
    const contentType = imgRes.headers.get("content-type") || "image/jpeg";
    const arrayBuf = await imgRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuf);
    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(buffer);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});


// ─── Canva logo endpoints ────────────────────────────────────────────────────
// Official Canva wordmark SVGs served as static buffers — Canva's uploader
// needs a real fetchable URL, not a data: URI.
const CANVA_WORDMARK_GRADIENT = Buffer.from("PHN2ZyB3aWR0aD0iMjAwMCIgaGVpZ2h0PSI2NDIiIHZpZXdCb3g9IjAgMCAyMDAwIDY0MiIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTE5ODYuMSA0MzguNEMxOTgyLjcgNDM4LjQgMTk3OS42IDQ0MC42IDE5NzggNDQ1LjJDMTk1Ny41IDUwMy43IDE5MjkuOCA1MzguNSAxOTA3IDUzOC41QzE4OTMuOSA1MzguNSAxODg4LjYgNTIzLjkgMTg4OC42IDUwMUMxODg4LjYgNDQzLjcgMTkyMi45IDMyMi4yIDE5NDAuMiAyNjYuOEMxOTQyLjIgMjYwLjEgMTk0My41IDI1NC4xIDE5NDMuNSAyNDlDMTk0My41IDIzMi45IDE5MzQuNyAyMjUgMTkxMi45IDIyNUMxODg5LjQgMjI1IDE4NjQuMSAyMzQuMiAxODM5LjUgMjc3LjNDMTgzMSAyMzkuMyAxODA1LjMgMjIyLjcgMTc2OS40IDIyMi43QzE3MjcuOSAyMjIuNyAxNjg3LjggMjQ5LjQgMTY1NC44IDI5Mi43QzE2MjEuOCAzMzYgMTU4MyAzNTAuMiAxNTUzLjggMzQzLjJDMTU3NC44IDI5MS44IDE1ODIuNiAyNTMuNCAxNTgyLjYgMjI0LjlDMTU4Mi42IDE4MC4yIDE1NjAuNSAxNTMuMiAxNTI0LjggMTUzLjJDMTQ3MC41IDE1My4yIDE0MzkuMiAyMDUgMTQzOS4yIDI1OS41QzE0MzkuMiAzMDEuNiAxNDU4LjMgMzQ0LjkgMTUwMC4zIDM2NS45QzE0NjUuMSA0NDUuNSAxNDEzLjcgNTE3LjUgMTM5NC4yIDUxNy41QzEzNjkgNTE3LjUgMTM2MS42IDM5NC4yIDEzNjMgMzA2QzEzNjMuOSAyNTUuNCAxMzY4LjEgMjUyLjggMTM2OC4xIDIzNy41QzEzNjguMSAyMjguNyAxMzYyLjQgMjIyLjcgMTMzOS41IDIyMi43QzEyODYuMSAyMjIuNyAxMjY5LjYgMjY3LjkgMTI2Ny4xIDMxOS44QzEyNjYuMyAzMzkuNSAxMjYzLjIgMzU5LjEgMTI1Ny45IDM3OC4xQzEyMzUuNiA0NTcuNyAxMTg5LjYgNTE4LjEgMTE1OS42IDUxOC4xQzExNDUuNyA1MTguMSAxMTQxLjkgNTA0LjIgMTE0MS45IDQ4NkMxMTQxLjkgNDI4LjcgMTE3NCAzNTcuMSAxMTc0IDI5NkMxMTc0IDI1MS4xIDExNTQuMyAyMjIuNyAxMTE3LjIgMjIyLjdDMTA3My41IDIyMi43IDEwMTUuNyAyNzQuNyA5NjEgMzcyLjFDOTc5IDI5Ny41IDk4Ni40IDIyNS4zIDkzMy4xIDIyNS4zQzkyMS41IDIyNS41IDkxMC4yIDIyOC40IDkwMCAyMzMuOUM4OTMgMjM3LjIgODg4LjcgMjQ0LjQgODg5LjIgMjUyLjFDODk0LjMgMzMxLjUgODI1LjIgNTM0LjkgNzU5LjcgNTM0LjlDNzQ3LjggNTM0LjkgNzQyIDUyMiA3NDIgNTAxLjJDNzQyIDQ0My44IDc3Ni4yIDMyMi42IDc5My40IDI2Ny4xQzc5NS42IDI1OS45IDc5Ni44IDI1My43IDc5Ni44IDI0OC4zQzc5Ni44IDIzMy4xIDc4Ny40IDIyNS4zIDc2Ni4xIDIyNS4zQzc0Mi43IDIyNS4zIDcxNy4zIDIzNC4yIDY5Mi44IDI3Ny4zQzY4NC4yIDIzOS4zIDY1OC41IDIyMi43IDYyMi42IDIyMi43QzU2My43IDIyMi43IDQ5Ny45IDI4NSA0NjkgMzY2LjJDNDMwLjMgNDc0LjYgMzUyLjMgNTc5LjMgMjQ3LjMgNTc5LjNDMTUyIDU3OS4zIDEwMS43IDUwMCAxMDEuNyAzNzQuN0MxMDEuNyAxOTMuOCAyMzQuNSA0NiAzMzMgNDZDMzgwLjEgNDYgNDAyLjYgNzYgNDAyLjYgMTIyQzQwMi42IDE3Ny43IDM3MS41IDIwMy42IDM3MS41IDIyNC44QzM3MS41IDIzMS4zIDM3Ni45IDIzNy43IDM4Ny42IDIzNy43QzQzMC40IDIzNy43IDQ4MC44IDE4Ny40IDQ4MC44IDExOC44QzQ4MC44IDUwLjIgNDI1LjEgMCAzMjYuNiAwQzE2My44IDAgMCAxNjMuOCAwIDM3My43QzAgNTQwLjcgODIuNCA2NDEuNCAyMjQuOSA2NDEuNEMzMjIuMSA2NDEuNCA0MDcgNTY1LjggNDUyLjggNDc3LjZDNDU4IDU1MC43IDQ5MS4yIDU4OC45IDU0MS44IDU4OC45QzU4Ni44IDU4OC45IDYyMy4yIDU2Mi4xIDY1MSA1MTVDNjYxLjcgNTY0LjMgNjkwLjEgNTg4LjQgNzI3IDU4OC40Qzc2OS4zIDU4OC40IDgwNC43IDU2MS42IDgzOC40IDUxMS44QzgzNy45IDU1MC45IDg0Ni44IDU4Ny43IDg4MC43IDU4Ny43Qzg5Ni43IDU4Ny43IDkxNS44IDU4NCA5MTkuMiA1NzBDOTU0LjkgNDIyLjQgMTA0My4xIDMwMS45IDEwNzAuMSAzMDEuOUMxMDc4LjEgMzAxLjkgMTA4MC4zIDMwOS42IDEwODAuMyAzMTguN0MxMDgwLjMgMzU4LjggMTA1MiA0NDEgMTA1MiA0OTMuNUMxMDUyIDU1MC4yIDEwNzYuMSA1ODcuNyAxMTI1LjkgNTg3LjdDMTE4MS4xIDU4Ny43IDEyMzcuMiA1MjAuMSAxMjc0LjYgNDIxLjNDMTI4Ni4zIDUxMy42IDEzMTEuNiA1ODguMSAxMzUxLjIgNTg4LjFDMTM5OS44IDU4OC4xIDE0ODYuMSA0ODUuOCAxNTM4LjQgMzc3LjVDMTU1OC45IDM4MC4xIDE1ODkuNyAzNzkuNCAxNjE5LjMgMzU4LjVDMTYwNi43IDM5MC40IDE1OTkuMyA0MjUuMyAxNTk5LjMgNDYwLjJDMTU5OS4zIDU2MC43IDE2NDcuMyA1ODguOSAxNjg4LjYgNTg4LjlDMTczMy41IDU4OC45IDE3NjkuOSA1NjIuMSAxNzk3LjggNTE1QzE4MDcgNTU3LjUgMTgzMC41IDU4OC4zIDE4NzMuNyA1ODguM0MxOTQxLjMgNTg4LjMgMjAwMCA1MTkuMiAyMDAwIDQ2Mi41QzIwMDAgNDQ3LjUgMTk5My42IDQzOC40IDE5ODYuMSA0MzguNFpNNTgzIDUzMy4yQzU1NS43IDUzMy4yIDU0NSA1MDUuNyA1NDUgNDY0LjdDNTQ1IDM5My41IDU5My43IDI3NC42IDY0NS4yIDI3NC42QzY2Ny43IDI3NC42IDY3Ni4yIDMwMS4xIDY3Ni4yIDMzMy41QzY3Ni4yIDQwNS44IDYyOS45IDUzMy4yIDU4MyA1MzMuMlpNMTUxOC4xIDMyMC43QzE1MDEuOCAzMDEuMyAxNDk1LjkgMjc0LjkgMTQ5NS45IDI1MS40QzE0OTUuOSAyMjIuNCAxNTA2LjUgMTk3LjkgMTUxOS4yIDE5Ny45QzE1MzEuOSAxOTcuOSAxNTM1LjggMjEwLjQgMTUzNS44IDIyNy44QzE1MzUuOCAyNTYuOSAxNTI1LjQgMjk5LjQgMTUxOC4xIDMyMC43Wk0xNzI5LjggNTMzLjJDMTcwMi41IDUzMy4yIDE2OTEuOCA1MDEuNiAxNjkxLjggNDY0LjdDMTY5MS44IDM5NiAxNzQwLjUgMjc0LjYgMTc5Mi40IDI3NC42QzE4MTQuOSAyNzQuNiAxODIyLjkgMzAwLjkgMTgyMi45IDMzMy41QzE4MjIuOSA0MDUuOCAxNzc3LjQgNTMzLjIgMTcyOS44IDUzMy4yWiIgZmlsbD0idXJsKCNwYWludDBfbGluZWFyKSIvPgo8cGF0aCBkPSJNMTk4Ni4xIDQzOC40QzE5ODIuNyA0MzguNCAxOTc5LjYgNDQwLjYgMTk3OCA0NDUuMkMxOTU3LjUgNTAzLjcgMTkyOS44IDUzOC41IDE5MDcgNTM4LjVDMTg5My45IDUzOC41IDE4ODguNiA1MjMuOSAxODg4LjYgNTAxQzE4ODguNiA0NDMuNyAxOTIyLjkgMzIyLjIgMTk0MC4yIDI2Ni44QzE5NDIuMiAyNjAuMSAxOTQzLjUgMjU0LjEgMTk0My41IDI0OUMxOTQzLjUgMjMyLjkgMTkzNC43IDIyNSAxOTEyLjkgMjI1QzE4ODkuNCAyMjUgMTg2NC4xIDIzNC4yIDE4MzkuNSAyNzcuM0MxODMxIDIzOS4zIDE4MDUuMyAyMjIuNyAxNzY5LjQgMjIyLjdDMTcyNy45IDIyMi43IDE2ODcuOCAyNDkuNCAxNjU0LjggMjkyLjdDMTYyMS44IDMzNiAxNTgzIDM1MC4yIDE1NTMuOCAzNDMuMkMxNTc0LjggMjkxLjggMTU4Mi42IDI1My40IDE1ODIuNiAyMjQuOUMxNTgyLjYgMTgwLjIgMTU2MC41IDE1My4yIDE1MjQuOCAxNTMuMkMxNDcwLjUgMTUzLjIgMTQzOS4yIDIwNSAxNDM5LjIgMjU5LjVDMTQzOS4yIDMwMS42IDE0NTguMyAzNDQuOSAxNTAwLjMgMzY1LjlDMTQ2NS4xIDQ0NS41IDE0MTMuNyA1MTcuNSAxMzk0LjIgNTE3LjVDMTM2OSA1MTcuNSAxMzYxLjYgMzk0LjIgMTM2MyAzMDZDMTM2My45IDI1NS40IDEzNjguMSAyNTIuOCAxMzY4LjEgMjM3LjVDMTM2OC4xIDIyOC43IDEzNjIuNCAyMjIuNyAxMzM5LjUgMjIyLjdDMTI4Ni4xIDIyMi43IDEyNjkuNiAyNjcuOSAxMjY3LjEgMzE5LjhDMTI2Ni4zIDMzOS41IDEyNjMuMiAzNTkuMSAxMjU3LjkgMzc4LjFDMTIzNS42IDQ1Ny43IDExODkuNiA1MTguMSAxMTU5LjYgNTE4LjFDMTE0NS43IDUxOC4xIDExNDEuOSA1MDQuMiAxMTQxLjkgNDg2QzExNDEuOSA0MjguNyAxMTc0IDM1Ny4xIDExNzQgMjk2QzExNzQgMjUxLjEgMTE1NC4zIDIyMi43IDExMTcuMiAyMjIuN0MxMDczLjUgMjIyLjcgMTAxNS43IDI3NC43IDk2MSAzNzIuMUM5NzkgMjk3LjUgOTg2LjQgMjI1LjMgOTMzLjEgMjI1LjNDOTIxLjUgMjI1LjUgOTEwLjIgMjI4LjQgOTAwIDIzMy45Qzg5MyAyMzcuMiA4ODguNyAyNDQuNCA4ODkuMiAyNTIuMUM4OTQuMyAzMzEuNSA4MjUuMiA1MzQuOSA3NTkuNyA1MzQuOUM3NDcuOCA1MzQuOSA3NDIgNTIyIDc0MiA1MDEuMkM3NDIgNDQzLjggNzc2LjIgMzIyLjYgNzkzLjQgMjY3LjFDNzk1LjYgMjU5LjkgNzk2LjggMjUzLjcgNzk2LjggMjQ4LjNDNzk2LjggMjMzLjEgNzg3LjQgMjI1LjMgNzY2LjEgMjI1LjNDNzQyLjcgMjI1LjMgNzE3LjMgMjM0LjIgNjkyLjggMjc3LjNDNjg0LjIgMjM5LjMgNjU4LjUgMjIyLjcgNjIyLjYgMjIyLjdDNTYzLjcgMjIyLjcgNDk3LjkgMjg1IDQ2OSAzNjYuMkM0MzAuMyA0NzQuNiAzNTIuMyA1NzkuMyAyNDcuMyA1NzkuM0MxNTIgNTc5LjMgMTAxLjcgNTAwIDEwMS43IDM3NC43QzEwMS43IDE5My44IDIzNC41IDQ2IDMzMyA0NkMzODAuMSA0NiA0MDIuNiA3NiA0MDIuNiAxMjJDNDAyLjYgMTc3LjcgMzcxLjUgMjAzLjYgMzcxLjUgMjI0LjhDMzcxLjUgMjMxLjMgMzc2LjkgMjM3LjcgMzg3LjYgMjM3LjdDNDMwLjQgMjM3LjcgNDgwLjggMTg3LjQgNDgwLjggMTE4LjhDNDgwLjggNTAuMiA0MjUuMSAwIDMyNi42IDBDMTYzLjggMCAwIDE2My44IDAgMzczLjdDMCA1NDAuNyA4Mi40IDY0MS40IDIyNC45IDY0MS40QzMyMi4xIDY0MS40IDQwNyA1NjUuOCA0NTIuOCA0NzcuNkM0NTggNTUwLjcgNDkxLjIgNTg4LjkgNTQxLjggNTg4LjlDNTg2LjggNTg4LjkgNjIzLjIgNTYyLjEgNjUxIDUxNUM2NjEuNyA1NjQuMyA2OTAuMSA1ODguNCA3MjcgNTg4LjRDNzY5LjMgNTg4LjQgODA0LjcgNTYxLjYgODM4LjQgNTExLjhDODM3LjkgNTUwLjkgODQ2LjggNTg3LjcgODgwLjcgNTg3LjdDODk2LjcgNTg3LjcgOTE1LjggNTg0IDkxOS4yIDU3MEM5NTQuOSA0MjIuNCAxMDQzLjEgMzAxLjkgMTA3MC4xIDMwMS45QzEwNzguMSAzMDEuOSAxMDgwLjMgMzA5LjYgMTA4MC4zIDMxOC43QzEwODAuMyAzNTguOCAxMDUyIDQ0MSAxMDUyIDQ5My41QzEwNTIgNTUwLjIgMTA3Ni4xIDU4Ny43IDExMjUuOSA1ODcuN0MxMTgxLjEgNTg3LjcgMTIzNy4yIDUyMC4xIDEyNzQuNiA0MjEuM0MxMjg2LjMgNTEzLjYgMTMxMS42IDU4OC4xIDEzNTEuMiA1ODguMUMxMzk5LjggNTg4LjEgMTQ4Ni4xIDQ4NS44IDE1MzguNCAzNzcuNUMxNTU4LjkgMzgwLjEgMTU4OS43IDM3OS40IDE2MTkuMyAzNTguNUMxNjA2LjcgMzkwLjQgMTU5OS4zIDQyNS4zIDE1OTkuMyA0NjAuMkMxNTk5LjMgNTYwLjcgMTY0Ny4zIDU4OC45IDE2ODguNiA1ODguOUMxNzMzLjUgNTg4LjkgMTc2OS45IDU2Mi4xIDE3OTcuOCA1MTVDMTgwNyA1NTcuNSAxODMwLjUgNTg4LjMgMTg3My43IDU4OC4zQzE5NDEuMyA1ODguMyAyMDAwIDUxOS4yIDIwMDAgNDYyLjVDMjAwMCA0NDcuNSAxOTkzLjYgNDM4LjQgMTk4Ni4xIDQzOC40Wk01ODMgNTMzLjJDNTU1LjcgNTMzLjIgNTQ1IDUwNS43IDU0NSA0NjQuN0M1NDUgMzkzLjUgNTkzLjcgMjc0LjYgNjQ1LjIgMjc0LjZDNjY3LjcgMjc0LjYgNjc2LjIgMzAxLjEgNjc2LjIgMzMzLjVDNjc2LjIgNDA1LjggNjI5LjkgNTMzLjIgNTgzIDUzMy4yWk0xNTE4LjEgMzIwLjdDMTUwMS44IDMwMS4zIDE0OTUuOSAyNzQuOSAxNDk1LjkgMjUxLjRDMTQ5NS45IDIyMi40IDE1MDYuNSAxOTcuOSAxNTE5LjIgMTk3LjlDMTUzMS45IDE5Ny45IDE1MzUuOCAyMTAuNCAxNTM1LjggMjI3LjhDMTUzNS44IDI1Ni45IDE1MjUuNCAyOTkuNCAxNTE4LjEgMzIwLjdaTTE3MjkuOCA1MzMuMkMxNzAyLjUgNTMzLjIgMTY5MS44IDUwMS42IDE2OTEuOCA0NjQuN0MxNjkxLjggMzk2IDE3NDAuNSAyNzQuNiAxNzkyLjQgMjc0LjZDMTgxNC45IDI3NC42IDE4MjIuOSAzMDAuOSAxODIyLjkgMzMzLjVDMTgyMi45IDQwNS44IDE3NzcuNCA1MzMuMiAxNzI5LjggNTMzLjJaIiBmaWxsPSJ1cmwoI3BhaW50MV9yYWRpYWwpIi8+CjxwYXRoIGQ9Ik0xOTg2LjEgNDM4LjRDMTk4Mi43IDQzOC40IDE5NzkuNiA0NDAuNiAxOTc4IDQ0NS4yQzE5NTcuNSA1MDMuNyAxOTI5LjggNTM4LjUgMTkwNyA1MzguNUMxODkzLjkgNTM4LjUgMTg4OC42IDUyMy45IDE4ODguNiA1MDFDMTg4OC42IDQ0My43IDE5MjIuOSAzMjIuMiAxOTQwLjIgMjY2LjhDMTk0Mi4yIDI2MC4xIDE5NDMuNSAyNTQuMSAxOTQzLjUgMjQ5QzE5NDMuNSAyMzIuOSAxOTM0LjcgMjI1IDE5MTIuOSAyMjVDMTg4OS40IDIyNSAxODY0LjEgMjM0LjIgMTgzOS41IDI3Ny4zQzE4MzEgMjM5LjMgMTgwNS4zIDIyMi43IDE3NjkuNCAyMjIuN0MxNzI3LjkgMjIyLjcgMTY4Ny44IDI0OS40IDE2NTQuOCAyOTIuN0MxNjIxLjggMzM2IDE1ODMgMzUwLjIgMTU1My44IDM0My4yQzE1NzQuOCAyOTEuOCAxNTgyLjYgMjUzLjQgMTU4Mi42IDIyNC45QzE1ODIuNiAxODAuMiAxNTYwLjUgMTUzLjIgMTUyNC44IDE1My4yQzE0NzAuNSAxNTMuMiAxNDM5LjIgMjA1IDE0MzkuMiAyNTkuNUMxNDM5LjIgMzAxLjYgMTQ1OC4zIDM0NC45IDE1MDAuMyAzNjUuOUMxNDY1LjEgNDQ1LjUgMTQxMy43IDUxNy41IDEzOTQuMiA1MTcuNUMxMzY5IDUxNy41IDEzNjEuNiAzOTQuMiAxMzYzIDMwNkMxMzYzLjkgMjU1LjQgMTM2OC4xIDI1Mi44IDEzNjguMSAyMzcuNUMxMzY4LjEgMjI4LjcgMTM2Mi40IDIyMi43IDEzMzkuNSAyMjIuN0MxMjg2LjEgMjIyLjcgMTI2OS42IDI2Ny45IDEyNjcuMSAzMTkuOEMxMjY2LjMgMzM5LjUgMTI2My4yIDM1OS4xIDEyNTcuOSAzNzguMUMxMjM1LjYgNDU3LjcgMTE4OS42IDUxOC4xIDExNTkuNiA1MTguMUMxMTQ1LjcgNTE4LjEgMTE0MS45IDUwNC4yIDExNDEuOSA0ODZDMTE0MS45IDQyOC43IDExNzQgMzU3LjEgMTE3NCAyOTZDMTE3NCAyNTEuMSAxMTU0LjMgMjIyLjcgMTExNy4yIDIyMi43QzEwNzMuNSAyMjIuNyAxMDE1LjcgMjc0LjcgOTYxIDM3Mi4xQzk3OSAyOTcuNSA5ODYuNCAyMjUuMyA5MzMuMSAyMjUuM0M5MjEuNSAyMjUuNSA5MTAuMiAyMjguNCA5MDAgMjMzLjlDODkzIDIzNy4yIDg4OC43IDI0NC40IDg4OS4yIDI1Mi4xQzg5NC4zIDMzMS41IDgyNS4yIDUzNC45IDc1OS43IDUzNC45Qzc0Ny44IDUzNC45IDc0MiA1MjIgNzQyIDUwMS4yQzc0MiA0NDMuOCA3NzYuMiAzMjIuNiA3OTMuNCAyNjcuMUM3OTUuNiAyNTkuOSA3OTYuOCAyNTMuNyA3OTYuOCAyNDguM0M3OTYuOCAyMzMuMSA3ODcuNCAyMjUuMyA3NjYuMSAyMjUuM0M3NDIuNyAyMjUuMyA3MTcuMyAyMzQuMiA2OTIuOCAyNzcuM0M2ODQuMiAyMzkuMyA2NTguNSAyMjIuNyA2MjIuNiAyMjIuN0M1NjMuNyAyMjIuNyA0OTcuOSAyODUgNDY5IDM2Ni4yQzQzMC4zIDQ3NC42IDM1Mi4zIDU3OS4zIDI0Ny4zIDU3OS4zQzE1MiA1NzkuMyAxMDEuNyA1MDAgMTAxLjcgMzc0LjdDMTAxLjcgMTkzLjggMjM0LjUgNDYgMzMzIDQ2QzM4MC4xIDQ2IDQwMi42IDc2IDQwMi42IDEyMkM0MDIuNiAxNzcuNyAzNzEuNSAyMDMuNiAzNzEuNSAyMjQuOEMzNzEuNSAyMzEuMyAzNzYuOSAyMzcuNyAzODcuNiAyMzcuN0M0MzAuNCAyMzcuNyA0ODAuOCAxODcuNCA0ODAuOCAxMTguOEM0ODAuOCA1MC4yIDQyNS4xIDAgMzI2LjYgMEMxNjMuOCAwIDAgMTYzLjggMCAzNzMuN0MwIDU0MC43IDgyLjQgNjQxLjQgMjI0LjkgNjQxLjRDMzIyLjEgNjQxLjQgNDA3IDU2NS44IDQ1Mi44IDQ3Ny42QzQ1OCA1NTAuNyA0OTEuMiA1ODguOSA1NDEuOCA1ODguOUM1ODYuOCA1ODguOSA2MjMuMiA1NjIuMSA2NTEgNTE1QzY2MS43IDU2NC4zIDY5MC4xIDU4OC40IDcyNyA1ODguNEM3NjkuMyA1ODguNCA4MDQuNyA1NjEuNiA4MzguNCA1MTEuOEM4MzcuOSA1NTAuOSA4NDYuOCA1ODcuNyA4ODAuNyA1ODcuN0M4OTYuNyA1ODcuNyA5MTUuOCA1ODQgOTE5LjIgNTcwQzk1NC45IDQyMi40IDEwNDMuMSAzMDEuOSAxMDcwLjEgMzAxLjlDMTA3OC4xIDMwMS45IDEwODAuMyAzMDkuNiAxMDgwLjMgMzE4LjdDMTA4MC4zIDM1OC44IDEwNTIgNDQxIDEwNTIgNDkzLjVDMTA1MiA1NTAuMiAxMDc2LjEgNTg3LjcgMTEyNS45IDU4Ny43QzExODEuMSA1ODcuNyAxMjM3LjIgNTIwLjEgMTI3NC42IDQyMS4zQzEyODYuMyA1MTMuNiAxMzExLjYgNTg4LjEgMTM1MS4yIDU4OC4xQzEzOTkuOCA1ODguMSAxNDg2LjEgNDg1LjggMTUzOC40IDM3Ny41QzE1NTguOSAzODAuMSAxNTg5LjcgMzc5LjQgMTYxOS4zIDM1OC41QzE2MDYuNyAzOTAuNCAxNTk5LjMgNDI1LjMgMTU5OS4zIDQ2MC4yQzE1OTkuMyA1NjAuNyAxNjQ3LjMgNTg4LjkgMTY4OC42IDU4OC45QzE3MzMuNSA1ODguOSAxNzY5LjkgNTYyLjEgMTc5Ny44IDUxNUMxODA3IDU1Ny41IDE4MzAuNSA1ODguMyAxODczLjcgNTg4LjNDMTk0MS4zIDU4OC4zIDIwMDAgNTE5LjIgMjAwMCA0NjIuNUMyMDAwIDQ0Ny41IDE5OTMuNiA0MzguNCAxOTg2LjEgNDM4LjRaTTU4MyA1MzMuMkM1NTUuNyA1MzMuMiA1NDUgNTA1LjcgNTQ1IDQ2NC43QzU0NSAzOTMuNSA1OTMuNyAyNzQuNiA2NDUuMiAyNzQuNkM2NjcuNyAyNzQuNiA2NzYuMiAzMDEuMSA2NzYuMiAzMzMuNUM2NzYuMiA0MDUuOCA2MjkuOSA1MzMuMiA1ODMgNTMzLjJaTTE1MTguMSAzMjAuN0MxNTAxLjggMzAxLjMgMTQ5NS45IDI3NC45IDE0OTUuOSAyNTEuNEMxNDk1LjkgMjIyLjQgMTUwNi41IDE5Ny45IDE1MTkuMiAxOTcuOUMxNTMxLjkgMTk3LjkgMTUzNS44IDIxMC40IDE1MzUuOCAyMjcuOEMxNTM1LjggMjU2LjkgMTUyNS40IDI5OS40IDE1MTguMSAzMjAuN1pNMTcyOS44IDUzMy4yQzE3MDIuNSA1MzMuMiAxNjkxLjggNTAxLjYgMTY5MS44IDQ2NC43QzE2OTEuOCAzOTYgMTc0MC41IDI3NC42IDE3OTIuNCAyNzQuNkMxODE0LjkgMjc0LjYgMTgyMi45IDMwMC45IDE4MjIuOSAzMzMuNUMxODIyLjkgNDA1LjggMTc3Ny40IDUzMy4yIDE3MjkuOCA1MzMuMloiIGZpbGw9InVybCgjcGFpbnQyX3JhZGlhbCkiLz4KPHBhdGggZD0iTTE5ODYuMSA0MzguNEMxOTgyLjcgNDM4LjQgMTk3OS42IDQ0MC42IDE5NzggNDQ1LjJDMTk1Ny41IDUwMy43IDE5MjkuOCA1MzguNSAxOTA3IDUzOC41QzE4OTMuOSA1MzguNSAxODg4LjYgNTIzLjkgMTg4OC42IDUwMUMxODg4LjYgNDQzLjcgMTkyMi45IDMyMi4yIDE5NDAuMiAyNjYuOEMxOTQyLjIgMjYwLjEgMTk0My41IDI1NC4xIDE5NDMuNSAyNDlDMTk0My41IDIzMi45IDE5MzQuNyAyMjUgMTkxMi45IDIyNUMxODg5LjQgMjI1IDE4NjQuMSAyMzQuMiAxODM5LjUgMjc3LjNDMTgzMSAyMzkuMyAxODA1LjMgMjIyLjcgMTc2OS40IDIyMi43QzE3MjcuOSAyMjIuNyAxNjg3LjggMjQ5LjQgMTY1NC44IDI5Mi43QzE2MjEuOCAzMzYgMTU4MyAzNTAuMiAxNTUzLjggMzQzLjJDMTU3NC44IDI5MS44IDE1ODIuNiAyNTMuNCAxNTgyLjYgMjI0LjlDMTU4Mi42IDE4MC4yIDE1NjAuNSAxNTMuMiAxNTI0LjggMTUzLjJDMTQ3MC41IDE1My4yIDE0MzkuMiAyMDUgMTQzOS4yIDI1OS41QzE0MzkuMiAzMDEuNiAxNDU4LjMgMzQ0LjkgMTUwMC4zIDM2NS45QzE0NjUuMSA0NDUuNSAxNDEzLjcgNTE3LjUgMTM5NC4yIDUxNy41QzEzNjkgNTE3LjUgMTM2MS42IDM5NC4yIDEzNjMgMzA2QzEzNjMuOSAyNTUuNCAxMzY4LjEgMjUyLjggMTM2OC4xIDIzNy41QzEzNjguMSAyMjguNyAxMzYyLjQgMjIyLjcgMTMzOS41IDIyMi43QzEyODYuMSAyMjIuNyAxMjY5LjYgMjY3LjkgMTI2Ny4xIDMxOS44QzEyNjYuMyAzMzkuNSAxMjYzLjIgMzU5LjEgMTI1Ny45IDM3OC4xQzEyMzUuNiA0NTcuNyAxMTg5LjYgNTE4LjEgMTE1OS42IDUxOC4xQzExNDUuNyA1MTguMSAxMTQxLjkgNTA0LjIgMTE0MS45IDQ4NkMxMTQxLjkgNDI4LjcgMTE3NCAzNTcuMSAxMTc0IDI5NkMxMTc0IDI1MS4xIDExNTQuMyAyMjIuNyAxMTE3LjIgMjIyLjdDMTA3My41IDIyMi43IDEwMTUuNyAyNzQuNyA5NjEgMzcyLjFDOTc5IDI5Ny41IDk4Ni40IDIyNS4zIDkzMy4xIDIyNS4zQzkyMS41IDIyNS41IDkxMC4yIDIyOC40IDkwMCAyMzMuOUM4OTMgMjM3LjIgODg4LjcgMjQ0LjQgODg5LjIgMjUyLjFDODk0LjMgMzMxLjUgODI1LjIgNTM0LjkgNzU5LjcgNTM0LjlDNzQ3LjggNTM0LjkgNzQyIDUyMiA3NDIgNTAxLjJDNzQyIDQ0My44IDc3Ni4yIDMyMi42IDc5My40IDI2Ny4xQzc5NS42IDI1OS45IDc5Ni44IDI1My43IDc5Ni44IDI0OC4zQzc5Ni44IDIzMy4xIDc4Ny40IDIyNS4zIDc2Ni4xIDIyNS4zQzc0Mi43IDIyNS4zIDcxNy4zIDIzNC4yIDY5Mi44IDI3Ny4zQzY4NC4yIDIzOS4zIDY1OC41IDIyMi43IDYyMi42IDIyMi43QzU2My43IDIyMi43IDQ5Ny45IDI4NSA0NjkgMzY2LjJDNDMwLjMgNDc0LjYgMzUyLjMgNTc5LjMgMjQ3LjMgNTc5LjNDMTUyIDU3OS4zIDEwMS43IDUwMCAxMDEuNyAzNzQuN0MxMDEuNyAxOTMuOCAyMzQuNSA0NiAzMzMgNDZDMzgwLjEgNDYgNDAyLjYgNzYgNDAyLjYgMTIyQzQwMi42IDE3Ny43IDM3MS41IDIwMy42IDM3MS41IDIyNC44QzM3MS41IDIzMS4zIDM3Ni45IDIzNy43IDM4Ny42IDIzNy43QzQzMC40IDIzNy43IDQ4MC44IDE4Ny40IDQ4MC44IDExOC44QzQ4MC44IDUwLjIgNDI1LjEgMCAzMjYuNiAwQzE2My44IDAgMCAxNjMuOCAwIDM3My43QzAgNTQwLjcgODIuNCA2NDEuNCAyMjQuOSA2NDEuNEMzMjIuMSA2NDEuNCA0MDcgNTY1LjggNDUyLjggNDc3LjZDNDU4IDU1MC43IDQ5MS4yIDU4OC45IDU0MS44IDU4OC45QzU4Ni44IDU4OC45IDYyMy4yIDU2Mi4xIDY1MSA1MTVDNjYxLjcgNTY0LjMgNjkwLjEgNTg4LjQgNzI3IDU4OC40Qzc2OS4zIDU4OC40IDgwNC43IDU2MS42IDgzOC40IDUxMS44QzgzNy45IDU1MC45IDg0Ni44IDU4Ny43IDg4MC43IDU4Ny43Qzg5Ni43IDU4Ny43IDkxNS44IDU4NCA5MTkuMiA1NzBDOTU0LjkgNDIyLjQgMTA0My4xIDMwMS45IDEwNzAuMSAzMDEuOUMxMDc4LjEgMzAxLjkgMTA4MC4zIDMwOS42IDEwODAuMyAzMTguN0MxMDgwLjMgMzU4LjggMTA1MiA0NDEgMTA1MiA0OTMuNUMxMDUyIDU1MC4yIDEwNzYuMSA1ODcuNyAxMTI1LjkgNTg3LjdDMTE4MS4xIDU4Ny43IDEyMzcuMiA1MjAuMSAxMjc0LjYgNDIxLjNDMTI4Ni4zIDUxMy42IDEzMTEuNiA1ODguMSAxMzUxLjIgNTg4LjFDMTM5OS44IDU4OC4xIDE0ODYuMSA0ODUuOCAxNTM4LjQgMzc3LjVDMTU1OC45IDM4MC4xIDE1ODkuNyAzNzkuNCAxNjE5LjMgMzU4LjVDMTYwNi43IDM5MC40IDE1OTkuMyA0MjUuMyAxNTk5LjMgNDYwLjJDMTU5OS4zIDU2MC43IDE2NDcuMyA1ODguOSAxNjg4LjYgNTg4LjlDMTczMy41IDU4OC45IDE3NjkuOSA1NjIuMSAxNzk3LjggNTE1QzE4MDcgNTU3LjUgMTgzMC41IDU4OC4zIDE4NzMuNyA1ODguM0MxOTQxLjMgNTg4LjMgMjAwMCA1MTkuMiAyMDAwIDQ2Mi41QzIwMDAgNDQ3LjUgMTk5My42IDQzOC40IDE5ODYuMSA0MzguNFpNNTgzIDUzMy4yQzU1NS43IDUzMy4yIDU0NSA1MDUuNyA1NDUgNDY0LjdDNTQ1IDM5My41IDU5My43IDI3NC42IDY0NS4yIDI3NC42QzY2Ny43IDI3NC42IDY3Ni4yIDMwMS4xIDY3Ni4yIDMzMy41QzY3Ni4yIDQwNS44IDYyOS45IDUzMy4yIDU4MyA1MzMuMlpNMTUxOC4xIDMyMC43QzE1MDEuOCAzMDEuMyAxNDk1LjkgMjc0LjkgMTQ5NS45IDI1MS40QzE0OTUuOSAyMjIuNCAxNTA2LjUgMTk3LjkgMTUxOS4yIDE5Ny45QzE1MzEuOSAxOTcuOSAxNTM1LjggMjEwLjQgMTUzNS44IDIyNy44QzE1MzUuOCAyNTYuOSAxNTI1LjQgMjk5LjQgMTUxOC4xIDMyMC43Wk0xNzI5LjggNTMzLjJDMTcwMi41IDUzMy4yIDE2OTEuOCA1MDEuNiAxNjkxLjggNDY0LjdDMTY5MS44IDM5NiAxNzQwLjUgMjc0LjYgMTc5Mi40IDI3NC42QzE4MTQuOSAyNzQuNiAxODIyLjkgMzAwLjkgMTgyMi45IDMzMy41QzE4MjIuOSA0MDUuOCAxNzc3LjQgNTMzLjIgMTcyOS44IDUzMy4yWiIgZmlsbD0idXJsKCNwYWludDNfcmFkaWFsKSIvPgo8cGF0aCBkPSJNMTk4Ni4xIDQzOC40QzE5ODIuNyA0MzguNCAxOTc5LjYgNDQwLjYgMTk3OCA0NDUuMkMxOTU3LjUgNTAzLjcgMTkyOS44IDUzOC41IDE5MDcgNTM4LjVDMTg5My45IDUzOC41IDE4ODguNiA1MjMuOSAxODg4LjYgNTAxQzE4ODguNiA0NDMuNyAxOTIyLjkgMzIyLjIgMTk0MC4yIDI2Ni44QzE5NDIuMiAyNjAuMSAxOTQzLjUgMjU0LjEgMTk0My41IDI0OUMxOTQzLjUgMjMyLjkgMTkzNC43IDIyNSAxOTEyLjkgMjI1QzE4ODkuNCAyMjUgMTg2NC4xIDIzNC4yIDE4MzkuNSAyNzcuM0MxODMxIDIzOS4zIDE4MDUuMyAyMjIuNyAxNzY5LjQgMjIyLjdDMTcyNy45IDIyMi43IDE2ODcuOCAyNDkuNCAxNjU0LjggMjkyLjdDMTYyMS44IDMzNiAxNTgzIDM1MC4yIDE1NTMuOCAzNDMuMkMxNTc0LjggMjkxLjggMTU4Mi42IDI1My40IDE1ODIuNiAyMjQuOUMxNTgyLjYgMTgwLjIgMTU2MC41IDE1My4yIDE1MjQuOCAxNTMuMkMxNDcwLjUgMTUzLjIgMTQzOS4yIDIwNSAxNDM5LjIgMjU5LjVDMTQzOS4yIDMwMS42IDE0NTguMyAzNDQuOSAxNTAwLjMgMzY1LjlDMTQ2NS4xIDQ0NS41IDE0MTMuNyA1MTcuNSAxMzk0LjIgNTE3LjVDMTM2OSA1MTcuNSAxMzYxLjYgMzk0LjIgMTM2MyAzMDZDMTM2My45IDI1NS40IDEzNjguMSAyNTIuOCAxMzY4LjEgMjM3LjVDMTM2OC4xIDIyOC43IDEzNjIuNCAyMjIuNyAxMzM5LjUgMjIyLjdDMTI4Ni4xIDIyMi43IDEyNjkuNiAyNjcuOSAxMjY3LjEgMzE5LjhDMTI2Ni4zIDMzOS41IDEyNjMuMiAzNTkuMSAxMjU3LjkgMzc4LjFDMTIzNS42IDQ1Ny43IDExODkuNiA1MTguMSAxMTU5LjYgNTE4LjFDMTE0NS43IDUxOC4xIDExNDEuOSA1MDQuMiAxMTQxLjkgNDg2QzExNDEuOSA0MjguNyAxMTc0IDM1Ny4xIDExNzQgMjk2QzExNzQgMjUxLjEgMTE1NC4zIDIyMi43IDExMTcuMiAyMjIuN0MxMDczLjUgMjIyLjcgMTAxNS43IDI3NC43IDk2MSAzNzIuMUM5NzkgMjk3LjUgOTg2LjQgMjI1LjMgOTMzLjEgMjI1LjNDOTIxLjUgMjI1LjUgOTEwLjIgMjI4LjQgOTAwIDIzMy45Qzg5MyAyMzcuMiA4ODguNyAyNDQuNCA4ODkuMiAyNTIuMUM4OTQuMyAzMzEuNSA4MjUuMiA1MzQuOSA3NTkuNyA1MzQuOUM3NDcuOCA1MzQuOSA3NDIgNTIyIDc0MiA1MDEuMkM3NDIgNDQzLjggNzc2LjIgMzIyLjYgNzkzLjQgMjY3LjFDNzk1LjYgMjU5LjkgNzk2LjggMjUzLjcgNzk2LjggMjQ4LjNDNzk2LjggMjMzLjEgNzg3LjQgMjI1LjMgNzY2LjEgMjI1LjNDNzQyLjcgMjI1LjMgNzE3LjMgMjM0LjIgNjkyLjggMjc3LjNDNjg0LjIgMjM5LjMgNjU4LjUgMjIyLjcgNjIyLjYgMjIyLjdDNTYzLjcgMjIyLjcgNDk3LjkgMjg1IDQ2OSAzNjYuMkM0MzAuMyA0NzQuNiAzNTIuMyA1NzkuMyAyNDcuMyA1NzkuM0MxNTIgNTc5LjMgMTAxLjcgNTAwIDEwMS43IDM3NC43QzEwMS43IDE5My44IDIzNC41IDQ2IDMzMyA0NkMzODAuMSA0NiA0MDIuNiA3NiA0MDIuNiAxMjJDNDAyLjYgMTc3LjcgMzcxLjUgMjAzLjYgMzcxLjUgMjI0LjhDMzcxLjUgMjMxLjMgMzc2LjkgMjM3LjcgMzg3LjYgMjM3LjdDNDMwLjQgMjM3LjcgNDgwLjggMTg3LjQgNDgwLjggMTE4LjhDNDgwLjggNTAuMiA0MjUuMSAwIDMyNi42IDBDMTYzLjggMCAwIDE2My44IDAgMzczLjdDMCA1NDAuNyA4Mi40IDY0MS40IDIyNC45IDY0MS40QzMyMi4xIDY0MS40IDQwNyA1NjUuOCA0NTIuOCA0NzcuNkM0NTggNTUwLjcgNDkxLjIgNTg4LjkgNTQxLjggNTg4LjlDNTg2LjggNTg4LjkgNjIzLjIgNTYyLjEgNjUxIDUxNUM2NjEuNyA1NjQuMyA2OTAuMSA1ODguNCA3MjcgNTg4LjRDNzY5LjMgNTg4LjQgODA0LjcgNTYxLjYgODM4LjQgNTExLjhDODM3LjkgNTUwLjkgODQ2LjggNTg3LjcgODgwLjcgNTg3LjdDODk2LjcgNTg3LjcgOTE1LjggNTg0IDkxOS4yIDU3MEM5NTQuOSA0MjIuNCAxMDQzLjEgMzAxLjkgMTA3MC4xIDMwMS45QzEwNzguMSAzMDEuOSAxMDgwLjMgMzA5LjYgMTA4MC4zIDMxOC43QzEwODAuMyAzNTguOCAxMDUyIDQ0MSAxMDUyIDQ5My41QzEwNTIgNTUwLjIgMTA3Ni4xIDU4Ny43IDExMjUuOSA1ODcuN0MxMTgxLjEgNTg3LjcgMTIzNy4yIDUyMC4xIDEyNzQuNiA0MjEuM0MxMjg2LjMgNTEzLjYgMTMxMS42IDU4OC4xIDEzNTEuMiA1ODguMUMxMzk5LjggNTg4LjEgMTQ4Ni4xIDQ4NS44IDE1MzguNCAzNzcuNUMxNTU4LjkgMzgwLjEgMTU4OS43IDM3OS40IDE2MTkuMyAzNTguNUMxNjA2LjcgMzkwLjQgMTU5OS4zIDQyNS4zIDE1OTkuMyA0NjAuMkMxNTk5LjMgNTYwLjcgMTY0Ny4zIDU4OC45IDE2ODguNiA1ODguOUMxNzMzLjUgNTg4LjkgMTc2OS45IDU2Mi4xIDE3OTcuOCA1MTVDMTgwNyA1NTcuNSAxODMwLjUgNTg4LjMgMTg3My43IDU4OC4zQzE5NDEuMyA1ODguMyAyMDAwIDUxOS4yIDIwMDAgNDYyLjVDMjAwMCA0NDcuNSAxOTkzLjYgNDM4LjQgMTk4Ni4xIDQzOC40Wk01ODMgNTMzLjJDNTU1LjcgNTMzLjIgNTQ1IDUwNS43IDU0NSA0NjQuN0M1NDUgMzkzLjUgNTkzLjcgMjc0LjYgNjQ1LjIgMjc0LjZDNjY3LjcgMjc0LjYgNjc2LjIgMzAxLjEgNjc2LjIgMzMzLjVDNjc2LjIgNDA1LjggNjI5LjkgNTMzLjIgNTgzIDUzMy4yWk0xNTE4LjEgMzIwLjdDMTUwMS44IDMwMS4zIDE0OTUuOSAyNzQuOSAxNDk1LjkgMjUxLjRDMTQ5NS45IDIyMi40IDE1MDYuNSAxOTcuOSAxNTE5LjIgMTk3LjlDMTUzMS45IDE5Ny45IDE1MzUuOCAyMTAuNCAxNTM1LjggMjI3LjhDMTUzNS44IDI1Ni45IDE1MjUuNCAyOTkuNCAxNTE4LjEgMzIwLjdaTTE3MjkuOCA1MzMuMkMxNzAyLjUgNTMzLjIgMTY5MS44IDUwMS42IDE2OTEuOCA0NjQuN0MxNjkxLjggMzk2IDE3NDAuNSAyNzQuNiAxNzkyLjQgMjc0LjZDMTgxNC45IDI3NC42IDE4MjIuOSAzMDAuOSAxODIyLjkgMzMzLjVDMTgyMi45IDQwNS44IDE3NzcuNCA1MzMuMiAxNzI5LjggNTMzLjJaIiBmaWxsPSJ1cmwoI3BhaW50NF9yYWRpYWwpIi8+CjxwYXRoIGQ9Ik0xOTg2LjEgNDM4LjRDMTk4Mi43IDQzOC40IDE5NzkuNiA0NDAuNiAxOTc4IDQ0NS4yQzE5NTcuNSA1MDMuNyAxOTI5LjggNTM4LjUgMTkwNyA1MzguNUMxODkzLjkgNTM4LjUgMTg4OC42IDUyMy45IDE4ODguNiA1MDFDMTg4OC42IDQ0My43IDE5MjIuOSAzMjIuMiAxOTQwLjIgMjY2LjhDMTk0Mi4yIDI2MC4xIDE5NDMuNSAyNTQuMSAxOTQzLjUgMjQ5QzE5NDMuNSAyMzIuOSAxOTM0LjcgMjI1IDE5MTIuOSAyMjVDMTg4OS40IDIyNSAxODY0LjEgMjM0LjIgMTgzOS41IDI3Ny4zQzE4MzEgMjM5LjMgMTgwNS4zIDIyMi43IDE3NjkuNCAyMjIuN0MxNzI3LjkgMjIyLjcgMTY4Ny44IDI0OS40IDE2NTQuOCAyOTIuN0MxNjIxLjggMzM2IDE1ODMgMzUwLjIgMTU1My44IDM0My4yQzE1NzQuOCAyOTEuOCAxNTgyLjYgMjUzLjQgMTU4Mi42IDIyNC45QzE1ODIuNiAxODAuMiAxNTYwLjUgMTUzLjIgMTUyNC44IDE1My4yQzE0NzAuNSAxNTMuMiAxNDM5LjIgMjA1IDE0MzkuMiAyNTkuNUMxNDM5LjIgMzAxLjYgMTQ1OC4zIDM0NC45IDE1MDAuMyAzNjUuOUMxNDY1LjEgNDQ1LjUgMTQxMy43IDUxNy41IDEzOTQuMiA1MTcuNUMxMzY5IDUxNy41IDEzNjEuNiAzOTQuMiAxMzYzIDMwNkMxMzYzLjkgMjU1LjQgMTM2OC4xIDI1Mi44IDEzNjguMSAyMzcuNUMxMzY4LjEgMjI4LjcgMTM2Mi40IDIyMi43IDEzMzkuNSAyMjIuN0MxMjg2LjEgMjIyLjcgMTI2OS42IDI2Ny45IDEyNjcuMSAzMTkuOEMxMjY2LjMgMzM5LjUgMTI2My4yIDM1OS4xIDEyNTcuOSAzNzguMUMxMjM1LjYgNDU3LjcgMTE4OS42IDUxOC4xIDExNTkuNiA1MTguMUMxMTQ1LjcgNTE4LjEgMTE0MS45IDUwNC4yIDExNDEuOSA0ODZDMTE0MS45IDQyOC43IDExNzQgMzU3LjEgMTE3NCAyOTZDMTE3NCAyNTEuMSAxMTU0LjMgMjIyLjcgMTExNy4yIDIyMi43QzEwNzMuNSAyMjIuNyAxMDE1LjcgMjc0LjcgOTYxIDM3Mi4xQzk3OSAyOTcuNSA5ODYuNCAyMjUuMyA5MzMuMSAyMjUuM0M5MjEuNSAyMjUuNSA5MTAuMiAyMjguNCA5MDAgMjMzLjlDODkzIDIzNy4yIDg4OC43IDI0NC40IDg4OS4yIDI1Mi4xQzg5NC4zIDMzMS41IDgyNS4yIDUzNC45IDc1OS43IDUzNC45Qzc0Ny44IDUzNC45IDc0MiA1MjIgNzQyIDUwMS4yQzc0MiA0NDMuOCA3NzYuMiAzMjIuNiA3OTMuNCAyNjcuMUM3OTUuNiAyNTkuOSA3OTYuOCAyNTMuNyA3OTYuOCAyNDguM0M3OTYuOCAyMzMuMSA3ODcuNCAyMjUuMyA3NjYuMSAyMjUuM0M3NDIuNyAyMjUuMyA3MTcuMyAyMzQuMiA2OTIuOCAyNzcuM0M2ODQuMiAyMzkuMyA2NTguNSAyMjIuNyA2MjIuNiAyMjIuN0M1NjMuNyAyMjIuNyA0OTcuOSAyODUgNDY5IDM2Ni4yQzQzMC4zIDQ3NC42IDM1Mi4zIDU3OS4zIDI0Ny4zIDU3OS4zQzE1MiA1NzkuMyAxMDEuNyA1MDAgMTAxLjcgMzc0LjdDMTAxLjcgMTkzLjggMjM0LjUgNDYgMzMzIDQ2QzM4MC4xIDQ2IDQwMi42IDc2IDQwMi42IDEyMkM0MDIuNiAxNzcuNyAzNzEuNSAyMDMuNiAzNzEuNSAyMjQuOEMzNzEuNSAyMzEuMyAzNzYuOSAyMzcuNyAzODcuNiAyMzcuN0M0MzAuNCAyMzcuNyA0ODAuOCAxODcuNCA0ODAuOCAxMTguOEM0ODAuOCA1MC4yIDQyNS4xIDAgMzI2LjYgMEMxNjMuOCAwIDAgMTYzLjggMCAzNzMuN0MwIDU0MC43IDgyLjQgNjQxLjQgMjI0LjkgNjQxLjRDMzIyLjEgNjQxLjQgNDA3IDU2NS44IDQ1Mi44IDQ3Ny42QzQ1OCA1NTAuNyA0OTEuMiA1ODguOSA1NDEuOCA1ODguOUM1ODYuOCA1ODguOSA2MjMuMiA1NjIuMSA2NTEgNTE1QzY2MS43IDU2NC4zIDY5MC4xIDU4OC40IDcyNyA1ODguNEM3NjkuMyA1ODguNCA4MDQuNyA1NjEuNiA4MzguNCA1MTEuOEM4MzcuOSA1NTAuOSA4NDYuOCA1ODcuNyA4ODAuNyA1ODcuN0M4OTYuNyA1ODcuNyA5MTUuOCA1ODQgOTE5LjIgNTcwQzk1NC45IDQyMi40IDEwNDMuMSAzMDEuOSAxMDcwLjEgMzAxLjlDMTA3OC4xIDMwMS45IDEwODAuMyAzMDkuNiAxMDgwLjMgMzE4LjdDMTA4MC4zIDM1OC44IDEwNTIgNDQxIDEwNTIgNDkzLjVDMTA1MiA1NTAuMiAxMDc2LjEgNTg3LjcgMTEyNS45IDU4Ny43QzExODEuMSA1ODcuNyAxMjM3LjIgNTIwLjEgMTI3NC42IDQyMS4zQzEyODYuMyA1MTMuNiAxMzExLjYgNTg4LjEgMTM1MS4yIDU4OC4xQzEzOTkuOCA1ODguMSAxNDg2LjEgNDg1LjggMTUzOC40IDM3Ny41QzE1NTguOSAzODAuMSAxNTg5LjcgMzc5LjQgMTYxOS4zIDM1OC41QzE2MDYuNyAzOTAuNCAxNTk5LjMgNDI1LjMgMTU5OS4zIDQ2MC4yQzE1OTkuMyA1NjAuNyAxNjQ3LjMgNTg4LjkgMTY4OC42IDU4OC45QzE3MzMuNSA1ODguOSAxNzY5LjkgNTYyLjEgMTc5Ny44IDUxNUMxODA3IDU1Ny41IDE4MzAuNSA1ODguMyAxODczLjcgNTg4LjNDMTk0MS4zIDU4OC4zIDIwMDAgNTE5LjIgMjAwMCA0NjIuNUMyMDAwIDQ0Ny41IDE5OTMuNiA0MzguNCAxOTg2LjEgNDM4LjRaTTU4MyA1MzMuMkM1NTUuNyA1MzMuMiA1NDUgNTA1LjcgNTQ1IDQ2NC43QzU0NSAzOTMuNSA1OTMuNyAyNzQuNiA2NDUuMiAyNzQuNkM2NjcuNyAyNzQuNiA2NzYuMiAzMDEuMSA2NzYuMiAzMzMuNUM2NzYuMiA0MDUuOCA2MjkuOSA1MzMuMiA1ODMgNTMzLjJaTTE1MTguMSAzMjAuN0MxNTAxLjggMzAxLjMgMTQ5NS45IDI3NC45IDE0OTUuOSAyNTEuNEMxNDk1LjkgMjIyLjQgMTUwNi41IDE5Ny45IDE1MTkuMiAxOTcuOUMxNTMxLjkgMTk3LjkgMTUzNS44IDIxMC40IDE1MzUuOCAyMjcuOEMxNTM1LjggMjU2LjkgMTUyNS40IDI5OS40IDE1MTguMSAzMjAuN1pNMTcyOS44IDUzMy4yQzE3MDIuNSA1MzMuMiAxNjkxLjggNTAxLjYgMTY5MS44IDQ2NC43QzE2OTEuOCAzOTYgMTc0MC41IDI3NC42IDE3OTIuNCAyNzQuNkMxODE0LjkgMjc0LjYgMTgyMi45IDMwMC45IDE4MjIuOSAzMzMuNUMxODIyLjkgNDA1LjggMTc3Ny40IDUzMy4yIDE3MjkuOCA1MzMuMloiIGZpbGw9InVybCgjcGFpbnQ1X3JhZGlhbCkiLz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhciIgeDE9IjIwMDAiIHkxPSI1NjEiIHgyPSIzMzYiIHkyPSIxNjUiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KPHN0b3Agc3RvcC1jb2xvcj0iIzdEMkFFNyIvPgo8c3RvcCBvZmZzZXQ9IjAuNzcwODMzIiBzdG9wLWNvbG9yPSIjN0QyQUU3Ii8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzdEMkFFNyIgc3RvcC1vcGFjaXR5PSIwIi8+CjwvbGluZWFyR3JhZGllbnQ+CjxyYWRpYWxHcmFkaWVudCBpZD0icGFpbnQxX3JhZGlhbCIgY3g9IjAiIGN5PSIwIiByPSIxIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgZ3JhZGllbnRUcmFuc2Zvcm09InRyYW5zbGF0ZSgxMDI0IDcxMSkgcm90YXRlKC00NS44MDY5KSBzY2FsZSg2MDIuNTE1IDQwMC40MjIpIj4KPHN0b3Agc3RvcC1jb2xvcj0iIzY0MjBGRiIvPgo8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM2NDIwRkYiIHN0b3Atb3BhY2l0eT0iMCIvPgo8L3JhZGlhbEdyYWRpZW50Pgo8cmFkaWFsR3JhZGllbnQgaWQ9InBhaW50Ml9yYWRpYWwiIGN4PSIwIiBjeT0iMCIgcj0iMSIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiIGdyYWRpZW50VHJhbnNmb3JtPSJ0cmFuc2xhdGUoNDcuOTk5OSA0MjcpIHJvdGF0ZSg1LjA4ODI2KSBzY2FsZSgxMTcyLjYyIDkzNC42MDQpIj4KPHN0b3Agb2Zmc2V0PSIwLjI1IiBzdG9wLWNvbG9yPSIjMDBDNENDIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzAwQzRDQyIgc3RvcC1vcGFjaXR5PSIwIi8+CjwvcmFkaWFsR3JhZGllbnQ+CjxyYWRpYWxHcmFkaWVudCBpZD0icGFpbnQzX3JhZGlhbCIgY3g9IjAiIGN5PSIwIiByPSIxIiBncmFkaWVudFVuaXRzPSJ1c2VyU3BhY2VPblVzZSIgZ3JhZGllbnRUcmFuc2Zvcm09InRyYW5zbGF0ZSg4NTMuNSA2NDEpIHJvdGF0ZSgtMzguODQ5Mykgc2NhbGUoNzU1LjY1MSA1MTYuNjkxKSI+CjxzdG9wIHN0b3AtY29sb3I9IiM2NDIwRkYiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNjQyMEZGIiBzdG9wLW9wYWNpdHk9IjAiLz4KPC9yYWRpYWxHcmFkaWVudD4KPHJhZGlhbEdyYWRpZW50IGlkPSJwYWludDRfcmFkaWFsIiBjeD0iMCIgY3k9IjAiIHI9IjEiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKDExMiA3NTMpIHJvdGF0ZSgtMzQuMjY3Mykgc2NhbGUoODgwLjkwOSA2MDIuMzM4KSI+CjxzdG9wIHN0b3AtY29sb3I9IiM2NDIwRkYiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjNjQyMEZGIiBzdG9wLW9wYWNpdHk9IjAiLz4KPC9yYWRpYWxHcmFkaWVudD4KPHJhZGlhbEdyYWRpZW50IGlkPSJwYWludDVfcmFkaWFsIiBjeD0iMCIgY3k9IjAiIHI9IjEiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIiBncmFkaWVudFRyYW5zZm9ybT0idHJhbnNsYXRlKDE5MiA1OSkgcm90YXRlKDEyLjQ3MTcpIHNjYWxlKDE3NDEuMDggMjEzNS4zNykiPgo8c3RvcCBzdG9wLWNvbG9yPSIjMDBDNENDIiBzdG9wLW9wYWNpdHk9IjAuNzI1OTE2Ii8+CjxzdG9wIHN0b3AtY29sb3I9IiMwMEM0Q0MiLz4KPHN0b3Agb2Zmc2V0PSIxIiBzdG9wLWNvbG9yPSIjMDBDNENDIiBzdG9wLW9wYWNpdHk9IjAiLz4KPC9yYWRpYWxHcmFkaWVudD4KPC9kZWZzPgo8L3N2Zz4K", "base64");
const CANVA_WORDMARK_WHITE    = Buffer.from("PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4KPCEtLSBHZW5lcmF0b3I6IEFkb2JlIElsbHVzdHJhdG9yIDI2LjAuMywgU1ZHIEV4cG9ydCBQbHVnLUluIC4gU1ZHIFZlcnNpb246IDYuMDAgQnVpbGQgMCkgIC0tPgo8c3ZnIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHg9IjBweCIgeT0iMHB4IgoJIHZpZXdCb3g9IjAgMCAyMDAwIDY0MSIgc3R5bGU9ImVuYWJsZS1iYWNrZ3JvdW5kOm5ldyAwIDAgMjAwMCA2NDE7IiB4bWw6c3BhY2U9InByZXNlcnZlIj4KPHN0eWxlIHR5cGU9InRleHQvY3NzIj4KCS5zdDB7ZmlsbDojRkZGRkZGO30KPC9zdHlsZT4KPGc+Cgk8Zz4KCQk8cGF0aCBjbGFzcz0ic3QwIiBkPSJNMTk4Ni4xLDQzOC4yYy0zLjQsMC02LjUsMi4yLTguMSw2LjhjLTIwLjUsNTguNS00OC4yLDkzLjMtNzEsOTMuM2MtMTMuMSwwLTE4LjQtMTQuNi0xOC40LTM3LjUKCQkJYzAtNTcuMywzNC4zLTE3OC44LDUxLjYtMjM0LjJjMi02LjcsMy4zLTEyLjcsMy4zLTE3LjhjMC0xNi4xLTguOC0yNC0zMC42LTI0Yy0yMy41LDAtNDguOCw5LjItNzMuNCw1Mi4zCgkJCWMtOC41LTM4LTM0LjItNTQuNi03MC4xLTU0LjZjLTQxLjUsMC04MS42LDI2LjctMTE0LjYsNzBzLTcxLjgsNTcuNS0xMDEsNTAuNWMyMS01MS40LDI4LjgtODkuOCwyOC44LTExOC4zCgkJCWMwLTQ0LjctMjIuMS03MS43LTU3LjgtNzEuN2MtNTQuMywwLTg1LjYsNTEuOC04NS42LDEwNi4zYzAsNDIuMSwxOS4xLDg1LjQsNjEuMSwxMDYuNGMtMzUuMiw3OS42LTg2LjYsMTUxLjYtMTA2LjEsMTUxLjYKCQkJYy0yNS4yLDAtMzIuNi0xMjMuMy0zMS4yLTIxMS41YzAuOS01MC42LDUuMS01My4yLDUuMS02OC41YzAtOC44LTUuNy0xNC44LTI4LjYtMTQuOGMtNTMuNCwwLTY5LjksNDUuMi03Mi40LDk3LjEKCQkJYy0wLjgsMTkuNy0zLjksMzkuMy05LjIsNTguM2MtMjIuMyw3OS42LTY4LjMsMTQwLTk4LjMsMTQwYy0xMy45LDAtMTcuNy0xMy45LTE3LjctMzIuMWMwLTU3LjMsMzIuMS0xMjguOSwzMi4xLTE5MAoJCQljMC00NC45LTE5LjctNzMuMy01Ni44LTczLjNjLTQzLjcsMC0xMDEuNSw1Mi0xNTYuMiwxNDkuNGMxOC03NC42LDI1LjQtMTQ2LjgtMjcuOS0xNDYuOGMtMTEuNiwwLjItMjIuOSwzLjEtMzMuMSw4LjYKCQkJYy03LDMuMy0xMS4zLDEwLjUtMTAuOCwxOC4yYzUuMSw3OS40LTY0LDI4Mi44LTEyOS41LDI4Mi44Yy0xMS45LDAtMTcuNy0xMi45LTE3LjctMzMuN2MwLTU3LjQsMzQuMi0xNzguNiw1MS40LTIzNC4xCgkJCWMyLjItNy4yLDMuNC0xMy40LDMuNC0xOC44YzAtMTUuMi05LjQtMjMtMzAuNy0yM2MtMjMuNCwwLTQ4LjgsOC45LTczLjMsNTJjLTguNi0zOC0zNC4zLTU0LjYtNzAuMi01NC42CgkJCWMtNTguOSwwLTEyNC43LDYyLjMtMTUzLjYsMTQzLjVjLTM4LjcsMTA4LjQtMTE2LjcsMjEzLjEtMjIxLjcsMjEzLjFjLTk1LjMsMC0xNDUuNi03OS4zLTE0NS42LTIwNC42CgkJCWMwLTE4MC45LDEzMi44LTMyOC43LDIzMS4zLTMyOC43YzQ3LjEsMCw2OS42LDMwLDY5LjYsNzZjMCw1NS43LTMxLjEsODEuNi0zMS4xLDEwMi44YzAsNi41LDUuNCwxMi45LDE2LjEsMTIuOQoJCQljNDIuOCwwLDkzLjItNTAuMyw5My4yLTExOC45UzQyNS4xLTAuMiwzMjYuNi0wLjJDMTYzLjgtMC4yLDAsMTYzLjYsMCwzNzMuNWMwLDE2Nyw4Mi40LDI2Ny43LDIyNC45LDI2Ny43CgkJCWM5Ny4yLDAsMTgyLjEtNzUuNiwyMjcuOS0xNjMuOGM1LjIsNzMuMSwzOC40LDExMS4zLDg5LDExMS4zYzQ1LDAsODEuNC0yNi44LDEwOS4yLTczLjljMTAuNyw0OS4zLDM5LjEsNzMuNCw3Niw3My40CgkJCWM0Mi4zLDAsNzcuNy0yNi44LDExMS40LTc2LjZjLTAuNSwzOS4xLDguNCw3NS45LDQyLjMsNzUuOWMxNiwwLDM1LjEtMy43LDM4LjUtMTcuN2MzNS43LTE0Ny42LDEyMy45LTI2OC4xLDE1MC45LTI2OC4xCgkJCWM4LDAsMTAuMiw3LjcsMTAuMiwxNi44YzAsNDAuMS0yOC4zLDEyMi4zLTI4LjMsMTc0LjhjMCw1Ni43LDI0LjEsOTQuMiw3My45LDk0LjJjNTUuMiwwLDExMS4zLTY3LjYsMTQ4LjctMTY2LjQKCQkJYzExLjcsOTIuMywzNywxNjYuOCw3Ni42LDE2Ni44YzQ4LjYsMCwxMzQuOS0xMDIuMywxODcuMi0yMTAuNmMyMC41LDIuNiw1MS4zLDEuOSw4MC45LTE5Yy0xMi42LDMxLjktMjAsNjYuOC0yMCwxMDEuNwoJCQljMCwxMDAuNSw0OCwxMjguNyw4OS4zLDEyOC43YzQ0LjksMCw4MS4zLTI2LjgsMTA5LjItNzMuOWM5LjIsNDIuNSwzMi43LDczLjMsNzUuOSw3My4zYzY3LjYsMCwxMjYuMy02OS4xLDEyNi4zLTEyNS44CgkJCUMyMDAwLDQ0Ny4zLDE5OTMuNiw0MzguMiwxOTg2LjEsNDM4LjJ6IE01ODMsNTMzYy0yNy4zLDAtMzgtMjcuNS0zOC02OC41YzAtNzEuMiw0OC43LTE5MC4xLDEwMC4yLTE5MC4xYzIyLjUsMCwzMSwyNi41LDMxLDU4LjkKCQkJQzY3Ni4yLDQwNS42LDYyOS45LDUzMyw1ODMsNTMzeiBNMTUxOC4xLDMyMC41Yy0xNi4zLTE5LjQtMjIuMi00NS44LTIyLjItNjkuM2MwLTI5LDEwLjYtNTMuNSwyMy4zLTUzLjUKCQkJYzEyLjcsMCwxNi42LDEyLjUsMTYuNiwyOS45QzE1MzUuOCwyNTYuNywxNTI1LjQsMjk5LjIsMTUxOC4xLDMyMC41eiBNMTcyOS44LDUzM2MtMjcuMywwLTM4LTMxLjYtMzgtNjguNQoJCQljMC02OC43LDQ4LjctMTkwLjEsMTAwLjYtMTkwLjFjMjIuNSwwLDMwLjUsMjYuMywzMC41LDU4LjlDMTgyMi45LDQwNS42LDE3NzcuNCw1MzMsMTcyOS44LDUzM3oiLz4KCTwvZz4KPC9nPgo8L3N2Zz4K", "base64");

app.get("/api/logo/wordmark-gradient", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(CANVA_WORDMARK_GRADIENT);
});

app.get("/api/logo/wordmark-white", (_req, res) => {
  res.setHeader("Content-Type", "image/svg+xml");
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.send(CANVA_WORDMARK_WHITE);
});

// ─── Blueprint endpoints ─────────────────────────────────────────────────────

// Execute a Blueprint
app.post("/api/blueprint-execute", async (req, res) => {
  const apiKey = resolveKey(req);
  const { blueprintVersionId, nodeInputs } = req.body;
  if (!blueprintVersionId || !nodeInputs) {
    return res.status(400).json({ error: "blueprintVersionId and nodeInputs are required" });
  }
  try {
    const r = await fetch(`${LEONARDO_BASE}/blueprint-executions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        blueprintVersionId,
        input: { nodeInputs, public: false, collectionIds: [] },
      }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll Blueprint execution status
app.get("/api/blueprint-execution/:id/status", async (req, res) => {
  const apiKey = resolveKey(req);
  try {
    const r = await fetch(`${LEONARDO_BASE}/blueprint-executions/${req.params.id}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get generation IDs from completed Blueprint execution
app.get("/api/blueprint-execution/:id/generations", async (req, res) => {
  const apiKey = resolveKey(req);
  try {
    const r = await fetch(`${LEONARDO_BASE}/blueprint-executions/${req.params.id}/generations`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List blueprints with thumbnails — paginates through ALL pages server-side.
// The API uses a cursor passed as ?after=<base64>. Base64 must NOT be
// percent-encoded — pass the raw cursor string in the query.
app.get("/api/blueprint-list", async (req, res) => {
  const apiKey = resolveKey(req);
  try {
    const allEdges = [];
    let cursor = null;
    const MAX_PAGES = 15; // up to ~150 blueprints

    for (let page = 0; page < MAX_PAGES; page++) {
      // Append cursor raw — the base64 chars the API uses (+, =, /) must not be encoded
      const url = cursor
        ? `${LEONARDO_BASE}/blueprints?after=${cursor}`
        : `${LEONARDO_BASE}/blueprints`;

      const r = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
      const text = await r.text();

      // Detect GraphQL-level errors (HTTP 200 but body is an error array/object)
      if (text.startsWith('[') || text.includes('"errors"')) break;

      let data;
      try { data = JSON.parse(text); } catch { break; }

      const edges = data?.blueprints?.edges;
      if (!Array.isArray(edges) || edges.length === 0) break;

      allEdges.push(...edges);
      const lastCursor = edges[edges.length - 1]?.cursor;
      if (!lastCursor || lastCursor === cursor) break;
      cursor = lastCursor;
    }

    res.json({ blueprints: { edges: allEdges } });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, version: "v2-rest-44", endpoint: "cloud.leonardo.ai/api/rest/v2" }));

app.listen(PORT, () => {
  console.log(`\n🚀  Leonardo proxy running on http://localhost:${PORT}`);
  console.log(`   API key: ${LEONARDO_API_KEY.slice(0, 8)}...${LEONARDO_API_KEY.slice(-4)}`);
  console.log(`\n   Endpoints:`);
  console.log(`   POST /api/generate       — start a V2 generation`);
  console.log(`   GET  /api/generation/:id — poll for results`);
  console.log(`   GET  /api/models         — list available models\n`);
});
