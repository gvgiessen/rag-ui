// scripts/build-index.ts
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import "tsconfig-paths/register";
import * as dotenv from "dotenv";
import { setTimeout as delay } from "node:timers/promises"; // ← retry backoff
import { listFiles, readTextGeneric } from "@/lib/rag/loaders";

/* =========================
   1) ENV – hard & defensief
   ========================= */
function loadEnvHard(): void {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_PROJECT;
    delete process.env.OPENAI_ORG;
    delete process.env.OPENAI_ORGANIZATION;
    delete process.env.OPENAI_BASE_URL;

    const envPath = path.resolve(process.cwd(), ".env.local");
    dotenv.config({ path: envPath, override: true });

    if (fsSync.existsSync(envPath)) {
        const parsed = dotenv.parse(fsSync.readFileSync(envPath));
        for (const [k, v] of Object.entries(parsed)) {
            process.env[k] = (v ?? "").toString().trim();
        }
    }
}

function apiKeyFromEnv(): string {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY ontbreekt in .env.local");
    if (apiKey.startsWith("sk-proj-")) {
        throw new Error("Gebruik een secret/service key die begint met 'sk-' (geen 'sk-proj-').");
    }
    if (!apiKey.startsWith("sk-")) {
        throw new Error("OPENAI_API_KEY lijkt ongeldig. Verwacht prefix 'sk-'.");
    }
    return apiKey;
}

/* ===================
   2) Build-config
   =================== */
const EMBED_MODEL = "text-embedding-3-large";
const BATCH = 64;

// Kleine, overlappende chunks werken meestal het best
const CHUNK_CHAR_TARGET = 1200;
const CHUNK_CHAR_OVERLAP = 220;
const MIN_CHARS_PER_CHUNK = 120;

const DOCS_DIR = process.env.RAG_DOCS_DIR ?? "D:/Documents/rag-local/docs";
const INDEX_FILE = process.env.RAG_INDEX_FILE ?? "D:/Documents/rag-local/index-web/index.json";

/* ==========================
   3) Chunking utilities
   ========================== */
function normalizeWs(s: string) {
    return s.replace(/\r\n/g, "\n")
        .split("\n")
        .map((ln) => ln.trimEnd())
        .join("\n")
        .trim();
}

