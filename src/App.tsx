import { useState, useCallback } from "react";
import { upload } from "@canva/asset";
import { addNativeElement } from "@canva/design";
import "./styles.css";

// Leonardo model options
const MODELS = [
  { id: "b24e16ff-06e3-43eb-8d33-4416c2d75876", name: "Leonardo Phoenix" },
  { id: "aa77f04e-3eec-4034-9c07-d0f619684628", name: "Leonardo Diffusion XL" },
  { id: "2067ae52-33fd-4a82-bb92-c2c55e7d2786", name: "AlbedoBase XL" },
  { id: "5c232a9e-9061-4777-980a-ddc8e65647c6", name: "DreamShaper v7" },
  { id: "e316348f-7773-490e-adcd-46757c738eb9", name: "Absolute Reality v1.6" },
];

const STANDARD_SIZES = [
  { label: "1:1", w: 1024, h: 1024 },
  { label: "2:3", w: 848, h: 1264 },
  { label: "3:2", w: 1264, h: 848 },
  { label: "16:9", w: 1376, h: 768 },
  { label: "4:3", w: 1200, h: 896 },
  { label: "9:16", w: 768, h: 1376 },
];

const SOCIAL_SIZES = [
  { label: "Instagram", w: 928, h: 1152 },
  { label: "TikTok", w: 768, h: 1376 },
  { label: "Twitter", w: 1200, h: 896 },
  { label: "Facebook", w: 1376, h: 768 },
];

const QUALITY_OPTIONS = ["low", "medium", "high"] as const;
type Quality = typeof QUALITY_OPTIONS[number];

const BACKEND_URL = "https://leonardo-canva-app.onrender.com";

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
  await addNativeElement({ type: "image", ref: asset.ref });
}

export function App() {
  const [modelId, setModelId] = useState(MODELS[0].id);
  const [quality, setQuality] = useState<Quality>("medium");
  const [count, setCount] = useState(1);
  const [width, setWidth] = useState(1024);
  const [height, setHeight] = useState(1024);
  const [prompt, setPrompt] = useState("");
  const [activePreset, setActivePreset] = useState("1:1");
  const [isGenerating, setIsGenerating] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [previewUrls, setPreviewUrls] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const selectPreset = useCallback((label: string, w: number, h: number) => {
    setActivePreset(label);
    setWidth(w);
    setHeight(h);
  }, []);

  const pollForImages = async (generationId: string): Promise<string[]> => {
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const pollRes = await fetch(`${BACKEND_URL}/api/generation/${generationId}`);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId, prompt: prompt.trim(), width, height, num_images: count, quality }),
      });
      if (!genRes.ok) { const e = await genRes.json().catch(() => ({})); throw new Error(e.message || `Error ${genRes.status}`); }
      const { generationId } = await genRes.json();
      setStatus("Generating... (10–30s)");
      const urls = await pollForImages(generationId);
      setPreviewUrls(urls);
      setStatus(`Done! Adding to slide...`);
      // Auto-insert first image
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
  }, [modelId, prompt, width, height, count, quality]);

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
      <div className="header">
        <div className="logo">
          <span className="logo-icon">⚡</span>
          <span className="logo-text">Leonardo</span>
          <span className="logo-badge">AI</span>
        </div>
      </div>

      <div className="section">
        <label className="label">MODEL</label>
        <select className="select" value={modelId} onChange={(e) => setModelId(e.target.value)} disabled={isGenerating}>
          {MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
      </div>

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
          <input className="count-input" type="number" min={1} max={4} value={count} onChange={(e) => setCount(Math.max(1, Math.min(4, +e.target.value)))} disabled={isGenerating} />
        </div>
      </div>

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

      <div className="section">
        <div className="slider-row"><label className="label">WIDTH</label><span className="slider-val">{width}</span></div>
        <input type="range" min={512} max={1536} step={64} value={width} onChange={(e) => { setWidth(+e.target.value); setActivePreset("custom"); }} disabled={isGenerating} className="slider" />
      </div>

      <div className="section">
        <div className="slider-row"><label className="label">HEIGHT</label><span className="slider-val">{height}</span></div>
        <input type="range" min={512} max={1536} step={64} value={height} onChange={(e) => { setHeight(+e.target.value); setActivePreset("custom"); }} disabled={isGenerating} className="slider" />
        <div className="size-info">{width} × {height} — {((width * height) / 1000000).toFixed(2)} MP</div>
      </div>

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
    </div>
  );
}
