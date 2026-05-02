import { useState, useCallback, useRef, useEffect } from "react";
import { upload } from "@canva/asset";
import { addElementAtCursor, addElementAtPoint, editContent } from "@canva/design";
import "./styles.css";

// ─── V2 model dimension grids ────────────────────────────────────────────────

// Full verified grid for Nano Banana Pro (gemini-image-2) from API docs
const NB_PRO_DIMS = [
  672, 768, 848, 896, 928, 1024, 1152, 1200, 1264, 1376,
  1536, 1696, 1792, 1856, 2048, 2304, 2400, 2528, 2688,
  2752, 3072, 3392, 3584, 3712, 4096, 4608, 4800, 5056, 5504,
];

// Snap a dimension to the nearest value in a list
function snapToValid(val: number, validDims: number[]): number {
  return validDims.reduce((best, d) =>
    Math.abs(d - val) < Math.abs(best - val) ? d : best
  );
}

// GPT Image 2 four-constraint validator (returns list of issues)
function validateGptImage2(w: number, h: number): string[] {
  const issues: string[] = [];
  if (w % 16 !== 0) issues.push(`Width must be a multiple of 16`);
  if (h % 16 !== 0) issues.push(`Height must be a multiple of 16`);
  if (w > 3824) issues.push(`Width must be ≤ 3824px`);
  if (h > 3824) issues.push(`Height must be ≤ 3824px`);
  if (w > 0 && h > 0) {
    const ratio = Math.max(w, h) / Math.min(w, h);
    if (ratio > 3.0 + 1e-6) issues.push(`Aspect ratio must be ≤ 3:1 (currently ${ratio.toFixed(2)}:1)`);
    const px = w * h;
    if (px < 655360)   issues.push(`Too few pixels — minimum ~0.66MP`);
    if (px > 8294400)  issues.push(`Too many pixels — maximum ~8.3MP`);
  }
  return issues;
}

// V2 string model IDs (passed directly to Leonardo REST API)
// creditsPerImage: base API credit cost at 1024×1024 (1MP). GPT Image 2 scales with pixel area;
// others use a flat rate per image. Quality multipliers for GPT Image 2: low×0.5, medium×1, high×2.
const MODELS = [
  { id: "gpt-image-2",    name: "GPT Image 2",    maxRefs: 6, maxImages: 4, validDimensions: undefined as number[] | undefined, minDim: 512,  maxDim: 3824, multipleOf: 16, hasQuality: true,  creditsPerImage: 118, scalesWithRes: true  },
  { id: "gemini-image-2", name: "Nano Banana Pro", maxRefs: 6, maxImages: 4, validDimensions: NB_PRO_DIMS,                        minDim: 672,  maxDim: 5504, multipleOf: 1,  hasQuality: false, creditsPerImage: 50,  scalesWithRes: false },
  { id: "seedream-4.5",   name: "Seedream 4.5",    maxRefs: 6, maxImages: 4, validDimensions: undefined as number[] | undefined, minDim: 512,  maxDim: 4096, multipleOf: 8,  hasQuality: false, creditsPerImage: 50,  scalesWithRes: false },
  { id: "flux-2-pro",     name: "Flux.2 Pro",      maxRefs: 4, maxImages: 4, validDimensions: undefined as number[] | undefined, minDim: 256,  maxDim: 1440, multipleOf: 8,  hasQuality: false, creditsPerImage: 25,  scalesWithRes: false },
];

// Estimate API credit cost for a generation
function estimateCredits(model: typeof MODELS[0], w: number, h: number, qty: number, quality: string): number {
  let base = model.creditsPerImage;
  if (model.scalesWithRes) {
    // Scale with pixel area relative to 1MP baseline
    base = Math.round(base * (w * h) / (1024 * 1024));
    // Quality multiplier for GPT Image 2
    if (quality === "low")  base = Math.round(base * 0.5);
    if (quality === "high") base = Math.round(base * 2);
  }
  return base * qty;
}

// All presets verified valid for ALL four models:
// - NB Pro: grid values ✓   - GPT Image 2: mod-16, ratio ok, pixels ok ✓
// - Seedream 4.5: mod-8, in range ✓  - Flux 2 Pro: max 1440, mod-8 ✓
const STANDARD_SIZES = [
  { label: "16:9", w: 1376, h: 768  },
  { label: "1:1",  w: 1024, h: 1024 },
  { label: "2:3",  w: 848,  h: 1264 },
  { label: "3:2",  w: 1264, h: 848  },
  { label: "4:3",  w: 1200, h: 896  },
  { label: "9:16", w: 768,  h: 1376 },
];

const SOCIAL_SIZES = [
  { label: "Instagram", w: 928,  h: 1152 },
  { label: "TikTok",    w: 768,  h: 1376 },
  { label: "Twitter",   w: 1200, h: 896  },
  { label: "Facebook",  w: 1376, h: 768  },
];

const QUALITY_OPTIONS = ["low", "medium", "high"] as const;
type Quality = typeof QUALITY_OPTIONS[number];

interface RefImage {
  id: string;
  dataUrl: string;
  name: string;
}

// A reference image sourced from the user's Leonardo library (already on Leonardo's servers)
interface LibRefImage {
  id: string;   // Leonardo generated_image id — passed as type:"GENERATED"
  url: string;  // thumbnail URL for display only
  prompt: string;
}

interface LibraryImage {
  id: string;
  generationId: string;
  url: string;
  prompt: string;
  width: number;
  height: number;
  createdAt: string;
}


const BACKEND_URL = "https://leonardo-canva-app.onrender.com";
const API_KEY_STORAGE = "prism_leo_api_key";
const LIB_PICKER_PAGE_SIZE = 18; // 6×3 grid per page

async function insertIntoCanva(url: string, width: number, height: number) {
  // Route Leonardo CDN URLs through our proxy so Canva can fetch them without
  // hitting CORS restrictions or S3 signed-URL expiry on the client side.
  const proxyUrl = `${BACKEND_URL}/api/proxy-image?url=${encodeURIComponent(url)}`;
  const asset = await upload({
    type: "image",
    mimeType: "image/jpeg",
    url: proxyUrl,
    thumbnailUrl: proxyUrl,
    width,
    height,
    aiDisclosure: "app_generated",
  });
  // Try cursor-based insertion first (works in documents)
  // Fall back to point-based insertion (works in presentations/slides)
  try {
    await addElementAtCursor({
      type: "image",
      ref: asset.ref,
      altText: { text: "AI generated image", decorative: false },
    });
  } catch {
    await addElementAtPoint({
      type: "image",
      ref: asset.ref,
      altText: { text: "AI generated image", decorative: false },
      atPoint: { x: 50, y: 50 },
    });
  }
}

