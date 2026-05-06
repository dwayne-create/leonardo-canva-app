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
  isBlueprintOutput?: boolean;
}


const BACKEND_URL = "https://leonardo-canva-app.onrender.com";
const API_KEY_STORAGE = "prism_leo_api_key";

// ─── Canva Brand ─────────────────────────────────────────────────────────────
// Logo URLs — served by our backend so Canva's asset uploader can fetch them
const CANVA_LOGO_WORDMARK_GRADIENT_URL = `${BACKEND_URL}/api/logo/wordmark-gradient`;
const CANVA_LOGO_WORDMARK_WHITE_URL    = `${BACKEND_URL}/api/logo/wordmark-white`;

// ─── Brand style logic ───────────────────────────────────────────────────────
const CANVA_GRADIENT_STYLES = new Set([
  "Illustration", "Abstract", "Graphic Design", "Stylized / Aesthetic", "Infographic", "Canvafy Me",
]);
const CANVA_ACCENT_STYLES = new Set(["3D / CGI"]);
// Photography, Cinematic / Film, Magazine Cover, Print Ad → logo only, no color injection

const BRAND_STYLES = [
  { label: "Illustration",          icon: "🎨", short: "Illustr."  },
  { label: "Abstract",              icon: "🌀", short: "Abstract"  },
  { label: "Graphic Design",        icon: "✏️",  short: "Graphic"   },
  { label: "Stylized / Aesthetic",  icon: "✨", short: "Stylized"  },
  { label: "Infographic",           icon: "📊", short: "Infograph" },
  { label: "Canvafy Me",            icon: "💎", short: "Canvafy"   },
  { label: "3D / CGI",              icon: "🧊", short: "3D/CGI"    },
  { label: "Photography",           icon: "📷", short: "Photo"     },
  { label: "Cinematic / Film",      icon: "🎬", short: "Cinema"    },
  { label: "Magazine Cover",        icon: "📰", short: "Magazine"  },
  { label: "Print Ad",              icon: "🖨️",  short: "Print"     },
];

function getCanvaBrandPrefix(style: string): string {
  if (CANVA_GRADIENT_STYLES.has(style)) {
    return "teal to deep purple diagonal gradient, cyan-teal upper-left to violet-purple lower-right, bold clean modern design,";
  }
  if (CANVA_ACCENT_STYLES.has(style)) {
    return "teal and deep purple color accents, bold clean modern design,";
  }
  return ""; // no color injection — logo only for photorealistic styles
}

// Insert the Canva wordmark as a separate movable layer on the Canva canvas
async function insertCanvaWordmark(useGradient: boolean) {
  const logoUrl = useGradient ? CANVA_LOGO_WORDMARK_GRADIENT_URL : CANVA_LOGO_WORDMARK_WHITE_URL;
  const asset = await upload({
    type: "image",
    mimeType: "image/svg+xml",
    url: logoUrl,
    thumbnailUrl: logoUrl,
    width: 2000,
    height: 642,
    aiDisclosure: "none",
  });
  // Place the wordmark in the lower-right area of the canvas
  await addElementAtPoint({
    type: "image",
    ref: asset.ref,
    altText: { text: "Canva logo", decorative: false },
    atPoint: { x: 72, y: 88 },
  });
}

const LIB_PICKER_PAGE_SIZE = 18; // 6×3 grid per page

// ─── Blueprint definitions ────────────────────────────────────────────────────
interface BpDef {
  versionId: string;
  name: string;
  desc: string;
  category: "relight" | "portrait" | "product" | "creative";
  icon: string;
  imageNodeId: string;
  textNodeId?: string;
  textSettingName?: string;
  textVarName?: string;   // variable name inside textVariables array
  textLabel?: string;
  textPlaceholder?: string;
  thumb?: string;         // CDN thumbnail URL (confirmed)
  cost: number;           // estimated credits per execution
}

const BP_CDN = "https://cdn.leonardo.ai/blueprint_assets/official/384ab5c8-55d8-47a1-be22-6a274913c324/thumbnails/";

