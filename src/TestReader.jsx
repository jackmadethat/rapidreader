import { useState, useRef, useEffect } from "react";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import workerSrc from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import JSZip from "jszip";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

// Database
const DB_NAME = "rapidreader";
const STORE = "session";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveSession(data) {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).put(data, "reader");
}

async function clearSession() {
  const db = await openDB();
  const tx = db.transaction(STORE, "readwrite");
  tx.objectStore(STORE).delete("reader");
}

async function loadSession() {
  const db = await openDB();
  return new Promise(resolve => {
    const tx = db.transaction(STORE);
    const req = tx.objectStore(STORE).get("reader");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

// Text Reconstruction
function reconstructPageText(items) {
  const lines = {};
  items.forEach(item => {
    const y = Math.round(item.transform[5]);
    if (!lines[y]) lines[y] = [];
    lines[y].push({ text: item.str, x: item.transform[4] });
  });
  const sortedLines = Object.keys(lines).sort((a, b) => b - a).map(y => lines[y].sort((a,b) => a.x - b.x).map(w => w.text).join(" "));
  return sortedLines.join("\n").replace(/-\n/g, "").replace(/\n{2,}/g, "\n\n").replace(/\s+/g, " ").trim();
}

// Helper (Spritz style pivot point)
const pivotIndex = (word) => Math.floor(Math.min(word.length, 13) * 0.4);

// Component
export default function RapidReader() {
  const [file, setFile] = useState(null);
  const [format, setFormat] = useState(null); // "pdf" or "epub"
  const [title, setTitle] = useState("");
  const [words, setWords] = useState([]);
  const [index, setIndex] = useState(0);
  const [baseWpm, setBaseWpm] = useState(300);
  const [effectiveWpm, setEffectiveWpm] = useState(300);
  const [playing, setPlaying] = useState(false);

  const timerRef = useRef(null);
  const indexRef = useRef(index);
  const wpmRef = useRef(baseWpm);

  useEffect(() => { indexRef.current = index; }, [index]);
  useEffect(() => { wpmRef.current = baseWpm; }, [baseWpm]);

  // Scrub progress bar
  const isDragging = useRef(false);  // track if user is scrubbing
  const wasPlaying = useRef(false);  // remember if reader was playing before drag
  const progressBarRef = useRef(null); // ref to the progress bar container

  const updateIndexFromEvent = (e) => {
    if (!progressBarRef.current || !words.length) return;
    const rect = progressBarRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const ratio = Math.max(0, Math.min(1, x / rect.width));
    const newIndex = Math.round(ratio * (words.length - 1));
    setIndex(newIndex);
    indexRef.current = newIndex;
  };

  const updateIndexFromTouch = (e) => {
    const touch = e.touches[0];
    if (!touch) return;
    updateIndexFromEvent(touch);
  };

  // Restore Session
  useEffect(() => {
    const restore = async () => {
      const saved = await loadSession();
      if (!saved) return;
      setWords(saved.words || []);
      setIndex(saved.index || 0);
      setBaseWpm(saved.baseWpm || 300);
      setTitle(saved.title || "");
      setFormat(saved.format || null);
      updateDisplayedWpm(saved.baseWpm || 300);
    };
    restore();
  }, []);

  // Save Session
  useEffect(() => {
    if (!words.length) return;
    saveSession({ words, index, baseWpm, title, format });
  }, [words, index, baseWpm, title, format]);

  // File Handling
  const handleFile = async e => {
    const f = e.target.files[0];
    if (!f) return;
    let fFormat = null;
    if (f.type === "application/pdf") fFormat = "pdf";
    else if (f.name.endsWith(".epub")) fFormat = "epub";
    else { 
      alert("Unsupported file type"); 
      return; 
    }

    setFile(f);
    setFormat(fFormat);
    setPlaying(false);

    // Pass the file and format directly to loadDocument to avoid async state issues
    await loadDocument(f, fFormat);
  };

  const loadDocument = async (f = file, fFormat = format) => {
    if (!f || !fFormat) return;
    if (fFormat === "pdf") await loadPDF(f);
    else if (fFormat === "epub") await loadEPUB(f);
  };

  // PDF Loading
  const loadPDF = async (f) => {
    const buffer = await f.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: buffer });
    const pdf = await loadingTask.promise;

    let docTitle = f.name.replace(/\.[^/.]+$/, "");
    try {
      const meta = await pdf.getMetadata();
      if (meta.info?.Title) docTitle = meta.info.Title;
    } catch {}
    setTitle(docTitle);

    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += reconstructPageText(content.items) + "\n\n";
    }

    const wordArray = text.replace(/\s+/g," ").trim().split(" ").filter(Boolean);
    setWords(wordArray);
    setIndex(0);
    indexRef.current = 0;
    updateDisplayedWpm(baseWpm);
  };

  // EPUB Loading
  const loadEPUB = async (f) => {
    const arrayBuffer = await f.arrayBuffer();
    const zip = await JSZip.loadAsync(arrayBuffer);

    // Parse container.xml
    const containerXml = await zip.file("META-INF/container.xml").async("string");
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerXml, "application/xml");
    const opfPath = containerDoc.querySelector("rootfile")?.getAttribute("full-path");
    if (!opfPath) return;

    const opfXml = await zip.file(opfPath).async("string");
    const opfDoc = parser.parseFromString(opfXml, "application/xml");

    // Get title
    const titleEl = opfDoc.querySelector("metadata > title");
    const docTitle = titleEl?.textContent || f.name.replace(/\.[^/.]+$/, "");
    setTitle(docTitle);

    // Build manifest
    const manifest = {};
    opfDoc.querySelectorAll("manifest > item").forEach(item => {
      manifest[item.getAttribute("id")] = item.getAttribute("href");
    });

    // Extract spine
    const itemrefs = Array.from(opfDoc.querySelectorAll("spine > itemref"));
    let fullText = "";

    for (const ir of itemrefs) {
      const id = ir.getAttribute("idref");
      const href = manifest[id];
      if (!href) continue;

      const contentPath = opfPath.replace(/[^/]+$/, "") + href;
      const fileEntry = zip.file(contentPath);
      if (!fileEntry) continue;

      const html = await fileEntry.async("string");
      const tmp = document.createElement("div");
      tmp.innerHTML = html;

      // Extract <p> text, skip short/boilerplate pages
      const paragraphs = Array.from(tmp.querySelectorAll("p")).map(p => p.textContent.trim()).filter(t => t && !t.endsWith(".xhtml") && t.length > 5);

      if (!paragraphs.length) continue;

      fullText += paragraphs.join("\n\n") + "\n\n";
    }

    const wordArray = fullText.replace(/\s+/g," ").trim().split(" ").filter(Boolean);
    setWords(wordArray);
    setIndex(0);
    indexRef.current = 0;
    updateDisplayedWpm(baseWpm);
  };

  // Timing
  const getDelay = word => {
    const base = 60000 / wpmRef.current;
    let multiplier = 1 + Math.min(word.length / 10, 0.8);
    const last = word[word.length-1];
    if ([".", "!", "?"].includes(last)) multiplier += 1.5;
    if ([",", ";", ":"].includes(last)) multiplier += 0.6;
    return base * multiplier;
  };

  const tick = () => {
    const i = indexRef.current;
    if (i >= words.length-1) { 
      setPlaying(false); 
      return; 
    }
    const delay = getDelay(words[i]);
    timerRef.current = setTimeout(() => { 
      setIndex(prev => prev+1); 
      tick(); 
    }, delay);
  };

  // Controls
  const play = () => { 
    if (playing || !words.length) 
      return; 
    setPlaying(true); 
    tick(); 
  };

  const pause = () => { 
    setPlaying(false); 
    clearTimeout(timerRef.current); 
  };

  const reset = () => { 
    pause(); 
    setIndex(0); 
    indexRef.current=0; 
  };

  const clear = () => {
    pause();
    setFile(null);
    setFormat(null);
    setTitle("");
    setWords([]);
    setIndex(0);
    setPlaying(false);
    clearSession();
  };

  const updateDisplayedWpm = (newBaseWpm) => {
    const sampleWord = "example";
    const base = 60000 / newBaseWpm;
    const multiplier = 1 + Math.min(sampleWord.length / 10, 0.8);
    const delay = base * multiplier;
    const effective = 60000 / delay;
    const rounded = Math.round(effective / 50) * 50;
    setEffectiveWpm(rounded);
  };

  const faster = () => { 
    const newWpm = baseWpm+50; 
    setBaseWpm(newWpm); 
    updateDisplayedWpm(newWpm); 
  };

  const slower = () => { 
    const newWpm = Math.max(baseWpm-50,50); 
    setBaseWpm(Math.max(baseWpm-50,50)); 
    updateDisplayedWpm(Math.max(baseWpm-50,50)); 
  };

  // Skip 10s
  const wordsPerSecond = effectiveWpm / 60;
  const skipAmount = Math.round(wordsPerSecond * 10);

  const skipForward = () => {
    setIndex(i => Math.min(words.length-1, i + skipAmount));
  };

  const skipBack = () => {
    setIndex(i => Math.max(0, i - skipAmount));
  };

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKey = (e) => {
      if (e.target.tagName === "INPUT") return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          playing ? pause() : play();
          break;
        case "KeyR":
          reset();
          break;
        case "KeyC":
          clear();
          break;
        case "ArrowRight":
          faster();
          break;
        case "ArrowLeft":
          slower();
          break;
        case "BracketRight":
          skipForward();
          break;
        case "BracketLeft":
          skipBack();
          break;
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [playing, words, index]);

  // Display
  function getTextWidth(text, font = "48px monospace") {
    const canvas = getTextWidth.canvas || (getTextWidth.canvas = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    ctx.font = font;
    return ctx.measureText(text).width;
  }

  const renderWord = word => {
    const pivot = pivotIndex(word);
    const leftWidth = getTextWidth(word.slice(0, pivot));
    return (
      <div style={{ position: "relative", width: "100%", height: 60, marginLeft: -24 + "px" }}>
        <span
          style={{
            position: "absolute",
            left: `calc(50% - ${leftWidth}px)`,
            fontFamily: "monospace",
            fontSize: 48,
            whiteSpace: "nowrap",
          }}
        >
          <span style={{ color: "#777" }}>{word.slice(0, pivot)}</span>
          <span style={{ color: "red" }}>{word[pivot] || ""}</span>
          <span>{word.slice(pivot + 1)}</span>
        </span>
      </div>
    );
  };

  const progress = words.length ? (index / words.length)*100 : 0;
  const roundedWpm = Math.round(effectiveWpm/50)*50;
  const remainingWords = words.length - index;
  const minutesLeft = roundedWpm ? (remainingWords/roundedWpm).toFixed(1) : 0;

  return (
    <div style={{ textAlign:"center", marginTop:40 }}>
      <div>
        <label htmlFor="fileUpload" className="button-30" role="button">Browse</label>
        <input id="fileUpload" type="file" accept=".pdf,.epub" onChange={handleFile} style={{ display: "none" }} />
        <button class="button-30" role="button" onClick={clear} disabled={!words.length} style={{ marginLeft: 10 + "px" }}>Clear</button>
      </div>

      <h2 className="title">{title || "Load a PDF or EPUB"}</h2>

      <div className="displayBox">
        <div style={{position:"absolute", left:"50%", width:2, height:"100%", background:"#ddd", opacity:"0.1"}} />
        {words[index] ? renderWord(words[index]) : " "}
      </div>

      <div>
        <button class="button-30" role="button" onClick={play} disabled={playing}>Play</button>
        <button class="button-30" role="button" onClick={pause}>Pause</button>
        <button class="button-30" role="button" onClick={reset}>Reset</button>
      </div>

      <div>
        <button class="button-30" role="button" onClick={skipBack}> &lt; 10s</button>
        <button class="button-30" role="button" onClick={skipForward}>10s &gt;</button>
      </div>

      <div>
        <button class="button-30" role="button" onClick={slower}>Slower</button>
        <button class="button-30" role="button" onClick={faster}>Faster</button>
      </div>

      <p className="shortcuts">Space = Play/Pause <span className="break">|</span> R = Reset <span className="break">|</span> ←/→ = Slow/Fast <span className="break">|</span> [ = Bck 10s <span className="break">|</span> ] = Fwd 10s<br />
      Drag on bar to scrub progress</p>

      <div
        ref={progressBarRef}
        className="progressBarContainer"
        style={{
          position: "relative",
          width: "80%",
          margin: "20px auto",
          height: 10,
          background: "#ccc",
          cursor: "pointer",
        }}
        // Mouse events
        onMouseDown={(e) => { isDragging.current = true; wasPlaying.current = playing; pause(); updateIndexFromEvent(e); }}
        onMouseMove={(e) => { if (isDragging.current) updateIndexFromEvent(e); }}
        onMouseUp={() => { if (isDragging.current) { isDragging.current = false; if (wasPlaying.current) play(); } }}
        onMouseLeave={() => { if (isDragging.current) { isDragging.current = false; if (wasPlaying.current) play(); } }}
        // Touch events
        onTouchStart={(e) => { isDragging.current = true; wasPlaying.current = playing; pause(); updateIndexFromTouch(e); }}
        onTouchMove={(e) => { if (isDragging.current) updateIndexFromTouch(e); }}
        onTouchEnd={() => { if (isDragging.current) { isDragging.current = false; if (wasPlaying.current) play(); } }}
      >
        <div style={{ width: `${progress}%`, height: "100%", background: "#9b0000" }} />
      </div>

       <div className="stats">
        <p>words</p>
        <p>Effective WPM</p>
        <p>Estimated time left</p>
        <p>{index} / {words.length}</p>
        <p>{roundedWpm}</p>
        <p>{minutesLeft} min</p>
      </div> 

      <button class="button-30"><a href="https://oceanofpdf.com/" target="_blank">Find Books</a></button>
      <button class="button-30"><a href="https://github.com/jackmadethat/rapidreader#readme" target="_blank" rel="noopener noreferrer">README.md</a></button>

    </div>
  );
}