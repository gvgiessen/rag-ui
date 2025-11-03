// src/lib/rag/chunk.ts
import crypto from "node:crypto";

export type Chunk = {
    id: string;
    source_name: string;
    source_path: string;
    section?: string;        // bv. "3. Stage-informatie > Deeltijd"
    text: string;
    order: number;           // absolute volgorde binnen bron
};

/**
 * Herken koppen:
 * - Markdown # H1/H2/etc
 * - ALL CAPS / kolomtitels
 * - "Titel:" (eindigt op :)
 * - Genummerde koppen: "1.2.3 Titel"
 */
export const HEADING_RX =
    /^(#+\s+.+|(?:[A-Z][A-Z0-9 ]{3,}|.+:)$|\d+(?:\.\d+)*\s+.+)$/;

/**
 * Sectie-bewuste chunker:
 * - Splitst naar "blocks" o.b.v. koppen (trail tot max 3 niveaus).
 * - Bundelt blocks tot ~targetChars.
 * - Voegt overlap (in chars) toe tussen opeenvolgende chunks.
 */
export function chunkStructured(
    raw: string,
    sourcePath: string,
    targetChars = 1200,
    overlapChars = 200
): Chunk[] {
    const safe = (raw ?? "").replace(/\r\n/g, "\n");
    const lines = safe.split("\n");

    type Block = { headingTrail: string[]; text: string };
    const blocks: Block[] = [];
    const trail: string[] = [];
    let buf: string[] = [];

    const pushBuf = () => {
        const text = buf.join("\n").trim();
        if (text) blocks.push({ headingTrail: [...trail], text });
        buf = [];
    };

    for (const ln of lines) {
        const trimmedEnd = ln.trimEnd();
        if (HEADING_RX.test(trimmedEnd)) {
            // nieuwe kop → buffer flushen
            pushBuf();
            const h = trimmedEnd.replace(/^#+\s*/, "").trim();
            // negeer lege kopjes
            if (h.replace(/[#\d\.\s]/g, "").length) {
                trail.push(h);
                // houd pad compact
                while (trail.length > 3) trail.shift();
            }
        } else {
            buf.push(ln);
        }
    }
    pushBuf();

    // Bundelen met overlap
    const chunks: Chunk[] = [];
    const sourceName = sourcePath.split(/[\\/]/).pop() || sourcePath;

    let order = 0;
    let acc: string[] = [];
    let accLen = 0;
    let currentSection: string | undefined =
        blocks.length ? blocks[0].headingTrail.join(" > ") || undefined : undefined;

    const emit = () => {
        const text = acc.join("\n").trim();
        if (!text) return;

        // ID mag lang worden; gebruik sha1 voor compacte stabiliteit
        const id = sha1(`${sourcePath}::${order}::${currentSection ?? ""}::${text.slice(0, 64)}`);

        chunks.push({
            id,
            source_name: sourceName,
            source_path: sourcePath,
            section: currentSection,
            text,
            order,
        });
        order++;
    };

    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const blockSection = b.headingTrail.join(" > ") || undefined;
        const piece = b.text;

        // Als huidige bundle te groot wordt, emit + overlap
        if (acc.length && accLen + piece.length + 1 > targetChars) {
            emit();

            if (overlapChars > 0) {
                const joined = acc.join("\n");
                const tail = joined.slice(Math.max(0, joined.length - overlapChars));
                acc = [tail];
                accLen = tail.length;
            } else {
                acc = [];
                accLen = 0;
            }
            currentSection = blockSection;
        } else if (!acc.length) {
            // Start nieuwe bundle
            currentSection = blockSection;
        }

        acc.push(piece);
        accLen += piece.length + 1; // +1 voor newline/space
    }

    if (acc.length) emit();

    return chunks;
}

/**
 * Eenvoudige wrapper: geef alleen strings terug voor embedding.
 * Houdt dezelfde logica (koppen + overlap) als chunkStructured.
 */
export function smartChunk(
    raw: string,
    targetChars = 1200,
    overlapChars = 200,
    sourcePath = "__memory__"
): string[] {
    const structured = chunkStructured(raw, sourcePath, targetChars, overlapChars);
    return structured.map((c) => c.text);
}

/**
 * Cosine similarity voor twee vectors van gelijke lengte.
 * Robuust tegen nulvectoren.
 */
export function cosineSim(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        throw new Error(`cosineSim: dimension mismatch ${a.length} vs ${b.length}`);
    }
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom > 0 ? dot / denom : 0;
}

/**
 * SHA-1 hex digest — compact, snel, deterministisch.
 * Handig voor IDs en cache keys.
 */
export function sha1(input: string): string {
    return crypto.createHash("sha1").update(input).digest("hex");
}