const CURATED_BLUEPRINTS: BpDef[] = [
  // ── Relighting ───────────────────────────────────────────────────────────────
  { versionId: "04ed2d4b-c28a-4002-b712-bbc89cee592e", name: "Golden Hour Relight",     desc: "Warm late-afternoon glow",          category: "relight",  icon: "🌅", cost: 40, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58", thumb: BP_CDN + "thumbnail-739176.webp" },
  { versionId: "ac9941ef-c88a-477e-a93e-6c07552aa41b", name: "Warm Relight",             desc: "Soft warm tones",                   category: "relight",  icon: "🕯️", cost: 40, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  { versionId: "d38ef3ce-3389-408f-a529-43a2a0b02816", name: "Tungsten Moon Relight",    desc: "Moody tungsten night light",        category: "relight",  icon: "🌙", cost: 40, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  { versionId: "84d68b07-a2d5-49ed-9638-e62cafe8cd95", name: "Dappled Sunlight Relight", desc: "Natural light through leaves",      category: "relight",  icon: "🌿", cost: 40, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  { versionId: "b921c2cd-119b-4d9c-8ac4-af2ad1420fa0", name: "Cool Sunrise Relight",     desc: "Cool blue dawn light",              category: "relight",  icon: "🌄", cost: 40, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  { versionId: "45801e6b-223e-42d9-b4a5-2c5792035e45", name: "Soft Azure Relight",       desc: "Soft azure studio light",           category: "relight",  icon: "💙", cost: 40, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  { versionId: "7f50625c-2f97-47df-8890-83d85142e953", name: "Custom Relight",           desc: "Describe your own lighting",        category: "relight",  icon: "💡", cost: 40, imageNodeId: "1e4c5aa9-8d0e-4d92-b3b4-1abe4f25ad32",
    textNodeId: "d4e1ba8e-b20e-4e21-a3af-0cb759111973", textSettingName: "textVariables", textVarName: "lighting",
    textLabel: "Lighting style", textPlaceholder: "e.g., day time, cinematic soft light, golden hour" },
  // ── Portrait ─────────────────────────────────────────────────────────────────
  { versionId: "e994a1b4-db3c-4153-b5be-64eb887b5205", name: "Professional Headshot",   desc: "Studio-quality headshot",           category: "portrait", icon: "🤵", cost: 60, imageNodeId: "c7a4b2f9-8e3d-4e3b-9f0d-2c8f6d2b1a77" },
  { versionId: "dfba24fe-bb6c-4d16-a48e-cec3a5472a2a", name: "Pop Art Collage Portrait", desc: "Bold pop art interpretation",       category: "portrait", icon: "🎭", cost: 60, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  { versionId: "a1936b67-902b-4099-9f3a-59ea8606bc15", name: "Indie Garden Polaroid",   desc: "Dreamy polaroid aesthetic",         category: "portrait", icon: "📷", cost: 60, imageNodeId: "4a5d62d9-5d73-4a2f-92ee-3a67d37b2b58" },
  // ── Product ──────────────────────────────────────────────────────────────────
  { versionId: "4b3f9df0-1e21-49ce-be70-8736a41dff88", name: "Product in a Dreamstate", desc: "Ethereal product placement",        category: "product",  icon: "✨", cost: 60, imageNodeId: "2356018a-7977-4934-a3e8-671a6064c8ce", thumb: BP_CDN + "thumbnail-42d7cd.webp" },
  { versionId: "0ea4cdc3-0ceb-4728-a2a4-d0a8ba50d042", name: "At-Home Product Shoot",  desc: "Natural lifestyle product photos",  category: "product",  icon: "🏠", cost: 60, imageNodeId: "8e6c9f12-3b5a-4f8d-9c21-7a34b2d5c6e9" },
  { versionId: "8c1bdc37-6986-4d9b-ab6e-acfd123d51b2", name: "Merch Mock Up",           desc: "T-shirt, mug, tote & more",         category: "product",  icon: "👕", cost: 60, imageNodeId: "414b2497-5dbc-4f47-a2b4-802f8a30603a",
    textNodeId: "4b960270-b613-4708-920c-0feabc104325", textSettingName: "textVariables", textVarName: "products",
    textLabel: "Products", textPlaceholder: "e.g., t-shirt, mug, tote bag, hoodie" },
  // ── Creative ─────────────────────────────────────────────────────────────────
  { versionId: "c1039dee-79e6-44a7-8b29-d96a8ba3b2e6", name: "Old Photo Restoration",   desc: "Restore old & damaged photos",      category: "creative", icon: "🕰️", cost: 50, imageNodeId: "b2e7ac51-5d0b-43cf-b865-bb3c1a8fa6e7", thumb: BP_CDN + "thumbnail-c3ca78.webp" },
  { versionId: "407530d5-7482-43ff-9784-e8b7fa7c3049", name: "Multiview Perspective",   desc: "Multiple angles, one shot",         category: "creative", icon: "🔄", cost: 80, imageNodeId: "fae3b7c2-1d4a-4c6b-8e29-9f0a1b2c3d4e" },
  { versionId: "41b0fcc4-01e2-421f-99ed-c38454f1e59c", name: "Image Touch Up",          desc: "Micro-fix specific issues",         category: "creative", icon: "✏️", cost: 40, imageNodeId: "31bba0c1-73a1-4666-92ef-80f7bb0318cd",
    textNodeId: "d7c81df7-4d96-4edd-af69-a6b468ec5a5e", textSettingName: "textVariables", textVarName: "microFixes",
    textLabel: "Corrections", textPlaceholder: "e.g., clean up background edges, remove blemish, fix stray hair" },
  { versionId: "5c09ba53-ae76-4707-89c0-f8f3a3efe297", name: "Background Change",       desc: "Replace the background",            category: "creative", icon: "🖼️", cost: 50, imageNodeId: "7c5f47de-4c34-4c0d-a2ba-4add39f639ae",
    textNodeId: "1b2fc1de-2c60-4da3-8ef8-dc4b42f3c922", textSettingName: "textVariables", textVarName: "background",
    textLabel: "New background", textPlaceholder: "e.g., gradient blue, mountain landscape, city skyline" },
];

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

  // Canva Brand mode (style comes from promptStyle — unified with Spark Prompt picker)
  const [canvaBrand, setCanvaBrand] = useState(false);

  // Magic Layers concept modal
  const [showMagicLayers, setShowMagicLayers] = useState(false);

  // Spark Prompt state
  const [sparkLoading,    setSparkLoading]    = useState(false);
  const [sparkError,      setSparkError]      = useState<string | null>(null);
  const [promptStyle,     setPromptStyle]     = useState("Photography");
  const [showStyleModal,  setShowStyleModal]  = useState(false);
  const [sparkSlideImage, setSparkSlideImage] = useState<string | null>(null); // base64 JPEG of pasted slide

  // Blueprint state
  const [showBpPicker, setShowBpPicker]   = useState(false);
  const [bpSourceImg,  setBpSourceImg]    = useState<LibraryImage | null>(null);
  const [selectedBp,   setSelectedBp]    = useState<BpDef | null>(null);
  const [bpTextInput,  setBpTextInput]   = useState("");
  const [bpRunning,    setBpRunning]     = useState(false);
  const [bpStatus,     setBpStatus]      = useState<string | null>(null);
  const [bpError,      setBpError]       = useState<string | null>(null);
  // versionId → CDN thumbnail URL fetched from backend on mount
  const [bpThumbs,     setBpThumbs]      = useState<Record<string, string>>(() => {
    // Seed with known confirmed thumbnails so they show immediately
    const seed: Record<string, string> = {};
    CURATED_BLUEPRINTS.forEach((bp) => { if (bp.thumb) seed[bp.versionId] = bp.thumb; });
    return seed;
  });

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

  // Canva Brand derived values — recomputed each render
  const brandPrefix     = canvaBrand ? getCanvaBrandPrefix(promptStyle) : "";
  const promptMaxLength = 1500 - brandPrefix.length;

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

  // Fetch blueprint thumbnails — match by blueprint NAME (the API has no version IDs)
  useEffect(() => {
    if (!apiKey) return;
    fetch(`${BACKEND_URL}/api/blueprint-list`, { headers: buildHeaders() })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (!data) return;
        const thumbMap: Record<string, string> = {};
        const edges = data?.blueprints?.edges || [];
        edges.forEach((edge: any) => {
          const node = edge?.node;
          if (!node) return;
          const apiName: string = node.name || "";
          const thumbEntry = (node.thumbnails || []).find(
            (t: any) => t.name === "thumbnailUrl"
          );
          const thumbUrl: string | undefined = thumbEntry?.url;
          if (!thumbUrl || !apiName) return;
          // Match by exact name to our curated list
          const bp = CURATED_BLUEPRINTS.find((b) => b.name === apiName);
          if (bp) thumbMap[bp.versionId] = thumbUrl;
        });
        if (Object.keys(thumbMap).length > 0) {
          // hardcoded thumbs (already in prev) take precedence
          setBpThumbs((prev) => ({ ...thumbMap, ...prev }));
        }
      })
      .catch(() => {}); // fail silently — emoji fallback is in place
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey]);

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

  // ── Blueprint execution ──────────────────────────────────────────────────────
  const handleRunBlueprint = useCallback(async () => {
    if (!bpSourceImg || !selectedBp) return;
    setBpRunning(true);
    setBpError(null);
    setBpStatus("Starting Blueprint...");
    try {
      // Build nodeInputs array
      const nodeInputs: { nodeId: string; settingName: string; value: any }[] = [
        { nodeId: selectedBp.imageNodeId, settingName: "imageUrl", value: bpSourceImg.url },
      ];
      if (selectedBp.textNodeId && bpTextInput.trim()) {
        nodeInputs.push({
          nodeId: selectedBp.textNodeId,
          settingName: "textVariables",
          // textVariables expects an array: [{ name: varName, value: text }]
          value: [{ name: selectedBp.textVarName || "text", value: bpTextInput.trim() }],
        });
      }

      // Step 1 — Execute
      const execRes = await fetch(`${BACKEND_URL}/api/blueprint-execute`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ blueprintVersionId: selectedBp.versionId, nodeInputs }),
      });
      if (!execRes.ok) {
        const e = await execRes.json().catch(() => ({}));
        throw new Error(e.error || `Execute error ${execRes.status}`);
      }
      const execData = await execRes.json();
      // The API wraps the result: { blueprintExecution: { akUUID: "...", ... } }
      const executionId =
        execData.blueprintExecution?.akUUID ||
        execData.id ||
        execData.blueprintExecutionId ||
        execData.blueprintExecution?.id;
      if (!executionId) throw new Error("No execution ID returned from Blueprint API");

      // Step 2 — Poll status until COMPLETE
      setBpStatus("Running Blueprint... (20–90s)");
      let execComplete = false;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        try {
          const statusRes = await fetch(
            `${BACKEND_URL}/api/blueprint-execution/${executionId}/status`,
            { headers: buildHeaders() }
          );
          if (!statusRes.ok) continue;
          const sd = await statusRes.json();
          const execStatus = (sd.blueprintExecution || sd).status;
          if (execStatus === "COMPLETE" || execStatus === "COMPLETED") { execComplete = true; break; }
          if (execStatus === "FAILED" || execStatus === "ERROR")       throw new Error("Blueprint execution failed on Leonardo's servers.");
          const remaining = (45 - i - 1) * 4;
          setBpStatus(`Running Blueprint... (~${remaining}s remaining)`);
        } catch (inner: any) {
          if (inner.message?.includes("Blueprint")) throw inner;
          // swallow transient network errors and keep polling
        }
      }
      if (!execComplete) throw new Error("Blueprint timed out after 3 minutes. Try again.");

      // Step 3 — Fetch generation IDs
      setBpStatus("Fetching results...");
      const genListRes = await fetch(
        `${BACKEND_URL}/api/blueprint-execution/${executionId}/generations`,
        { headers: buildHeaders() }
      );
      if (!genListRes.ok) throw new Error("Couldn't retrieve Blueprint generation list");
      const genListData = await genListRes.json();
      const rawGens = genListData.generations || genListData;
      const genIds: string[] = Array.isArray(rawGens)
        ? rawGens.map((g: any) => g.id || g.generationId || g).filter(Boolean)
        : [];
      if (genIds.length === 0) throw new Error("Blueprint completed but returned no generation IDs");

      // Step 4 — Poll each generation for image URLs
      const newImages: LibraryImage[] = [];
      for (const genId of genIds) {
        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const pollRes = await fetch(`${BACKEND_URL}/api/generation/${genId}`, {
            headers: buildHeaders(),
          });
          if (!pollRes.ok) continue;
          const pollData = await pollRes.json();
          const gen = pollData.generations_by_pk;
          if (gen?.status === "COMPLETE") {
            for (const img of gen.generated_images || []) {
              newImages.push({
                id: img.id,
                generationId: genId,
                url: img.url,
                prompt: `[${selectedBp.name}] ${bpSourceImg.prompt}`,
                width: img.width || bpSourceImg.width,
                height: img.height || bpSourceImg.height,
                createdAt: new Date().toISOString(),
                isBlueprintOutput: true,
              });
            }
            break;
          }
          if (gen?.status === "FAILED") break;
        }
      }

      if (newImages.length === 0) throw new Error("Blueprint completed but produced no images");
      setLibraryImages((prev) => [...newImages, ...prev]);
      setShowBpPicker(false);
      setBpSourceImg(null);
      setSelectedBp(null);
      setBpTextInput("");
      setBpStatus(null);
    } catch (err: any) {
      setBpError(err.message || "Blueprint failed");
      setBpStatus(null);
    } finally {
      setBpRunning(false);
    }
  }, [bpSourceImg, selectedBp, bpTextInput, buildHeaders]);

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
      // Compute prefix inside the callback so it always uses current state
      const prefix = canvaBrand ? getCanvaBrandPrefix(promptStyle) : "";
      const enrichedPrompt = prefix ? `${prefix} ${prompt.trim()}` : prompt.trim();

      const genRes = await fetch(`${BACKEND_URL}/api/generate`, {
        method: "POST",
        headers: buildHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          modelId,
          prompt: enrichedPrompt,
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
        // If Canva Brand is on, place the wordmark logo as a separate overlay
        if (canvaBrand) {
          try {
            // Colors injected → image has brand palette → use white logo for contrast
            // No injection (photo/cinematic) → natural image → use gradient logo
            await insertCanvaWordmark(prefix === "");
            setStatus("✓ Image + Canva logo added to your slide!");
          } catch {
            setStatus("✓ Image added! (Logo placement unavailable)");
          }
        } else {
          setStatus("✓ Image added to your slide!");
        }
      } catch {
        setStatus("✓ Done! Click a result to add it to your slide.");
      }
    } catch (err: any) {
      setError(err.message || "Something went wrong.");
      setStatus(null);
    } finally {
      setIsGenerating(false);
    }
  }, [modelId, prompt, width, height, count, quality, refImages, buildHeaders, canvaBrand, promptStyle]);

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

      {/* Blueprint picker modal */}
      {showBpPicker && (
        <div className="modal-overlay" onClick={() => !bpRunning && setShowBpPicker(false)}>
          <div className="modal bp-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-title">✦ Run a Blueprint</div>
            <p className="bp-picker-sub">Choose an AI workflow to apply to your image.</p>

            {(["relight", "portrait", "product", "creative"] as const).map((cat) => {
              const catBPs = CURATED_BLUEPRINTS.filter((b) => b.category === cat);
              const catLabel: Record<string, string> = {
                relight: "💡 Relighting", portrait: "👤 Portrait",
                product: "📦 Product",   creative: "🎨 Creative",
              };
              return (
                <div key={cat} className="bp-category">
                  <div className="bp-category-label">{catLabel[cat]}</div>
                  <div className="bp-card-grid">
                    {catBPs.map((bp) => {
                      const thumbUrl = bpThumbs[bp.versionId];
                      return (
                        <button
                          key={bp.versionId}
                          className={`bp-card ${selectedBp?.versionId === bp.versionId ? "bp-card-active" : ""}`}
                          data-cat={bp.category}
                          onClick={() => { setSelectedBp(bp); setBpTextInput(""); setBpError(null); }}
                          disabled={bpRunning}
                        >
                          {thumbUrl
                            ? <img src={thumbUrl} alt={bp.name} className="bp-card-thumb" />
                            : <span className="bp-card-icon">{bp.icon}</span>
                          }
                          <span className="bp-card-name">{bp.name}</span>
                          <span className="bp-card-desc">{bp.desc}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {selectedBp?.textNodeId && (
              <div className="bp-text-row">
                <label className="label">{selectedBp.textLabel?.toUpperCase()}</label>
                <input
                  className="bp-text-input"
                  type="text"
                  placeholder={selectedBp.textPlaceholder}
                  value={bpTextInput}
                  onChange={(e) => setBpTextInput(e.target.value)}
                  disabled={bpRunning}
                  maxLength={250}
                />
              </div>
            )}

            {bpError  && <div className="bp-error">{bpError}</div>}
            {bpStatus && <div className="status-banner" style={{ marginTop: 8 }}>{bpStatus}</div>}

            <div className="modal-actions" style={{ marginTop: 12, flexDirection: "column", gap: 8 }}>
              <button
                className={`generate-btn ${bpRunning ? "loading" : ""}`}
                style={{ width: "100%", padding: "11px", fontSize: "13px" }}
                onClick={handleRunBlueprint}
                disabled={bpRunning || !selectedBp || (!!selectedBp?.textNodeId && !bpTextInput.trim())}
              >
                {bpRunning
                  ? "Running..."
                  : selectedBp
                    ? `✦ Run Blueprint · ~${selectedBp.cost} credits`
                    : "✦ Run Blueprint"}
              </button>
              <button
                className="modal-cancel"
                style={{ width: "100%", textAlign: "center" }}
                onClick={() => setShowBpPicker(false)}
                disabled={bpRunning}
              >Cancel</button>
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
                <div className="help-h">🖼 Generate tab</div>
                <p><strong>Model</strong> — choose GPT Image 2, Nano Banana Pro, Seedream 4.5, or Flux.2 Pro. Each has different strengths and credit costs.</p>
                <p><strong>Quality</strong> — GPT Image 2 only. Low uses fewer credits; High produces sharper results.</p>
                <p><strong>Size</strong> — pick a standard ratio or social preset, or drag the sliders for a custom size.</p>
                <p><strong>Reference images</strong> — optionally add up to 6 images to guide style or composition. Use "+ From computer" to upload, or "+ From library" to pick from past generations.</p>
                <p><strong>Prompt</strong> — describe the image. Be specific for best results. The character counter shows how many of the 1500-character limit you've used.</p>
                <p><strong>Generate button</strong> — shows the estimated credit cost. The first result is added to your slide automatically.</p>
              </div>
              <div className="help-section">
                <div className="help-h">✨ Spark Prompt</div>
                <p>Spark Prompt uses AI to write a Leonardo prompt from your slide content — so you don't have to. Click <strong>✨ Spark Prompt</strong>, pick a visual style, then hit <strong>Generate Prompt</strong>. Gemini reads your current slide and writes a prompt tailored to the style you chose. Edit it before generating if you like.</p>
                <p><strong>Styles available:</strong> Photography, Illustration, Magazine Cover, Abstract, 3D / CGI, Cinematic / Film, Stylized / Aesthetic, Print Ad, Graphic Design, Infographic — and <strong>💎 Canvafy Me</strong>.</p>
                <p><strong>💎 Canvafy Me</strong> is the "I'm feeling lucky" style. Instead of you picking the medium, Gemini acts as a world-class art director — reads your slide, chooses whatever visual approach will look most stunning, and writes the prompt at the highest possible level. Great when you're not sure which style to pick.</p>
              </div>
              <div className="help-section">
                <div className="help-h">🎨 Canva Brand mode</div>
                <p>Canva Brand injects Canva's teal-to-purple palette into your generated image and places the official Canva wordmark on your canvas as a separate movable element.</p>
                <p>To use it: open <strong>✨ Spark Prompt</strong>, flip the <strong>Canva Brand</strong> pill at the top of the modal from OFF to ON, then pick a style. The selected style determines what gets injected:</p>
                <p><strong>Gradient styles</strong> (Illustration, Abstract, Graphic Design, Stylized, Infographic, Canvafy Me) → teal-to-purple diagonal gradient injected · white wordmark placed.</p>
                <p><strong>Accent style</strong> (3D / CGI) → teal and purple accents injected · white wordmark placed.</p>
                <p><strong>Natural image styles</strong> (Photography, Cinematic, Magazine Cover, Print Ad) → no colour injection · gradient wordmark placed.</p>
                <p>Canva Brand is <strong>OFF by default</strong>. The character counter adjusts automatically to reserve space for the brand colour prefix.</p>
              </div>
              <div className="help-section">
                <div className="help-h">📚 Library tab</div>
                <p>Browse all your past generations. Click "+ Add to slide" to insert any image, or the 🗑 icon to delete it from your Leonardo account.</p>
              </div>
              <div className="help-section">
                <div className="help-h">🪙 Credits</div>
                <p>Your balance shows in the top-right corner. It refreshes automatically after each generation. Credits renew monthly on your Leonardo plan.</p>
              </div>
              <div className="help-section">
                <div className="help-h">💡 Tips</div>
                <p>Add a reference image to match an existing slide's visual style. Use 9:16 for full-bleed portrait slides, 16:9 for landscape backgrounds. Canvafy Me + Canva Brand is a powerful combo — let the AI direct the creative, with Canva's brand applied on top.</p>
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

            {/* Canva Brand toggle — lives inside this modal */}
            <div className="modal-brand-row">
              <svg className="canva-brand-logo" viewBox="0 0 1900 1900" xmlns="http://www.w3.org/2000/svg">
                <circle cx="950" cy="950" r="950" fill="#7D2AE7"/>
                <circle cx="950" cy="950" r="950" fill="url(#mbg1)"/>
                <circle cx="950" cy="950" r="950" fill="url(#mbg2)"/>
                <path d="M1707.73 1002.08C1705.18 1002.08 1702.91 1003.79 1701.78 1007.19C1686.37 1051.05 1665.57 1077.23 1648.46 1077.23C1638.63 1077.23 1634.66 1066.27 1634.66 1049.06C1634.66 1006.15 1660.47 915.025 1673.32 873.433C1674.84 869.145 1675.7 864.651 1675.88 860.104C1675.88 848.005 1669.26 842.05 1652.91 842.05C1636.55 842.05 1616.23 849.045 1597.89 881.373C1591.46 852.826 1572.18 840.348 1545.24 840.348C1514.14 840.348 1484.08 860.388 1459.31 892.811C1434.55 925.234 1405.53 936.01 1383.6 930.716C1399.38 892.244 1405.15 863.413 1405.15 842.05C1405.15 808.492 1388.61 788.264 1361.86 788.264C1321.11 788.264 1297.67 827.114 1297.67 867.95C1297.67 899.522 1311.95 932.04 1343.52 947.826C1317.14 1007.47 1278.58 1061.45 1263.93 1061.45C1245.02 1061.45 1239.44 969 1240.58 902.831C1241.14 864.925 1244.36 862.94 1244.36 851.408C1244.36 844.886 1240.01 840.348 1222.9 840.348C1182.92 840.348 1170.44 874.284 1168.64 913.229C1167.95 927.995 1165.64 942.641 1161.74 956.9C1144.92 1016.64 1110.51 1061.92 1088.01 1061.92C1077.52 1061.92 1074.78 1051.43 1074.78 1037.82C1074.78 994.901 1098.79 941.114 1098.79 895.363C1098.79 861.617 1084.04 840.348 1056.15 840.348C1023.45 840.348 980.06 879.388 939.035 952.363C952.553 896.497 958.035 842.333 918.145 842.333C909.464 842.467 900.941 844.671 893.284 848.761C887.801 851.597 884.871 856.701 885.249 862.373C889.03 922.02 837.229 1074.49 788.075 1074.49C779.095 1074.49 774.841 1064.85 774.841 1049.16C774.841 1006.24 800.458 915.308 813.314 873.622C814.88 869.085 815.741 864.335 815.866 859.537C815.866 848.194 808.871 842.333 792.896 842.333C775.314 842.333 756.314 849.045 737.881 881.373C731.453 852.826 712.169 840.348 685.324 840.348C641.179 840.348 591.741 887.045 570.095 948.015C541.075 1029.31 482.562 1107.77 403.821 1107.77C332.358 1107.77 294.642 1048.31 294.642 954.443C294.642 818.701 394.274 707.915 468.1 707.915C503.453 707.915 520.279 730.413 520.279 764.915C520.279 806.697 497.025 826.075 497.025 841.955C497.025 846.776 500.995 851.597 509.03 851.597C541.169 851.597 578.886 813.881 578.886 762.458C578.886 711.035 537.199 673.318 463.279 673.318C341.244 673.318 218.358 796.204 218.358 953.592C218.358 1078.84 280.179 1154.37 386.995 1154.37C459.876 1154.37 523.587 1097.75 557.995 1031.48C561.871 1086.4 586.732 1114.95 624.637 1114.95C658.383 1114.95 685.702 1094.91 706.592 1059.56C714.627 1096.52 735.896 1114.67 763.592 1114.67C795.353 1114.67 821.821 1094.53 847.06 1057.19C846.682 1086.5 853.393 1114.1 878.821 1114.1C890.826 1114.1 905.194 1111.36 907.746 1100.87C934.403 990.174 1000.67 899.806 1020.9 899.806C1026.85 899.806 1028.46 905.478 1028.46 912.378C1028.46 942.438 1007.28 1004.07 1007.28 1043.39C1007.28 1086.02 1025.34 1114.1 1062.68 1114.1C1104.08 1114.1 1146.14 1063.43 1174.22 989.323C1183.01 1058.52 1202.01 1114.38 1231.6 1114.38C1268.08 1114.38 1332.84 1037.72 1372.06 956.428C1387.38 958.413 1410.54 957.94 1432.66 942.249C1423.3 966.164 1417.72 992.348 1417.72 1018.44C1417.72 1093.87 1453.64 1114.95 1484.65 1114.95C1518.39 1114.95 1545.71 1094.91 1566.6 1059.56C1573.5 1091.41 1591.08 1114.57 1623.51 1114.57C1674.17 1114.57 1718.22 1062.77 1718.22 1020.23C1718.22 1008.99 1713.4 1002.08 1707.73 1002.08Z" fill="white"/>
                <defs>
                  <radialGradient id="mbg1" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(367 1684) rotate(-49.4156) scale(1469.49)">
                    <stop stopColor="#6420FF"/><stop offset="1" stopColor="#6420FF" stopOpacity="0"/>
                  </radialGradient>
                  <radialGradient id="mbg2" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(503 216) rotate(54.7035) scale(1657.12)">
                    <stop stopColor="#00C4CC"/><stop offset="1" stopColor="#00C4CC" stopOpacity="0"/>
                  </radialGradient>
                </defs>
              </svg>
              <span className="modal-brand-label">Apply Canva Brand</span>
              <button
                className={`modal-brand-pill ${canvaBrand ? "on" : "off"}`}
                onClick={() => setCanvaBrand((v) => !v)}
              >
                {canvaBrand ? "ON" : "OFF"}
              </button>
            </div>

            {canvaBrand && brandPrefix && (
              <div className="modal-brand-hint">
                {CANVA_GRADIENT_STYLES.has(promptStyle) ? "Teal→purple gradient" : "Teal & purple accents"} injected · White logo · {brandPrefix.length} chars reserved
              </div>
            )}
            {canvaBrand && !brandPrefix && (
              <div className="modal-brand-hint">Logo only — no colour injection for this style</div>
            )}

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
              ].map(({ label, icon }) => {
                const brandClass = canvaBrand
                  ? CANVA_GRADIENT_STYLES.has(label) ? "brand-dot-gradient"
                  : CANVA_ACCENT_STYLES.has(label)   ? "brand-dot-accent"
                  : "brand-dot-none"
                  : "";
                return (
                  <button
                    key={label}
                    className={`style-card ${promptStyle === label ? "active" : ""} ${label === "Canvafy Me" ? "style-card--wide" : ""} ${brandClass}`}
                    onClick={() => setPromptStyle(label)}
                  >
                    <span className="style-card-icon">{icon}</span>
                    <span className="style-card-label">{label}</span>
                  </button>
                );
              })}
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
                    {img.isBlueprintOutput && <span className="bp-badge">✦ BP</span>}
                    <div className="library-thumb-actions">
                      <button
                        className="library-action-btn library-bp-btn"
                        onClick={() => {
                          setBpSourceImg(img);
                          setSelectedBp(null);
                          setBpTextInput("");
                          setBpError(null);
                          setBpStatus(null);
                          setShowBpPicker(true);
                        }}
                        disabled={bpRunning}
                        title="Run a Blueprint on this image"
                      >✦</button>
                      <button
                        className="library-action-btn library-trash-btn"
                        onClick={() => setConfirmDeleteId(img.id)}
                        disabled={deletingId === img.id}
                        title="Delete image"
                      >
                        {deletingId === img.id ? "…" : "🗑"}
                      </button>
                    </div>
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
        <textarea className="prompt-textarea" placeholder="Describe the image you want to create..." value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={isGenerating} rows={4} maxLength={promptMaxLength} />
        <div className={`char-counter ${prompt.length > promptMaxLength - 100 ? "char-counter-warn" : ""} ${prompt.length >= promptMaxLength ? "char-counter-over" : ""}`}>
          {prompt.length} / {promptMaxLength}
          {brandPrefix && <span className="brand-chars-note"> +{brandPrefix.length} brand</span>}
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
