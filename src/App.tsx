import { useState, useCallback, useRef, useEffect } from "react";
import { upload } from "@canva/asset";
import { addElementAtCursor, addElementAtPoint } from "@canva/design";
import "./styles.css";

// Each model maps to a real Leonardo model ID
const MODELS = [
  { id: "de7d3faf-762f-48e0-b3b7-9d0ac3a3fcf3", name: "GPT Image 2",     maxRefs: 6 },
  { id: "28aeddf8-bd19-4803-80fc-79602d1a9989", name: "Nano Banana Pro",  maxRefs: 6 },
  { id: "05ce0082-2d80-4a2d-8653-4d1c85e2418e", name: "Seedream 4.5",     maxRefs: 4 },
  { id: "b2614463-296c-462a-9586-aafdb8f00e36", name: "Flux.2 Pro",       maxRefs: 4 },
];

const STANDARD_SIZES = [
  { label: "1:1",  w: 1024, h: 1024 },
  { label: "2:3",  w: 848,  h: 1264 },
  { label: "3:2",  w: 1264, h: 848  },
  { label: "16:9", w: 1376, h: 768  },
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

async function insertIntoCanva(url: string, width: number, height: number) {
  const asset = await upload({
    type: "image",
    mimeType: "image/jpeg",
    url,
    thumbnailUrl: url,
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
  const [width, setWidth]               = useState(1024);
  const [height, setHeight]             = useState(1024);
  const [prompt, setPrompt]             = useState("");
  const [activePreset, setActivePreset] = useState("1:1");
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus]             = useState<string | null>(null);
  const [previewUrls, setPreviewUrls]   = useState<string[]>([]);
  const [error, setError]               = useState<string | null>(null);
  const [refImages, setRefImages]       = useState<RefImage[]>([]);
  const [refWarning, setRefWarning]     = useState<string | null>(null);
  const fileInputRef                    = useRef<HTMLInputElement>(null);

  // API key state
  const [apiKey, setApiKey]           = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [apiKeyInput, setApiKeyInput] = useState<string>(() => localStorage.getItem(API_KEY_STORAGE) || "");
  const [apiKeySaved, setApiKeySaved] = useState(false);

  // Library state
  const [libraryImages, setLibraryImages]       = useState<LibraryImage[]>([]);
  const [libraryLoading, setLibraryLoading]     = useState(false);
  const [libraryError, setLibraryError]         = useState<string | null>(null);
  const [libraryAddingId, setLibraryAddingId]   = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId]   = useState<string | null>(null);
  const [deletingId, setDeletingId]             = useState<string | null>(null);

  const currentModel = MODELS.find((m) => m.id === modelId)!;

  // Build headers with optional user API key
  const buildHeaders = useCallback((extra: Record<string, string> = {}) => {
    const h: Record<string, string> = { ...extra };
    if (apiKey.trim()) h["x-leo-api-key"] = apiKey.trim();
    return h;
  }, [apiKey]);

  // Save API key
  const handleSaveApiKey = () => {
    const trimmed = apiKeyInput.trim();
    setApiKey(trimmed);
    localStorage.setItem(API_KEY_STORAGE, trimmed);
    setApiKeySaved(true);
    setTimeout(() => {
      setApiKeySaved(false);
      setTab("generate");
    }, 1000);
  };

  // When model changes, trim refs if the new model allows fewer
  const handleModelChange = useCallback((newId: string) => {
    const newModel = MODELS.find((m) => m.id === newId)!;
    setModelId(newId);
    setRefWarning(null);
    setRefImages((prev) => {
      if (prev.length > newModel.maxRefs) {
        setRefWarning(
          `${newModel.name} supports up to ${newModel.maxRefs} reference images. ${prev.length - newModel.maxRefs} image${prev.length - newModel.maxRefs > 1 ? "s were" : " was"} removed.`
        );
        return prev.slice(0, newModel.maxRefs);
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
          refImages: refImages.map((r) => r.dataUrl),
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

      {/* Header */}
      <div className="header">
        <div className="logo">
          <svg className="logo-svg" viewBox="0 0 250 267" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M238.535 0C241.97 0 244.192 3.63035 242.629 6.68935L213.985 62.7452C212.422 65.8042 214.644 69.4346 218.079 69.4346H229.417C232.821 69.4346 235.044 73.0045 233.543 76.0593L193.858 156.832C193.21 158.15 193.231 159.697 193.914 160.997L249.133 266.146C249.136 266.151 249.13 266.157 249.125 266.154C249.124 266.154 249.123 266.153 249.122 266.153H58.2702C54.5257 266.153 52.3518 261.916 54.5356 258.875L87.2882 213.255C89.472 210.213 87.2981 205.977 83.5536 205.977H25.9329C22.703 205.977 20.48 202.733 21.645 199.721L46.6378 135.092C47.8028 132.079 45.5798 128.836 42.3499 128.836H4.60343C1.17468 128.836 -1.04751 125.218 0.502821 122.16L61.1532 2.51866C61.9364 0.973637 63.5216 0 65.2538 0H238.535ZM116.313 69.6123C97.1988 69.6125 80.6022 79.6743 72.2754 94.4548C71.567 95.7123 71.5673 97.2465 72.2763 98.5036C80.6035 113.268 97.1995 123.337 116.313 123.337C135.426 123.337 152.023 113.276 160.358 98.5046C161.068 97.247 161.068 95.7118 160.359 94.4539C152.031 79.6819 135.426 69.6123 116.313 69.6123ZM116.314 80.207C125.824 80.207 133.53 87.3984 133.531 96.2822C133.531 105.166 125.824 112.367 116.314 112.367C106.803 112.367 99.0979 105.175 99.0979 96.2822C99.0981 87.3892 106.804 80.2072 116.314 80.207Z" fill="#6E60EE"/>
          </svg>
          <div className="logo-text-group">
            <span className="logo-text">Prism</span>
            <span className="logo-badge">by Leonardo.AI</span>
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
          <div className="quality-picker">
            {QUALITY_OPTIONS.map((q) => (
              <button key={q} className={`quality-btn ${quality === q ? "active" : ""}`} onClick={() => setQuality(q)} disabled={isGenerating}>{q}</button>
            ))}
          </div>
        </div>
        <div className="section">
          <label className="label">COUNT</label>
          <select className="count-select" value={count} onChange={(e) => setCount(+e.target.value)} disabled={isGenerating}>
            <option value={1}>1 image</option>
            <option value={2}>2 images</option>
            <option value={3}>3 images</option>
            <option value={4}>4 images</option>
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

      {/* Width / Height sliders */}
      <div className="section">
        <div className="slider-row"><label className="label">WIDTH</label><span className="slider-val">{width}</span></div>
        <input type="range" min={512} max={1536} step={64} value={width} onChange={(e) => { setWidth(+e.target.value); setActivePreset("custom"); }} disabled={isGenerating} className="slider" />
      </div>

      <div className="section">
        <div className="slider-row"><label className="label">HEIGHT</label><span className="slider-val">{height}</span></div>
        <input type="range" min={512} max={1536} step={64} value={height} onChange={(e) => { setHeight(+e.target.value); setActivePreset("custom"); }} disabled={isGenerating} className="slider" />
        <div className="size-info">{width} × {height} — {((width * height) / 1000000).toFixed(2)} MP</div>
      </div>

      {/* Reference images */}
      <div className="section">
        <div className="refs-header">
          <label className="label">REFERENCE IMAGES</label>
          <span className="refs-counter">{refImages.length}/{currentModel.maxRefs}</span>
        </div>

        {refWarning && <div className="ref-warning">{refWarning}</div>}

        {refImages.length > 0 && (
          <div className="refs-grid">
            {refImages.map((r) => (
              <div key={r.id} className="ref-item">
                <img src={r.dataUrl} alt={r.name} className="ref-thumb" />
                <button className="ref-remove" onClick={() => removeRef(r.id)} disabled={isGenerating} title="Remove">×</button>
              </div>
            ))}
          </div>
        )}

        {refImages.length < currentModel.maxRefs && (
          <>
            <button className="refs-add-btn" onClick={() => fileInputRef.current?.click()} disabled={isGenerating}>
              + Add reference image
            </button>
            <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: "none" }} onChange={handleRefUpload} />
          </>
        )}
        <div className="refs-hint">Optional — guide the style or composition of the output</div>
      </div>

      {/* Prompt */}
      <div className="section">
        <label className="label">PROMPT</label>
        <textarea className="prompt-textarea" placeholder="Describe the image you want to create..." value={prompt} onChange={(e) => setPrompt(e.target.value)} disabled={isGenerating} rows={4} />
      </div>

      {error && <div className="error-banner">{error}</div>}
      {status && <div className="status-banner">{status}</div>}

      <button className={`generate-btn ${isGenerating ? "loading" : ""}`} onClick={handleGenerate} disabled={isGenerating || !prompt.trim()}>
        {isGenerating ? "Generating..." : "Generate"}
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
      </>
      )}
    </div>
  );
}