export function App() {
  const [tab, setTab]                   = useState<"generate" | "library" | "settings">(() =>
    localStorage.getItem(API_KEY_STORAGE) ? "generate" : "settings"
  );
  const [modelId, setModelId]           = useState(MODELS[0].id);
  const [quality, setQuality]           = useState<Quality>("medium");
  const [count, setCount]               = useState(1);
  const [width, setWidth]               = useState(1376);
  const [height, setHeight]             = useState(768);
  const [prompt, setPrompt]             = useState("");
  const [activePreset, setActivePreset] = useState("16:9");
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus]             = useState<string | null>(null);
  const [previewUrls, setPreviewUrls]   = useState<string[]>([]);
  const [error, setError]               = useState<string | null>(null);
  const [refImages, setRefImages]       = useState<RefImage[]>([]);
  const [libRefImages, setLibRefImages] = useState<LibRefImage[]>([]);
  const [refWarning, setRefWarning]     = useState<string | null>(null);
  const [dimErrors, setDimErrors]       = useState<string[]>([]);
  const fileInputRef                    = useRef<HTMLInputElement>(null);

  // Library picker modal state
  const [showLibPicker, setShowLibPicker]         = useState(false);
  const [libPickerImages, setLibPickerImages]     = useState<LibraryImage[]>([]);
  const [libPickerLoading, setLibPickerLoading]   = useState(false);
  const [libPickerError, setLibPickerError]       = useState<string | null>(null);
  const [libPickerSelected, setLibPickerSelected] = useState<Set<string>>(new Set());
  const [libPickerPage, setLibPickerPage]         = useState(0);

  // API key state
  const [apiKey, setApiKey]           = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [apiKeyInput, setApiKeyInput] = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [apiKeySaved, setApiKeySaved] = useState(false);

  // Balance state
  const [balance, setBalance]               = useState<number | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceFailed, setBalanceFailed]   = useState(false);   // showed loading but couldn't get a number

  // Help modal state
  const [showHelp, setShowHelp] = useState(false);

  // Magic Layers concept modal
  const [showMagicLayers, setShowMagicLayers] = useState(false);

  // Spark Prompt state
  const [sparkLoading,    setSparkLoading]    = useState(false);
  const [sparkError,      setSparkError]      = useState<string | null>(null);
  const [promptStyle,     setPromptStyle]     = useState("Photography");
  const [showStyleModal,  setShowStyleModal]  = useState(false);
  const [sparkSlideImage, setSparkSlideImage] = useState<string | null>(null); // base64 JPEG of pasted slide

  // Key diagnostic state
  const [keyTestResult, setKeyTestResult]   = useState<string | null>(null);
  const [keyTestLoading, setKeyTestLoading] = useState(false);

  // ── Build headers with optional user API key ──────────────────────────────
  // IMPORTANT: must be defined BEFORE fetchBalance so the closure is correct.
  const buildHeaders = useCallback((extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...extra };
    if (apiKey.trim()) h["x-leo-api-key"] = apiKey.trim();
    return h;
  }, [apiKey]);

  // Extract a numeric credit value from the proxy's /api/balance response.
  // The proxy returns all known Leonardo credit fields at the top level —
  // different plan types use different field names, so we try each in order.
  function extractCredit(data: Record<string, unknown>): number | null {
    const candidates = [
      data.apiCredit,
      data.apiCreditBalance,
      data.apiPaidTokens,
      data.apiSubscriptionTokens,
      data.tokenBalance,
      data.credits,
      data.userApiCredit,
    ];
    for (const c of candidates) {
      if (c != null) {
        const n = Number(c);
        if (!isNaN(n)) return n;
      }
    }
    return null;
  }

  // Fetch balance via the Render proxy — the scalable path for all users.
  // Render server calls Leonardo /me server-side with the user's key,
  // keeping API keys out of browser network traffic.
  const fetchBalance = useCallback(async () => {
    if (!apiKey.trim()) return;
    setBalanceLoading(true);
    setBalanceFailed(false);
    const RETRIES = 4;
    const DELAY   = 8000; // wait for Render free-tier cold start if needed
    for (let i = 0; i < RETRIES; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, DELAY));
      try {
        const res = await fetch(`${BACKEND_URL}/api/balance`, { headers: buildHeaders() });
        if (!res.ok) continue;
        const data = await res.json() as Record<string, unknown>;
        const credit = extractCredit(data);
        if (credit !== null) {
          setBalance(credit);
          setBalanceLoading(false);
          setBalanceFailed(false);
          return;
        }
      } catch { /* retry */ }
    }
    setBalanceLoading(false);
    setBalanceFailed(true);
  }, [buildHeaders, apiKey]);

  // Fetch balance when API key is set
  useEffect(() => {
    if (apiKey) fetchBalance();
  }, [apiKey, fetchBalance]);

  // Library state
  const [libraryImages, setLibraryImages]       = useState<LibraryImage[]>([]);
  const [libraryLoading, setLibraryLoading]     = useState(false);
  const [libraryError, setLibraryError]         = useState<string | null>(null);
  const [libraryAddingId, setLibraryAddingId]   = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId]   = useState<string | null>(null);
  const [deletingId, setDeletingId]             = useState<string | null>(null);


  const currentModel = MODELS.find((m) => m.id === modelId)!;

  // Total refs across both sources
  const totalRefs = refImages.length + libRefImages.length;

  // Pagination helpers for lib picker
  const libPickerTotalPages = Math.ceil(libPickerImages.length / LIB_PICKER_PAGE_SIZE);
  const libPickerPageImages = libPickerImages.slice(
    libPickerPage * LIB_PICKER_PAGE_SIZE,
    (libPickerPage + 1) * LIB_PICKER_PAGE_SIZE
  );

  // Open library picker — fetch images on first open
  const openLibPicker = useCallback(async () => {
    setShowLibPicker(true);
    setLibPickerSelected(new Set());
    setLibPickerPage(0);
    if (libPickerImages.length > 0) return; // already loaded
    setLibPickerLoading(true);
    setLibPickerError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/library?limit=180`, { headers: buildHeaders() });
      if (!res.ok) throw new Error("Failed to load library");
      const data = await res.json();
      setLibPickerImages(data.images || []);
    } catch (err: any) {
      setLibPickerError(err.message || "Failed to load library");
    } finally {
      setLibPickerLoading(false);
    }
  }, [libPickerImages.length, buildHeaders]);

  const toggleLibPickerItem = useCallback((id: string) => {
    setLibPickerSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); return next; }
      const slotsLeft = currentModel.maxRefs - totalRefs;
      if (next.size >= slotsLeft) return prev; // at cap
      next.add(id);
      return next;
    });
  }, [currentModel.maxRefs, totalRefs]);

  const confirmLibPicker = useCallback(() => {
    const toAdd = libPickerImages
      .filter((img) => libPickerSelected.has(img.id))
      .map((img) => ({ id: img.id, url: img.url, prompt: img.prompt }));
    setLibRefImages((prev) => {
      const existingIds = new Set(prev.map((r) => r.id));
      return [...prev, ...toAdd.filter((a) => !existingIds.has(a.id))];
    });
    setShowLibPicker(false);
  }, [libPickerImages, libPickerSelected]);

  // Live dimension validation (GPT Image 2 has 4 simultaneous constraints)
  useEffect(() => {
    if (modelId === "gpt-image-2") {
      setDimErrors(validateGptImage2(width, height));
    } else {
      setDimErrors([]);
    }
  }, [modelId, width, height]);

  // Save API key
  const handleSaveApiKey = () => {
    const trimmed = apiKeyInput.trim();
    setApiKey(trimmed);
    localStorage.setItem(API_KEY_STORAGE, trimmed);
    setApiKeySaved(true);
    setKeyTestResult(null);
    setTimeout(() => {
      setApiKeySaved(false);
      setTab("generate");
    }, 1000);
  };

  // Test the API key via the Render proxy — shows exactly what Leonardo returns
  const handleTestKey = async () => {
    const key = apiKeyInput.trim() || apiKey.trim();
    if (!key) return;
    setKeyTestLoading(true);
    setKeyTestResult(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/test-key`, {
        headers: { "x-leo-api-key": key },
      });
      const data = await res.json();
      if (!res.ok) {
        setKeyTestResult(`❌ Error ${res.status}: ${data.error || "Unknown error"}`);
        return;
      }
      const cf = data.creditFields || {};
      const credit = extractCredit(cf);
      const lines = [
        `✓ Connected as: ${data.username || data.userId || "(unknown)"}`,
        `─────────────────────────`,
        `apiCredit:             ${cf.apiCredit            ?? "null"}`,
        `apiCreditBalance:      ${cf.apiCreditBalance     ?? "null"}`,
        `apiPaidTokens:         ${cf.apiPaidTokens        ?? "null"}`,
        `apiSubscriptionTokens: ${cf.apiSubscriptionTokens ?? "null"}`,
        `tokenBalance:          ${cf.tokenBalance         ?? "null"}`,
        `credits:               ${cf.credits              ?? "null"}`,
        `─────────────────────────`,
        `→ Balance will show: ${credit !== null ? credit.toLocaleString() : "— (all fields null)"}`,
      ];
      setKeyTestResult(lines.join("\n"));
      if (credit !== null) { setBalance(credit); setBalanceFailed(false); }
      else setBalanceFailed(true);
    } catch (err: any) {
      setKeyTestResult(`❌ Network error: ${err.message}`);
    } finally {
      setKeyTestLoading(false);
    }
  };

  // ── Spark Prompt ─────────────────────────────────────────────────────────────
  // Step 1: clicking the button opens the style picker modal
  // Step 2: confirming in the modal fires the actual generation
  const handleSparkPrompt = useCallback(() => {
    setSparkError(null);
    setShowStyleModal(true);
  }, []);

  // Handle image paste inside the style modal (for slide screenshot)
  const handleStyleModalPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const reader = new FileReader();
        reader.onload = () => {
          const result = reader.result as string;
          setSparkSlideImage(result); // store full data URL
        };
        reader.readAsDataURL(blob);
        break;
      }
    }
  }, []);

  const handleSparkGenerate = useCallback(async () => {
    setShowStyleModal(false);
    setSparkLoading(true);
    setSparkError(null);

    // Read richtext content from the current page
    let slideText = "";
    try {
      await editContent(
        { contentType: "richtext", target: "current_page" },
        async (session) => {
          const parts: string[] = [];
          for (const range of session.contents) {
            const text = range.readPlaintext().trim();
            if (text) parts.push(text);
          }
          slideText = parts.join(" • ");
        }
      );
    } catch {
      // Content querying unavailable — proceed without slide text
    }

    // Extract base64 from pasted slide image (strip data URL prefix)
    const slideImageB64 = sparkSlideImage
      ? sparkSlideImage.split(",")[1] || null
      : null;

    // Call backend /api/magic-prompt
    try {
      const res = await fetch(`${BACKEND_URL}/api/magic-prompt`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ slideText, modelId, promptStyle, slideImage: slideImageB64 }),
      });
      const data = await res.json() as Record<string, string>;
      if (!res.ok) {
        setSparkError(data.message || "Spark Prompt failed");
        return;
      }
      if (data.prompt) {
        setPrompt(data.prompt);
        setSparkSlideImage(null); // clear after use
      }
    } catch {
      setSparkError("Network error — is Render running?");
    } finally {
      setSparkLoading(false);
    }
  }, [buildHeaders, modelId, promptStyle, sparkSlideImage]);

  // When model changes, trim refs, snap dimensions, and cap count
  const handleModelChange = useCallback((newId: string) => {
    const newModel = MODELS.find((m) => m.id === newId)!;
    setModelId(newId);
    setRefWarning(null);
    setError(null);

    // Cap count to this model's max
    setCount((prev) => Math.min(prev, newModel.maxImages));

    // Snap dimensions if this model requires specific values
    if (newModel.validDimensions) {
      setWidth((prev) => snapToValid(prev, newModel.validDimensions!));
      setHeight((prev) => snapToValid(prev, newModel.validDimensions!));
    }

    // Trim refs if the new model allows fewer
    setRefImages((prev) => {
      const combined = prev.length; // will check total after lib refs set too
      if (combined > newModel.maxRefs) {
        return prev.slice(0, newModel.maxRefs);
      }
      return prev;
    });
    setLibRefImages((prev) => {
      const totalAfterFileTrim = Math.min(refImages.length, newModel.maxRefs);
      const libSlots = newModel.maxRefs - totalAfterFileTrim;
      if (prev.length > libSlots) {
        setRefWarning(
          `${newModel.name} supports up to ${newModel.maxRefs} reference images total. Some were removed.`
        );
        return prev.slice(0, Math.max(0, libSlots));
      }
      return prev;
    });
  }, []);

  const fetchLibrary = useCallback(async () => {
    setLibraryLoading(true);
    setLibraryError(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/library?limit=40`, {
        headers: buildHeaders(),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || `Error ${res.status}`);
      }
      const data = await res.json();
      setLibraryImages(data.images || []);
    } catch (err: any) {
      setLibraryError(err.message || "Failed to load library.");
    } finally {
      setLibraryLoading(false);
    }
  }, [buildHeaders]);

  useEffect(() => {
    if (tab === "library") fetchLibrary();
  }, [tab, fetchLibrary]);

  const handleLibraryAddToSlide = async (img: LibraryImage) => {
    setLibraryAddingId(img.id);
    try {
      await insertIntoCanva(img.url, img.width, img.height);
    } catch (err: any) {
      setLibraryError("Couldn't add to slide: " + err.message);
    } finally {
      setLibraryAddingId(null);
    }
  };

  const handleDeleteConfirmed = async () => {
    const img = libraryImages.find((i) => i.id === confirmDeleteId);
    if (!img) return;
    setDeletingId(img.id);
    setConfirmDeleteId(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/generation/${img.generationId}`, {
        method: "DELETE",
        headers: buildHeaders(),
      });
      if (!res.ok) {
        const e = await res.json().catch(() => ({}));
        throw new Error(e.message || `Error ${res.status}`);
      }
      setLibraryImages((prev) => prev.filter((i) => i.generationId !== img.generationId));
    } catch (err: any) {
      setLibraryError("Couldn't delete: " + err.message);
    } finally {
      setDeletingId(null);
    }
  };

  const handleRefUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    const remaining = currentModel.maxRefs - refImages.length;
    const toAdd = files.slice(0, remaining);

    toAdd.forEach((file) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        setRefImages((prev) => {
          if (prev.length >= currentModel.maxRefs) return prev;
          return [
            ...prev,
            { id: crypto.randomUUID(), dataUrl: ev.target!.result as string, name: file.name },
          ];
        });
      };
      reader.readAsDataURL(file);
    });
    e.target.value = "";
  }, [refImages.length, currentModel.maxRefs]);

  const removeRef = useCallback((id: string) => {
    setRefImages((prev) => prev.filter((r) => r.id !== id));
    setRefWarning(null);
  }, []);

  const selectPreset = useCallback((label: string, w: number, h: number) => {
    setActivePreset(label);
    setWidth(w);
    setHeight(h);
  }, []);

  const pollForImages = async (generationId: string): Promise<string[]> => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(`${BACKEND_URL}/api/generation/${generationId}`, {
        headers: buildHeaders(),
      });
      if (!pollRes.ok) continue;
      const data = await pollRes.json();
      const gen = data.generations_by_pk;
      if (gen?.status === "COMPLETE") return gen.generated_images.map((img: any) => img.url);
      if (gen?.status === "FAILED") throw new Error("Generation failed. Try a different prompt.");
      setStatus(`Generating... (~${(30 - i - 1) * 3}s left)`);
    }
    throw new Error("Generation timed out. Try again.");
  };

  const handleGenerate = useCallback(async () => {
    if (!prompt.trim()) { setError("Please enter a prompt."); return; }
    setError(null); setPreviewUrls([]); setIsGenerating(true);
    setStatus("Sending to Leonardo...");
    try {
      const genRes = await fetch(`${BACKEND_URL}/api/generate`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          modelId,
          prompt: prompt.trim(),
          width,
          height,
          num_images: count,
          quality,
          refImages:    refImages.map((r) => r.dataUrl),        // base64 → uploaded
          refImageIds:  libRefImages.map((r) => r.id),          // already on Leonardo → type:GENERATED
        }),
      });
      if (!genRes.ok) {
        const e = await genRes.json().catch(() => ({}));
        throw new Error(e.message || `Error ${genRes.status}`);
      }
      const { generationId } = await genRes.json();
      setStatus("Generating... (10–30s)");
      const urls = await pollForImages(generationId);
      setPreviewUrls(urls);
      fetchBalance(); // refresh balance after generation
      setStatus("Done! Adding to slide...");
      try {
        await insertIntoCanva(urls[0], width, height);
        setStatus("✓ Image added to your slide!");
      } catch {
        setStatus("✓ Done! Click a result to add it to your slide.");
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
      setStatus(null);
    } finally {
      setIsGenerating(false);
    }
  }, [modelId, prompt, width, height, count, quality, refImages, buildHeaders]);

  const handleAddToSlide = async (url: string) => {
    setIsGenerating(true);
    setStatus("Adding to slide...");
    try {
      await insertIntoCanva(url, width, height);
      setStatus("✓ Added!");
    } catch (err: any) {
      setError("Couldn't add to slide: " + err.message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="app">

      {/* Library reference picker modal */}
      {showLibPicker && (
        <div className="modal-overlay" onClick={() => setShowLibPicker(false)}>
          <div className="lib-picker" onClick={(e) => e.stopPropagation()}>
            <div className="lib-picker-header">
              <span className="lib-picker-title">Add from library</span>
              <button className="lib-picker-close" onClick={() => setShowLibPicker(false)}>×</button>
            </div>
            <div className="lib-picker-sub">
              Select up to {currentModel.maxRefs - totalRefs} image{currentModel.maxRefs - totalRefs !== 1 ? "s" : ""}
            </div>

            {libPickerLoading && <div className="lib-picker-empty">Loading your library...</div>}
            {libPickerError  && <div className="lib-picker-empty lib-picker-err">{libPickerError}</div>}
            {!libPickerLoading && !libPickerError && libPickerImages.length === 0 && (
              <div className="lib-picker-empty">No images in your library yet. Generate some first!</div>
            )}

            {libPickerImages.length > 0 && (
              <>
                <div className="lib-picker-grid">
                  {libPickerPageImages.map((img) => {
                    const alreadyAdded = libRefImages.some((r) => r.id === img.id);
                    const selected = libPickerSelected.has(img.id);
                    return (
                      <div
                        key={img.id}
                        className={`lib-picker-item ${selected ? "selected" : ""} ${alreadyAdded ? "already-added" : ""}`}
                        onClick={() => !alreadyAdded && toggleLibPickerItem(img.id)}
                        title={img.prompt}
                      >
                        <img src={img.url} alt={img.prompt} className="lib-picker-thumb" />
                        {selected    && <div className="lib-picker-check">✓</div>}
                        {alreadyAdded && <div className="lib-picker-check lib-picker-check-added">✦</div>}
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {libPickerTotalPages > 1 && (
                  <div className="lib-picker-pagination">
                    <button
                      className="lib-page-btn"
                      onClick={() => setLibPickerPage((p) => Math.max(0, p - 1))}
                      disabled={libPickerPage === 0}
                    >‹</button>
                    <span className="lib-page-info">
                      {libPickerPage + 1} / {libPickerTotalPages}
                    </span>
                    <button
                      className="lib-page-btn"
                      onClick={() => setLibPickerPage((p) => Math.min(libPickerTotalPages - 1, p + 1))}
                      disabled={libPickerPage >= libPickerTotalPages - 1}
                    >›</button>
                  </div>
                )}
              </>
            )}

            <div className="lib-picker-footer">
              <button className="modal-cancel" onClick={() => setShowLibPicker(false)}>Cancel</button>
              <button
                className="generate-btn lib-picker-confirm"
                onClick={confirmLibPicker}
                disabled={libPickerSelected.size === 0}
              >
                Add {libPickerSelected.size > 0 ? libPickerSelected.size : ""} image{libPickerSelected.size !== 1 ? "s" : ""}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation modal */}
      {confirmDeleteId && (
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-title">Delete image?</div>
            <p className="modal-body">This will permanently delete this image from Prism and your Leonardo account. This cannot be undone.</p>
            <div className="modal-actions">
              <button className="modal-cancel" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="modal-delete" onClick={handleDeleteConfirmed}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {/* Help modal */}
      {showHelp && (
        <div className="modal-overlay" onClick={() => setShowHelp(false)}>
          <div className="modal help-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">How to use Prism</div>
            <div className="help-content">
              <div className="help-section">
                <div className="help-h">🔑 Connect your account</div>
                <p>Tap ⚙︎ Settings, paste your Leonardo API key and hit Save. Your key is stored only on this device.</p>
              </div>
              <div className="help-section">
                <div className="help-h">🎨 Generate tab</div>
                <p><strong>Model</strong> — choose GPT Image 2, Nano Banana Pro, Seedream 4.5, or Flux.2 Pro. Each has different strengths and credit costs.</p>
                <p><strong>Quality</strong> — GPT Image 2 only. Low uses fewer credits; High produces sharper results.</p>
                <p><strong>Size</strong> — pick a standard ratio or social preset, or drag the sliders for a custom size.</p>
                <p><strong>Reference images</strong> — optionally add up to 6 images to guide the style or composition. Use "+ From computer" to upload, or "+ From library" to pick from your previous generations.</p>
                <p><strong>Prompt</strong> — describe the image. Be specific for best results.</p>
                <p><strong>Generate button</strong> — shows the estimated credit cost before you click. The first result is added to your slide automatically.</p>
              </div>
              <div className="help-section">
                <div className="help-h">✨ Spark Prompt</div>
                <p>Spark Prompt uses AI to write a Leonardo prompt based on your slide content — so you don't have to. Click <strong>✨ Spark Prompt</strong> in the Generate tab, pick a visual style (Photography, Magazine Cover, 3D / CGI, Infographic, etc.), then hit <strong>Generate Prompt</strong>. Gemini reads the text on your current slide and writes a prompt tailored to the style you chose. You can edit the prompt before generating.</p>
              </div>
              <div className="help-section">
                <div className="help-h">🖼 Library tab</div>
                <p>Browse all your past generations. Click "+ Add to slide" to insert any image, or the 🗑 icon to delete it from your Leonardo account.</p>
              </div>
              <div className="help-section">
                <div className="help-h">🪙 Credits</div>
                <p>Your balance shows in the top-right corner. It refreshes automatically after each generation. Credits renew monthly on your Leonardo plan.</p>
              </div>
              <div className="help-section">
                <div className="help-h">💡 Tips</div>
                <p>Add a reference image to match an existing slide's visual style. Use 9:16 for full-bleed portrait slides, 16:9 for landscape backgrounds.</p>
              </div>
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="modal-cancel" style={{ flex: "none", width: "100%" }} onClick={() => setShowHelp(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Magic Layers concept modal */}
      {showMagicLayers && (
        <div className="modal-overlay" onClick={() => setShowMagicLayers(false)}>
          <div className="modal magic-layers-modal" onClick={(e) => e.stopPropagation()}>
            <div className="ml-modal-header">
              <div className="ml-modal-icon">
                <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="4" y="14" width="24" height="14" rx="3" fill="rgba(110,96,238,0.15)" stroke="#6E60EE" strokeWidth="1.5"/>
                  <rect x="7" y="9" width="18" height="14" rx="3" fill="rgba(110,96,238,0.25)" stroke="#6E60EE" strokeWidth="1.5"/>
                  <rect x="10" y="4" width="12" height="14" rx="3" fill="rgba(110,96,238,0.45)" stroke="#6E60EE" strokeWidth="1.5"/>
                  <circle cx="24" cy="8" r="4" fill="#6E60EE"/>
                  <path d="M22.5 8l1 1 2-2" stroke="white" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
              </div>
              <div>
                <div className="ml-modal-title">Magic Layers</div>
                <div className="ml-modal-badge">Concept · Coming Soon</div>
              </div>
            </div>
            <p className="ml-modal-body">
              Magic Layers will combine your Prism-generated image with Canva's AI to automatically build a layered, production-ready slide — background, text placement, and design elements — in one click.
            </p>
            <div className="ml-modal-steps">
              <div className="ml-step"><span className="ml-step-num">1</span>Generate your image with Prism</div>
              <div className="ml-step"><span className="ml-step-num">2</span>Hit Magic Layers</div>
              <div className="ml-step"><span className="ml-step-num">3</span>Canva splits your image into editable layers</div>
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="modal-cancel" style={{ flex: "none", width: "100%" }} onClick={() => setShowMagicLayers(false)}>Got it</button>
            </div>
          </div>
        </div>
      )}

      {/* Style picker modal — opens when user clicks Spark Prompt */}
      {showStyleModal && (
        <div className="modal-overlay" onClick={() => setShowStyleModal(false)}>
          <div className="modal style-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">Select your style of image</div>
            <p className="style-modal-sub">Spark Prompt reads your slide and finds a visual that amplifies the feeling — not a literal illustration.</p>

            <div className="style-modal-grid">
              {[
                { label: "Photography",           icon: "📷" },
                { label: "Illustration",          icon: "🎨" },
                { label: "Magazine Cover",        icon: "📰" },
                { label: "Abstract",              icon: "🌀" },
                { label: "3D / CGI",              icon: "🧊" },
                { label: "Cinematic / Film",      icon: "🎬" },
                { label: "Stylized / Aesthetic",  icon: "✨" },
                { label: "Print Ad",              icon: "🖨️" },
                { label: "Graphic Design",        icon: "✏️" },
                { label: "Infographic",           icon: "📊" },
                { label: "Canvafy Me",            icon: "💎" },
              ].map(({ label, icon }) => (
                <button
                  key={label}
                  className={`style-card ${promptStyle === label ? "active" : ""} ${label === "Canvafy Me" ? "style-card--wide" : ""}`}
                  onClick={() => setPromptStyle(label)}
                >
                  <span className="style-card-icon">{icon}</span>
                  <span className="style-card-label">{label}</span>
                </button>
              ))}
            </div>
            <div className="modal-actions" style={{ marginTop: 16 }}>
              <button className="modal-cancel" onClick={() => setShowStyleModal(false)}>Cancel</button>
              <button className="generate-btn" style={{ flex: 1, padding: "10px", fontSize: "13px" }} onClick={handleSparkGenerate}>
                ✨ Generate Prompt
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="header">
        <div className="header-top-row">
          <div className="logo">
            <svg className="logo-svg" viewBox="0 0 250 267" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M238.535 0C241.97 0 244.192 3.63035 242.629 6.68935L213.985 62.7452C212.422 65.8042 214.644 69.4346 218.079 69.4346H229.417C232.821 69.4346 235.044 73.0045 233.543 76.0593L193.858 156.832C193.21 158.15 193.231 159.697 193.914 160.997L249.133 266.146C249.136 266.151 249.13 266.157 249.125 266.154C249.124 266.154 249.123 266.153 249.122 266.153H58.2702C54.5257 266.153 52.3518 261.916 54.5356 258.875L87.2882 213.255C89.472 210.213 87.2981 205.977 83.5536 205.977H25.9329C22.703 205.977 20.48 202.733 21.645 199.721L46.6378 135.092C47.8028 132.079 45.5798 128.836 42.3499 128.836H4.60343C1.17468 128.836 -1.04751 125.218 0.502821 122.16L61.1532 2.51866C61.9364 0.973637 63.5216 0 65.2538 0H238.535ZM116.313 69.6123C97.1988 69.6125 80.6022 79.6743 72.2754 94.4548C71.567 95.7123 71.5673 97.2465 72.2763 98.5036C80.6035 113.268 97.1995 123.337 116.313 123.337C135.426 123.337 152.023 113.276 160.358 98.5046C161.068 97.247 161.068 95.7118 160.359 94.4539C152.031 79.6819 135.426 69.6123 116.313 69.6123ZM116.314 80.207C125.824 80.207 133.53 87.3984 133.531 96.2822C133.531 105.166 125.824 112.367 116.314 112.367C106.803 112.367 99.0979 105.175 99.0979 96.2822C99.0981 87.3892 106.804 80.2072 116.314 80.207Z" fill="#6E60EE"/>
            </svg>
            <div className="logo-text-group">
              <span className="logo-text">Prism</span>
              <a href="https://www.leonardo.ai" target="_blank" rel="noopener noreferrer" className="logo-badge">by Leonardo.AI</a>
            </div>
          </div>
          <div className="header-right">
            {/* Loading state */}
            {balanceLoading && (
              <div className="balance-pill balance-pill-loading" title="Loading balance...">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/></svg>
                ···
              </div>
            )}
            {/* Loaded — show numeric balance */}
            {!balanceLoading && balance !== null && (
              <div className="balance-pill" title="API credits available — click to refresh" onClick={fetchBalance} style={{ cursor: "pointer" }}>
                {/* Coin stack icon matching Leonardo's UI */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><ellipse cx="12" cy="6" rx="8" ry="3"/><path d="M4 6v4c0 1.657 3.582 3 8 3s8-1.343 8-3V6"/><path d="M4 10v4c0 1.657 3.582 3 8 3s8-1.343 8-3v-4"/><path d="M4 14v4c0 1.657 3.582 3 8 3s8-1.343 8-3v-4"/></svg>
                {balance.toLocaleString()}
              </div>
            )}
            {/* Couldn't fetch — show dash so user knows key is connected */}
            {!balanceLoading && balance === null && balanceFailed && apiKey.trim() && (
              <div className="balance-pill balance-pill-unknown" title="Balance unavailable — click to retry" onClick={fetchBalance} style={{ cursor: "pointer" }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2"/><path d="M8 12h8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
                —
              </div>
            )}
            <button className="help-btn" onClick={() => setShowHelp(true)} title="Help">?</button>
          </div>
        </div>
        <p className="header-sub">Top image models at your command, right inside Canva.</p>
      </div>

      {/* Tab switcher */}
      <div className="tab-switcher">
        <button className={`tab-btn ${tab === "generate" ? "active" : ""}`} onClick={() => setTab("generate")}>Generate</button>
        <button className={`tab-btn ${tab === "library"  ? "active" : ""}`} onClick={() => setTab("library")}>Library</button>
        <button className={`tab-btn tab-btn-gear ${tab === "settings" ? "active" : ""}`} onClick={() => setTab("settings")} title="API Settings">⚙︎</button>
      </div>

      {/* ── SETTINGS TAB ── */}
      {tab === "settings" && (
        <div className="settings-section">

          {!apiKey && (
            <div className="onboarding-banner">
              <div className="onboarding-title">Welcome to Prism 👋</div>
              <p className="onboarding-sub">Before you start generating, connect your Leonardo account. This only takes 2 minutes and you only do it once.</p>
            </div>
          )}

          <div className="section">
            <label className="label">{apiKey ? "UPDATE API KEY" : "STEP 1 — PASTE YOUR API KEY"}</label>
            <input
              type="password"
              className="api-key-input"
              placeholder="Paste your Leonardo API key here..."
              value={apiKeyInput}
              onChange={(e) => setApiKeyInput(e.target.value)}
            />
            <button
              className={`save-key-btn ${apiKeySaved ? "saved" : ""}`}
              onClick={handleSaveApiKey}
              disabled={!apiKeyInput.trim()}
            >
              {apiKeySaved ? "✓ Saved! Taking you to Generate..." : apiKey ? "Update Key" : "Save & Start Generating →"}
            </button>
            {apiKey && <div className="key-status">✓ Key connected — you're all set.</div>}

            {/* Test Connection — shows raw credit fields from Leonardo */}
            {(apiKey || apiKeyInput.trim()) && (
              <button
                className="test-key-btn"
                onClick={handleTestKey}
                disabled={keyTestLoading}
              >
                {keyTestLoading ? "Testing..." : "🔍 Test Connection & Check Balance"}
              </button>
            )}
            {keyTestResult && (
              <pre className="key-test-result">{keyTestResult}</pre>
            )}
          </div>

          <div className="how-to">
            <div className="how-to-title">{apiKey ? "How to get a new key" : "How to get your API key from Leonardo"}</div>
            <ol className="how-to-list">
              <li>Go to <strong>leonardo.ai</strong> and sign up for a free account (or log in).</li>
              <li>Once logged in, click your <strong>profile icon</strong> in the top-right corner.</li>
              <li>Select <strong>"User Settings"</strong> from the dropdown menu.</li>
              <li>Scroll down to the <strong>"API Key"</strong> section.</li>
              <li>Click <strong>"Create New Key"</strong> and give it a name like "Prism".</li>
              <li>Copy the key that appears — it's a long string of letters and numbers.</li>
              <li>Paste it into the field above and tap <strong>Save & Start Generating</strong>.</li>
            </ol>
            <div className="how-to-note">Your key is stored only on your device and never shared with anyone.</div>
          </div>
        </div>
      )}

      {/* ── LIBRARY TAB ── */}
      {tab === "library" && (
        <div className="library-section">
          <div className="library-toolbar">
            <span className="label">RECENT IMAGES</span>
            <button className="refresh-btn" onClick={fetchLibrary} disabled={libraryLoading}>
              {libraryLoading ? "Loading..." : "↻ Refresh"}
            </button>
          </div>

          {libraryError && <div className="error-banner">{libraryError}</div>}

          {libraryLoading && libraryImages.length === 0 && (
            <div className="library-empty">Loading your images...</div>
          )}

          {!libraryLoading && libraryImages.length === 0 && !libraryError && (
            <div className="library-empty">No images yet — generate some first!</div>
          )}

          {libraryImages.length > 0 && (
            <div className="library-grid">
              {libraryImages.map((img) => (
                <div key={img.id} className="library-item">
                  <div className="library-thumb-wrap">
                    <img src={img.url} alt={img.prompt} className="library-thumb" title={img.prompt} />
                    <button
                      className="library-trash"
                      onClick={() => setConfirmDeleteId(img.id)}
                      disabled={deletingId === img.id}
                      title="Delete image"
                    >
                      {deletingId === img.id ? "…" : "🗑"}
                    </button>
                  </div>
                  <div className="library-prompt">{img.prompt}</div>
                  <button
                    className="add-btn"
                    onClick={() => handleLibraryAddToSlide(img)}
                    disabled={libraryAddingId === img.id}
                  >
                    {libraryAddingId === img.id ? "Adding..." : "+ Add to slide"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── GENERATE TAB ── */}
      {tab === "generate" && (
      <>
      {/* Model */}
      <div className="section">
        <label className="label">MODEL</label>
        <select className="select" value={modelId} onChange={(e) => handleModelChange(e.target.value)} disabled={isGenerating}>
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

      {/* Quality + Count */}
      <div className="row-3col">
        <div className="section">
          <label className="label">QUALITY</label>
          <div className={`quality-picker ${!currentModel.hasQuality ? "picker-disabled" : ""}`}>
            {QUALITY_OPTIONS.map((q) => (
              <button
                key={q}
                className={`quality-btn ${quality === q && currentModel.hasQuality ? "active" : ""}`}
                onClick={() => currentModel.hasQuality && setQuality(q)}
                disabled={isGenerating || !currentModel.hasQuality}
              >{q}</button>
            ))}
          </div>
          {!currentModel.hasQuality && (
            <div className="feature-tooltip">
              Not available with {currentModel.name}
            </div>
          )}
        </div>
        <div className="section">
          <label className="label">COUNT</label>
          <select className="count-select" value={count} onChange={(e) => setCount(+e.target.value)} disabled={isGenerating}>
            {[1, 2, 3, 4].filter((n) => n <= currentModel.maxImages).map((n) => (
              <option key={n} value={n}>{n} {n === 1 ? "image" : "images"}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Size presets */}
      <div className="section">
        <label className="label">STANDARD</label>
        <div className="preset-grid">
          {STANDARD_SIZES.map((s) => (
            <button key={s.label} className={`preset-btn ${activePreset === s.label ? "active" : ""}`} onClick={() => selectPreset(s.label, s.w, s.h)} disabled={isGenerating}>{s.label}</button>
          ))}
        </div>
      </div>

      <div className="section">
        <label className="label">SOCIAL</label>
        <div className="preset-grid">
          {SOCIAL_SIZES.map((s) => (
            <button key={s.label} className={`preset-btn ${activePreset === s.label ? "active" : ""}`} onClick={() => selectPreset(s.label, s.w, s.h)} disabled={isGenerating}>{s.label}</button>
          ))}
        </div>
      </div>

      {/* Width / Height — dropdowns for grid models, sliders for range models */}
      {currentModel.validDimensions ? (
        <div className="section">
          <div className="slider-row"><label className="label">WIDTH</label><span className="slider-val">{width}</span></div>
          <select className="select" value={width} onChange={(e) => { setWidth(+e.target.value); setActivePreset("custom"); }} disabled={isGenerating}>
            {currentModel.validDimensions.map((d) => <option key={d} value={d}>{d}px</option>)}
          </select>
          <div className="slider-row" style={{ marginTop: 8 }}><label className="label">HEIGHT</label><span className="slider-val">{height}</span></div>
          <select className="select" value={height} onChange={(e) => { setHeight(+e.target.value); setActivePreset("custom"); }} disabled={isGenerating}>
            {currentModel.validDimensions.map((d) => <option key={d} value={d}>{d}px</option>)}
          </select>
          <div className="size-info">{width} × {height} — {((width * height) / 1000000).toFixed(2)} MP</div>
        </div>
      ) : (
        <div className="section">
          <div className="slider-row"><label className="label">WIDTH</label><span className="slider-val">{width}</span></div>
          <input type="range"
            min={currentModel.minDim} max={currentModel.maxDim} step={currentModel.multipleOf}
            value={width}
            onChange={(e) => { setWidth(+e.target.value); setActivePreset("custom"); }}
            disabled={isGenerating} className="slider" />
          <div className="slider-row" style={{ marginTop: 8 }}><label className="label">HEIGHT</label><span className="slider-val">{height}</span></div>
          <input type="range"
            min={currentModel.minDim} max={currentModel.maxDim} step={currentModel.multipleOf}
            value={height}
            onChange={(e) => { setHeight(+e.target.value); setActivePreset("custom"); }}
            disabled={isGenerating} className="slider" />
          <div className="size-info">{width} × {height} — {((width * height) / 1000000).toFixed(2)} MP</div>
          {dimErrors.length > 0 && (
            <div className="dim-error-banner">
              {dimErrors.map((e, i) => <div key={i}>⚠ {e}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Reference images */}
      <div className="section">
        <div className="refs-header">
          <label className="label">REFERENCE IMAGES</label>
          <span className="refs-counter">{totalRefs}/{currentModel.maxRefs}</span>
        </div>

        {refWarning && <div className="ref-warning">{refWarning}</div>}

        {/* Thumbnails — computer uploads */}
        {(refImages.length > 0 || libRefImages.length > 0) && (
          <div className="refs-grid">
            {refImages.map((r) => (
              <div key={r.id} className="ref-item">
                <img src={r.dataUrl} alt={r.name} className="ref-thumb" />
                <button className="ref-remove" onClick={() => removeRef(r.id)} disabled={isGenerating} title="Remove">×</button>
              </div>
            ))}
            {libRefImages.map((r) => (
              <div key={r.id} className="ref-item ref-item-lib">
                <img src={r.url} alt={r.prompt} className="ref-thumb" title={r.prompt} />
                <button className="ref-remove" onClick={() => setLibRefImages((prev) => prev.filter((x) => x.id !== r.id))} disabled={isGenerating} title="Remove">×</button>
                <span className="ref-lib-badge" title="From library">✦</span>
              </div>
            ))}
          </div>
        )}

        {totalRefs < currentModel.maxRefs && (
          <div className="refs-add-row">
            <button className="refs-add-btn" onClick={() => fileInputRef.current?.click()} disabled={isGenerating}>
              + From computer
            </button>
            <button className="refs-add-btn refs-add-btn-lib" onClick={openLibPicker} disabled={isGenerating}>
              + From library
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleRefUpload} />
          </div>
        )}
        <div className="refs-hint">Optional — guide the style or composition of the output</div>
      </div>

      {/* Prompt */}
      <div className="section">
        <div className="prompt-header">
          <label className="label">PROMPT</label>
          <button
            className={`spark-btn ${sparkLoading ? "spark-btn-loading" : ""}`}
            onClick={handleSparkPrompt}
            disabled={isGenerating || sparkLoading}
            title="Read your slide and generate a smart prompt with AI"
          >
            {sparkLoading ? "✨ Sparking..." : "✨ Spark Prompt"}<span className="beta-badge">beta</span>
          </button>
        </div>

        {sparkError && (
          <div className="spark-error">{sparkError}</div>
        )}
        <textarea className="prompt-textarea" placeholder="Describe the image you want to create..." value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={isGenerating} rows={4} maxLength={1500} />
        <div className={`char-counter ${prompt.length > 1400 ? "char-counter-warn" : ""} ${prompt.length >= 1500 ? "char-counter-over" : ""}`}>
          {prompt.length} / 1500
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {status && <div className="status-banner">{status}</div>}

      <button className={`generate-btn ${isGenerating ? "loading" : ""}`} onClick={handleGenerate} disabled={isGenerating || !prompt.trim() || dimErrors.length > 0}>
        {isGenerating ? "Generating..." : (
          <>
            Generate
            <span className="generate-cost">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2.5"/><path d="M8 12h8M12 8v8" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
              {estimateCredits(currentModel, width, height, count, quality).toLocaleString()}
            </span>
          </>
        )}
      </button>

      {/* Magic Layers concept button — hidden until an image has been generated */}
      <button className={`magic-layers-btn ${previewUrls.length > 0 ? "ml-visible" : "ml-hidden"}`} onClick={() => setShowMagicLayers(true)}>
        <span className="ml-btn-text">Create Magic Layers</span>
        <div className="ml-btn-icon">
          <svg width="22" height="22" viewBox="0 0 60 60" fill="none" xmlns="http://www.w3.org/2000/svg">
            {/* Bottom layer — sky image */}
            <rect x="8" y="22" width="36" height="26" rx="4" fill="#7EC8E3"/>
            <rect x="8" y="22" width="36" height="26" rx="4" fill="url(#sky)"/>
            {/* Butterfly on top layer */}
            <rect x="16" y="12" width="28" height="24" rx="4" fill="rgba(255,255,255,0.15)" stroke="rgba(255,255,255,0.4)" strokeWidth="1"/>
            {/* Purple platform */}
            <path d="M4 42 L26 52 L52 42 L30 32 Z" fill="#7C3AED" opacity="0.9"/>
            {/* Corner dots */}
            <circle cx="16" cy="14" r="2.5" fill="white"/>
            <circle cx="44" cy="14" r="2.5" fill="white"/>
            <circle cx="16" cy="34" r="2.5" fill="white"/>
            <circle cx="44" cy="34" r="2.5" fill="white"/>
            {/* Connecting lines */}
            <line x1="16" y1="14" x2="44" y2="14" stroke="white" strokeWidth="1" opacity="0.6"/>
            <line x1="16" y1="14" x2="16" y2="34" stroke="white" strokeWidth="1" opacity="0.6"/>
            <line x1="44" y1="14" x2="44" y2="34" stroke="white" strokeWidth="1" opacity="0.6"/>
            <line x1="16" y1="34" x2="44" y2="34" stroke="white" strokeWidth="1" opacity="0.6"/>
          </svg>
        </div>
      </button>

      {previewUrls.length > 0 && (
        <div className="preview-section">
          <label className="label">RESULTS</label>
          <div className="preview-grid">
            {previewUrls.map((url, i) => (
              <div key={i} className="preview-item">
                <img src={url} alt={`Generated ${i + 1}`} className="preview-img" />
                <button className="add-btn" onClick={() => handleAddToSlide(url)} disabled={isGenerating}>+ Add to slide</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Prism footer logo — fixed at bottom, only renders on generate tab ── */}
      <div className="prism-footer-logo">
        <svg viewBox="0 0 1761 330" xmlns="http://www.w3.org/2000/svg">
          <path d="M585.564 283.942C590.897 289.694 595.994 295.181 601.06 300.696C605.661 305.705 605.851 311.569 603.446 317.399C601.049 323.207 596.452 326.62 589.908 326.622C511.421 326.656 432.934 326.673 354.447 326.66C345.119 326.658 337.87 319.08 337.815 309.135C337.704 289.471 337.758 269.808 337.759 250.144C337.762 173.656 337.766 97.1689 337.784 20.6813C337.787 7.79047 345.68 -0.00451504 358.661 1.96205e-06C407.487 0.017031 456.312 0.0335711 505.138 0.0662251C552.367 0.0978411 592.466 34.3719 599.69 83.9286C605.884 126.422 576.308 172.508 528.298 182.983C524.266 183.862 520.15 184.784 516.059 184.853C511.828 184.926 508.796 186.663 507.345 190.189C505.832 193.866 506.557 197.589 509.487 200.774C519.744 211.926 529.87 223.199 540.096 234.38C555.146 250.837 570.24 267.255 585.564 283.942Z"/>
          <path d="M906.554 1.8473C916.231 1.76167 925.907 1.67604 936.321 2.02473C940.888 2.26332 944.717 2.06752 948.547 1.87178C948.983 1.78797 949.419 1.70429 950.276 1.89607C950.976 2.08186 951.256 1.99226 951.535 1.90272C959.452 3.23628 966.007 10.2998 966.593 18.1311C967.148 25.5405 962.683 32.0051 954.922 34.7193C939.879 39.9798 924.754 45.2275 912.152 55.312C907.602 58.9526 903.424 63.7535 900.757 68.8964C896.185 77.7098 899.249 86.0332 905.277 93.3056C915.167 105.238 927.774 113.951 940.404 122.613C944.514 125.432 948.758 128.054 952.891 130.84C957.831 134.17 958.924 139.829 955.812 145.222C935.64 180.175 915.433 215.109 895.368 250.123C892.497 255.132 890.063 260.437 887.91 265.799C885.724 271.246 887.248 276.25 891.858 280.058C900.618 287.293 911.356 289.828 922.089 291.97C931.494 293.846 941.058 294.923 950.549 296.377C958.99 297.669 964.939 304.223 964.57 311.78C964.172 319.917 957.476 326.343 948.59 326.378C908.763 326.536 868.935 326.558 829.107 326.55C787.779 326.541 746.451 326.426 705.123 326.396C698.925 326.392 694.011 324.369 690.285 319.076C683.477 309.407 692.11 297.713 700.061 296.629C709.216 295.382 718.51 294.804 727.505 292.841C736.335 290.914 745.12 288.229 753.462 284.762C764.013 280.378 768.588 271.611 761.905 260.228C740.194 223.255 718.748 186.125 697.182 149.066C694.77 144.921 691.513 140.868 694.603 135.827C695.916 133.686 697.695 131.498 699.802 130.229C715.658 120.677 731.266 110.823 743.572 96.6794C756.312 82.0367 754.864 68.461 739.292 56.7916C726.381 47.1165 711.593 41.0465 696.701 35.2788C688.731 32.1921 683.536 24.8023 684.671 17.3941C685.993 8.76472 693.993 1.61897 702.599 1.60878C740.925 1.56324 779.251 1.57618 818.273 1.99147C820.83 2.22425 822.693 2.0337 824.555 1.84309C837.896 1.75801 851.237 1.67292 865.302 2.01503C868.868 2.24391 871.711 2.04566 874.554 1.84736C881.895 1.73231 889.236 1.61732 897.289 1.96028C900.852 2.22798 903.703 2.03761 906.554 1.8473Z"/>
          <path d="M1049.37 133.258C1053.38 128.83 1056.98 124.502 1061.12 120.762C1102.73 83.1684 1144.49 45.7429 1186.02 8.06147C1191.66 2.94471 1197.35 0.505866 1205.15 0.557441C1255.63 0.891487 1306.12 0.754157 1356.61 0.768562C1362.94 0.770393 1366.71 3.17579 1368.71 8.26008C1370.81 13.5913 1367.99 16.9304 1364.4 20.2633C1333.76 48.6801 1303.2 77.1784 1272.56 105.59C1268.76 109.113 1266.32 112.906 1268.57 118.132C1270.74 123.175 1275.22 124.098 1280.12 124.119C1301.12 124.207 1322.12 124.715 1343.1 124.274C1354.02 124.045 1361.09 132.491 1360.74 141.855C1360.11 158.828 1360.64 175.842 1360.48 192.837C1360.41 199.659 1357.15 204.806 1350.99 207.981C1311.86 228.137 1272.83 248.485 1233.59 268.404C1194.21 288.39 1154.61 307.953 1115.1 327.694C1111.42 329.533 1107.81 330.475 1103.7 328.465C1094.51 323.972 1092.6 315.733 1099.69 308.331C1114.89 292.465 1130.38 276.874 1145.64 261.057C1158 248.237 1170.23 235.28 1182.45 222.318C1185.57 219.004 1187.45 215.078 1185.28 210.545C1183.18 206.159 1179.21 204.759 1174.56 204.745C1138.23 204.635 1101.91 204.477 1065.59 204.383C1053.72 204.353 1048.37 199.009 1048.38 187.025C1048.4 171.528 1048.37 156.032 1048.45 140.535C1048.46 138.233 1048.94 135.932 1049.37 133.258Z"/>
          <path d="M1721.38 326.374C1715.77 326.475 1710.17 326.576 1703.84 326.189C1693.58 325.573 1684.04 325.433 1674.5 325.358C1674.14 325.355 1673.77 325.972 1673.41 326.3C1666.46 326.425 1659.51 326.549 1651.84 326.186C1640.25 325.569 1629.38 325.431 1618.51 325.353C1618.15 325.351 1617.78 325.966 1617.41 326.293C1615.1 326.401 1612.78 326.51 1609.78 326.129C1602.86 325.859 1596.64 326.079 1590.42 326.298C1590.02 326.4 1589.61 326.502 1588.65 326.123C1584.2 325.865 1580.3 326.09 1576.4 326.314C1574.42 326.419 1572.44 326.523 1569.78 326.145C1565.59 325.874 1562.07 326.087 1558.55 326.299C1558.08 326.401 1557.61 326.504 1556.63 326.144C1552.59 325.879 1549.07 326.076 1545.55 326.272C1529.88 326.386 1514.2 326.499 1497.82 326.136C1494.54 325.895 1491.96 326.132 1489.38 326.368C1487.42 326.474 1485.46 326.581 1482.84 326.221C1479.3 325.966 1476.43 326.176 1473.55 326.387C1471.14 326.483 1468.74 326.579 1465.72 326.193C1457.74 325.508 1450.36 325.282 1442.98 325.158C1442.51 325.15 1442.03 325.935 1441.55 326.352C1434.11 328.333 1426.14 319.901 1427.75 310.853C1433.32 279.435 1438.98 248.03 1444.28 216.566C1448.33 192.559 1451.91 168.473 1455.63 144.412C1457.11 134.84 1466.8 130.416 1475.4 135.81C1511.17 158.254 1547.38 180.007 1583.25 202.297C1592.65 208.137 1596.26 205.536 1600.43 196.82C1627.51 140.182 1654.71 83.6046 1681.89 27.0167C1684.98 20.5897 1688.24 14.2491 1691.32 7.81577C1693.55 3.14664 1698.31 -0.171232 1702.54 0.228976C1707.1 0.658724 1711.46 4.92972 1712.34 10.1736C1714.48 23.0854 1716.47 36.0226 1718.56 48.9431C1722.82 75.2456 1727.17 101.535 1731.37 127.846C1735.73 155.141 1739.91 182.465 1744.27 209.76C1749.6 243.122 1755.03 276.469 1760.44 309.817C1762.05 319.731 1757.19 326.059 1746.77 326.242C1743.26 325.949 1740.33 326.13 1737.41 326.311C1734.77 326.415 1732.12 326.518 1728.81 326.148C1725.88 325.908 1723.63 326.141 1721.38 326.374Z"/>
          <path d="M201.518 0.391374C214.181 0.454058 226.344 0.470536 238.508 0.513932C249.124 0.551835 256.45 7.65028 256.46 18.1715C256.498 54.6621 256.472 91.1529 256.413 127.644C256.398 136.986 250.124 142.987 240.644 142.986C165.496 142.974 90.348 142.963 15.1997 142.951C6.2849 142.949 0.164188 136.945 0.146488 128.046C0.0733069 91.2221 0.0210906 54.3984 3.54994e-06 17.5747C-0.00587145 7.30989 7.28098 0.0959635 17.5662 0.108415C78.7172 0.18239 139.868 0.272295 201.518 0.391374Z"/>
          <path d="M33.5347 162.902C40.1746 162.821 46.8145 162.666 53.4543 162.668C116.504 162.689 179.554 162.736 243.161 163.027C243.984 163.185 244.249 163.091 244.515 162.998C252.568 164.66 256.422 169.143 256.467 176.941C256.492 181.105 256.502 185.269 256.477 189.432C256.431 196.998 251.455 203.512 244.002 205.387C203.421 215.598 162.83 225.769 122.229 235.896C112.401 238.347 109.182 242.394 109.192 252.817C109.21 272.469 109.245 292.121 109.229 311.772C109.219 322.924 102.85 329.318 91.6039 329.353C66.4564 329.433 41.3086 329.437 16.161 329.45C7.46529 329.454 0.0728804 322.451 0.0580494 313.788C-0.0203966 267.989 -0.00489371 222.189 0.0339253 176.39C0.0396623 169.626 3.53924 165.753 12.2525 163.044C13.005 163.121 13.2724 162.999 13.5397 162.877C19.5586 162.808 25.5775 162.739 32.1554 162.943C32.9878 163.112 33.2613 163.007 33.5347 162.902Z"/>
          <path d="M1588.53 17.9418C1608.12 27.3292 1618.85 43.0546 1620.15 63.9067C1621.4 84.0806 1609.94 104.177 1588.13 113.329C1557.93 126.006 1525.14 107.886 1518.31 74.6579C1511.32 40.6326 1543.18 8.96124 1576.33 14.1982C1580.36 14.8358 1584.22 16.6 1588.53 17.9418Z"/>
        </svg>
      </div>
      </>
      )}
    </div>
  );
}
