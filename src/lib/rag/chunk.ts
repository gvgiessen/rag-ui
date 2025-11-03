// src/lib/rag/chunk.ts
export type Chunk = {
    id: string;
    source_name: string;
    source_path: string;
    section?: string;        // bv. "3. Stage-informatie > Deeltijd"
    text: string;
    order: number;           // absolute volgorde binnen bron
};

const HEADING_RX =
    /^(#+\s+.+|(?:[A-Z][A-Z0-9 ]{3,}|.+:)$|^\d+(\.\d+)*\s+.+)$/;
// Markdown #, ALL CAPS/kolomtitels, "Titel:" of "1.2.3 Titel"

export function chunkStructured(
    raw: string,
    sourcePath: string,
    targetChars = 1200,
    overlapChars = 200
): Chunk[] {
    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    const blocks: { headingTrail: string[]; text: string }[] = [];
    const trail: string[] = [];
    let buf: string[] = [];

    const pushBuf = () => {
        const text = buf.join("\n").trim();
        if (text) blocks.push({ headingTrail: [...trail], text });
        buf = [];
    };

    for (const ln of lines) {
        const s = ln.trimEnd();
        if (HEADING_RX.test(s)) {
            pushBuf();
            // onderhoud trail (max 3) zodat “pad” compact blijft
            if (s.replace(/[#\d\.\s]/g, "").length) {
                trail.push(s.replace(/^#+\s*/, ""));
                if (trail.length > 3) trail.shift();
            }
        } else {
            buf.push(ln);
        }
    }
    pushBuf();

    // bundel blocks tot ~targetChars met overlap
    const chunks: Chunk[] = [];
    let order = 0;
    let acc: string[] = [];
    let accLen = 0;
    let currentSection = blocks[0]?.headingTrail.join(" > ") || undefined;

    const emit = () => {
        const text = acc.join("\n").trim();
        if (text) {
            chunks.push({
                id: `${sourcePath}::${order}`,
                source_name: sourcePath.split(/[\\/]/).pop() || sourcePath,
                source_path: sourcePath,
                section: currentSection,
                text,
                order,
            });
            order++;
        }
    };

    for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        const blockSection = b.headingTrail.join(" > ") || undefined;
        const piece = b.text;

        if (accLen + piece.length + 1 > targetChars && acc.length) {
            emit();
            // overlap
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
            currentSection = blockSection;
        }

        acc.push(piece);
        accLen += piece.length + 1;
    }
    if (acc.length) emit();

    return chunks;
}
