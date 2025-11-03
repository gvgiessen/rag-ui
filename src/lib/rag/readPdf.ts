// src/lib/rag/readPdf.ts
import fs from "node:fs/promises";

// Typing hint (we laten TS losjes zijn)
type PdfJs = any;

async function loadPdfJs(): Promise<PdfJs> {
    // v3 pad:
    try {
        return await import("pdfjs-dist/legacy/build/pdf.js");
    } catch {
        // fallback (soms andere bundlers)
        try {
            return await import("pdfjs-dist/build/pdf.js");
        } catch {
            throw new Error(
                "Kon pdfjs-dist niet laden. Installeer bij voorkeur: `npm i pdfjs-dist@3.11.174`."
            );
        }
    }
}

export async function readPdf(file: string): Promise<string> {
    const pdfjs = await loadPdfJs();

    // 1) Node: geen worker nodig
    try {
        // in v3 zit dit op module zelf of op default; allebei proberen
        (pdfjs.GlobalWorkerOptions ?? pdfjs.default?.GlobalWorkerOptions).workerSrc = undefined;
    } catch {
        /* noop */
    }

    // 2) Lees als Uint8Array (niet Buffer → voorkomt jouw fout)
    const buf = await fs.readFile(file);
    const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

    // 3) getDocument veilig ophalen
    const getDocument =
        (pdfjs.getDocument ?? pdfjs.default?.getDocument) as (x: any) => any;

    // (extra robuustheid: schakel eval uit, Canvas/polyfills niet nodig voor text)
    const loadingTask = getDocument({ data, useSystemFonts: true, isEvalSupported: false });
    const doc = await loadingTask.promise;

    const pages: string[] = [];
    for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        const text = content.items
            .map((it: any) => (typeof it.str === "string" ? it.str : ""))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
        if (text) pages.push(text);
    }

    await doc.destroy?.();
    return pages.join("\n\n");
}
