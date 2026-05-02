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
               :                   standardSystem;
  const user   = isInfographic   ? infographicUser
               : isMagazineCover ? magazineUser
               : isPrintAd       ? printAdUser
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

// ─── Health check ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true, version: "v2-rest-41", endpoint: "cloud.leonardo.ai/api/rest/v2" }));

app.listen(PORT, () => {
  console.log(`\n🚀  Leonardo proxy running on http://localhost:${PORT}`);
  console.log(`   API key: ${LEONARDO_API_KEY.slice(0, 8)}...${LEONARDO_API_KEY.slice(-4)}`);
  console.log(`\n   Endpoints:`);
  console.log(`   POST /api/generate       — start a V2 generation`);
  console.log(`   GET  /api/generation/:id — poll for results`);
  console.log(`   GET  /api/models         — list available models\n`);
});
