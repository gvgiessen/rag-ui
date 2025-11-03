// src/lib/rag/loaders.ts
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import mammoth from "mammoth";
import { DOMParser } from "@xmldom/xmldom";
import JSZip from "jszip";

export const SUPPORTED_EXT = [".pdf", ".docx", ".pptx", ".txt", ".md", ".csv"];

/* =========================
   Bestanden verzamelen
   ========================= */
export async function listFiles(dir: string): Promise<string[]> {
    const pats = SUPPORTED_EXT.flatMap((ext) => [`**/*${ext}`, `**/*${ext.toUpperCase()}`]);
    return fg(pats, { cwd: dir, dot: false, absolute: true, followSymbolicLinks: true });
}

/* =========================
   Generieke reader
   ========================= */
export async function readTextGeneric(file: string): Promise<string> {
    const ext = path.extname(file).toLowerCase();

    if (ext === ".txt" || ext === ".md" || ext === ".csv") {
        const raw = await fs.readFile(file, "utf8");
        return raw.toString();
    }

    if (ext === ".pdf") return await readPdf(file);
    if (ext === ".docx") return await readDocx(file);
    if (ext === ".pptx") return await readPptx(file);

    return "";
}

/* =========================
   PDF (tekst-extractie)
   ========================= */
/**
 * Robuuste PDF-reader:
 * - eerst sidecar .txt proberen (snel en handig bij probleem-PDF’s)
 * - daarna pdfjs-dist: Uint8Array input, worker uit (Node)
 */
async function readPdf(file: string): Promise<string> {
    const base = path.basename(file, ".pdf");
    const dir = path.dirname(file);

    // 0) sidecar .txt naast PDF (bv. "doc.pdf.txt" of "doc.txt")
    for (const s of [file + ".txt", path.join(dir, base + ".txt")]) {
        if (fsSync.existsSync(s)) {
            try {
                const txt = await fs.readFile(s, "utf8");
                const clean = txt.trim();
                if (clean) return clean;
            } catch { /* ignore */ }
        }
    }

    // 1) pdfjs-dist – werkt voor “echte” (niet-gescande) tekst-PDF’s
    try {
        // Dynamische import zodat bundlers niet crashen op Node/CSS/canvas
        const pdfjs: any =
            (await import("pdfjs-dist/legacy/build/pdf.js")) ||
            (await import("pdfjs-dist/build/pdf.js"));

        // In Node geen worker nodig (en geen canvas). Zet uit.
        try {
            (pdfjs.GlobalWorkerOptions ?? pdfjs.default?.GlobalWorkerOptions).workerSrc = undefined;
        } catch { /* ignore */ }

        // ✅ Uint8Array (niet Buffer) – voorkomt “Please provide Uint8Array”
        const buf = await fs.readFile(file);
        const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

        const getDocument = (pdfjs.getDocument ?? pdfjs.default?.getDocument) as (x: any) => any;
        const task = getDocument({ data, isEvalSupported: false, useSystemFonts: true });
        const doc = await task.promise;

        const pages: string[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
            const page = await doc.getPage(p);
            const content = await page.getTextContent();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const text = (content.items as any[])
                .map((it) => (typeof it.str === "string" ? it.str : ""))
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
            if (text) pages.push(text);
            await page.cleanup?.();
        }

        await doc.destroy?.();
        return pages.join("\n\n");
    } catch (err) {
        console.warn(`[PDF] Fout bij lezen van ${path.basename(file)}:`, (err as Error).message);
    }

    // 2) niets bruikbaars gevonden
    return "";
}

/* =========================
   DOCX
   ========================= */
async function readDocx(file: string): Promise<string> {
    try {
        const buf = await fs.readFile(file);
        const { value } = await mammoth.extractRawText({ buffer: buf });
        return (value || "").trim();
    } catch {
        return "";
    }
}

/* =========================
   PPTX
   ========================= */
async function readPptx(file: string): Promise<string> {
    try {
        const buf = await fs.readFile(file);
        const zip = await JSZip.loadAsync(buf);
        const slideNames = Object.keys(zip.files).filter(
            (n) => n.startsWith("ppt/slides/slide") && n.endsWith(".xml"),
        );

        const out: string[] = [];
        for (const s of slideNames) {
            const xml = await zip.files[s].async("string");
            const doc = new DOMParser().parseFromString(xml, "text/xml");
            const nodes = doc.getElementsByTagName("a:t");
            const texts = Array.from(nodes).map((el: Element) => el.textContent ?? "");
            const joined = texts.join(" ").trim();
            if (joined) out.push(joined);
        }
        return out.join("\n\n");
    } catch {
        return "";
    }
}