const HEADING_RX = /^(#+\s+.+|(?:[A-Z][A-Z0-9 ]{3,}|.+:)$|^\d+(?:\.\d+)*\s+.+)$/;

type Chunk = {
    id: string;
    source_name: string;
    source_path: string;
    text: string;
    section?: string;
    order: number;
};

function chunkStructured(
    raw: string,
    sourcePath: string,
    target = CHUNK_CHAR_TARGET,
    overlap = CHUNK_CHAR_OVERLAP
): Chunk[] {
    const srcName = path.basename(sourcePath);
    const lines = normalizeWs(raw).split("\n");

    const blocks: { headingTrail: string[]; text: string }[] = [];
    const trail: string[] = [];
    let buf: string[] = [];

    const flush = () => {
        const text = buf.join("\n").trim();
        if (text) blocks.push({ headingTrail: [...trail], text });
        buf = [];
    };

    for (const ln of lines) {
        const s = ln.trimEnd();
        if (HEADING_RX.test(s)) {
            flush();
            const cleaned = s.replace(/^#+\s*/, "");
            if (cleaned.replace(/[#\d\.\s]/g, "").length) {
                trail.push(cleaned);
                if (trail.length > 3) trail.shift();
            }
        } else {
            buf.push(ln);
        }
    }
    flush();

    const out: Chunk[] = [];
    let order = 0;

    let acc: string[] = [];
    let accLen = 0;
    let currentSection = blocks[0]?.headingTrail.join(" > ") || undefined;

    const emit = () => {
        const text = acc.join("\n").trim();
        if (!text || text.length < MIN_CHARS_PER_CHUNK) return;
        out.push({
            id: `${srcName}::${order}`,
            source_name: srcName,
            source_path: sourcePath,
            section: currentSection,
            text,
            order,
        });
        order++;
    };

    for (const b of blocks) {
        const blockSection = b.headingTrail.join(" > ") || undefined;
        const piece = b.text;

        if (piece.length > target * 1.5) {
            const lines = piece.split("\n");
            let cur: string[] = [];
            let curLen = 0;
            const flushCur = () => {
                const t = cur.join("\n").trim();
                if (t && t.length >= MIN_CHARS_PER_CHUNK) {
                    out.push({
                        id: `${srcName}::${order}`,
                        source_name: srcName,
                        source_path: sourcePath,
                        section: blockSection,
                        text: t,
                        order,
                    });
                    order++;
                }
                if (overlap > 0) {
                    const joined = cur.join("\n");
                    const tail = joined.slice(Math.max(0, joined.length - overlap));
                    cur = [tail];
                    curLen = tail.length;
                } else {
                    cur = [];
                    curLen = 0;
                }
            };

            for (const l of lines) {
                if (curLen + l.length + 1 > target && cur.length) {
                    flushCur();
                }
                cur.push(l);
                curLen += l.length + 1;
            }
            if (cur.length) {
                const t = cur.join("\n").trim();
                if (t && t.length >= MIN_CHARS_PER_CHUNK) {
                    out.push({
                        id: `${srcName}::${order}`,
                        source_name: srcName,
                        source_path: sourcePath,
                        section: blockSection,
                        text: t,
                        order,
                    });
                    order++;
                }
            }
            continue;
        }

        if (accLen + piece.length + 2 > target && acc.length) {
            emit();
            if (overlap > 0) {
                const joined = acc.join("\n");
                const tail = joined.slice(Math.max(0, joined.length - overlap));
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
        accLen += piece.length + 2;
    }
    if (acc.length) emit();

    return out;
}

/* ==========================
   4) Embedding helpers
   ========================== */
function l2(v: number[]): number[] {
    const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / n);
}

// ← nieuw: simpele exponential backoff voor embeddings-batches
async function embedWithRetry(client: OpenAI, inputs: string[], attempts = 4) {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
        try {
            return await client.embeddings.create({ model: EMBED_MODEL, input: inputs });
        } catch (e: any) {
            lastErr = e;
            // 429/5xx? even wachten en opnieuw
            const code = e?.status || e?.code;
            const retriable = code === 429 || (code >= 500 && code < 600);
            if (!retriable || i === attempts - 1) throw e;
            const backoffMs = 300 * Math.pow(2, i);
            await delay(backoffMs);
        }
    }
    throw lastErr;
}

/* ==========================
   5) Main
   ========================== */
async function main() {
    loadEnvHard();
    const apiKey = apiKeyFromEnv();
    const client = new OpenAI({ apiKey });

    console.log("[RAG] Index build start");
    console.log("[RAG] Docs :", DOCS_DIR);
    console.log("[RAG] Out  :", INDEX_FILE);

    const files = await listFiles(DOCS_DIR);
    if (files.length === 0) {
        throw new Error(`Geen documenten gevonden in RAG_DOCS_DIR (${DOCS_DIR}).`);
    }

    console.log("[RAG] Bestanden:");
    files.forEach((f) => console.log(" -", f));

    const chunks: Chunk[] = [];
    for (const f of files) {
        const txt = await readTextGeneric(f);
        const base = path.basename(f);
        const charLen = (txt || "").length;

        if (!txt || !txt.trim()) {
            const ext = path.extname(f).toLowerCase();
            if (ext === ".pdf") {
                console.warn(`[RAG] ⚠️ PDF zonder tekst (waarschijnlijk gescand): ${base}`);
            } else {
                console.warn(`[RAG] ⚠️ Leeg/onleesbaar: ${base}`);
            }
            continue;
        }

        const parts = chunkStructured(txt, f, CHUNK_CHAR_TARGET, CHUNK_CHAR_OVERLAP)
            .filter((c) => c.text.length >= MIN_CHARS_PER_CHUNK);

        chunks.push(...parts);
        console.log(`[RAG] ✓ ${base} → ${parts.length} chunks (chars=${charLen})`);
    }

    if (chunks.length === 0) {
        throw new Error("Geen bruikbare tekst gevonden om te indexeren.");
    }

    console.log(`[RAG] Totaal: ${chunks.length} chunks`);
    process.stdout.write("[RAG] Embeddings: ");

    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += BATCH) {
        const batch = chunks.slice(i, i + BATCH);
        // optioneel: minimale logging voor diagnose
        // const avgChars = Math.round(batch.reduce((s, c) => s + c.text.length, 0) / batch.length);
        // process.stdout.write(`(avg=${avgChars})`);

        const resp = await embedWithRetry(client, batch.map((c) => c.text)); // ← retry
        resp.data.forEach((d) => vectors.push(l2(d.embedding)));
        process.stdout.write(".");
    }
    process.stdout.write("\n");

    // Assert dat vectors en chunks 1:1 zijn
    if (vectors.length !== chunks.length) {
        throw new Error(`Mismatch: vectors=${vectors.length} vs chunks=${chunks.length}`);
    }

    const dir = path.dirname(INDEX_FILE);
    if (!fsSync.existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
    }

    const out = {
        model: EMBED_MODEL,
        dim: vectors[0]?.length ?? 0,
        chunks,   // bevat section + order
        vectors,  // L2-genormaliseerd
    };

    // ← atomaire write (voorkomt corrupte index bij crash)
    const tmp = INDEX_FILE.replace(/\.json$/i, ".tmp.json");
    await fs.writeFile(tmp, JSON.stringify(out, null, 2), "utf8");
    await fs.rename(tmp, INDEX_FILE);

    console.log(`[RAG] ✅ Klaar: ${INDEX_FILE}`);
}

main().catch((err) => {
    console.error("[RAG] ❌ Fout bij indexeren:", err);
    process.exit(1);
});
