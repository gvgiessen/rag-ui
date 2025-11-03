// src/lib/rag/search.ts
import "server-only";
import fs from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";

export type RagChunk = {
    id: string;
    source_name: string;
    source_path: string;
    text: string;
};

export type RagIndexFile = {
    model: string;
    dim: number;
    chunks: RagChunk[];
    vectors: number[][];
};

export type RagHit = {
    rank: number;
    score: number;
    source_name: string;
    source_path: string;
    text: string;
};

const EMBED_MODEL = "text-embedding-3-large";
const CHAT_MODEL = process.env.OPENAI_FALLBACK_MODEL || "gpt-5";
const MAX_CONTEXT_TOKENS = 3500;
const TOP_K = 8;

// heel simpele token schatter (genoeg voor budgettering)
function roughTokenCount(s: string) {
    // ~1 token ≈ 4 chars — conservatief
    return Math.ceil(s.length / 4);
}

function cosine(a: number[], b: number[]) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb) || 1e-12;
    return dot / denom;
}

let memoIndex: RagIndexFile | null = null;

export async function loadIndex(indexFilePath: string): Promise<RagIndexFile> {
    if (memoIndex) return memoIndex;
    const abs = path.resolve(indexFilePath);
    const raw = await fs.readFile(abs, "utf8");
    const parsed = JSON.parse(raw) as RagIndexFile;

    if (!parsed?.vectors?.length || !parsed?.chunks?.length) {
        throw new Error("Indexbestand mist vectors of chunks.");
    }
    if (parsed.vectors[0].length !== parsed.dim) {
        throw new Error("Index dim komt niet overeen met vectorlengte.");
    }
    memoIndex = parsed;
    return parsed;
}

export async function embedQuestion(client: OpenAI, q: string): Promise<number[]> {
    const resp = await client.embeddings.create({
        model: EMBED_MODEL,
        input: q,
    });
    return resp.data[0].embedding;
}

export function search(index: RagIndexFile, qVec: number[], topK = TOP_K): RagHit[] {
    const scores = index.vectors.map((v) => cosine(v, qVec));
    const idx = scores
        .map((s, i) => ({ s, i }))
        .sort((a, b) => b.s - a.s)
        .slice(0, topK);

    return idx.map(({ s, i }, rank) => {
        const rec = index.chunks[i];
        return {
            rank: rank + 1,
            score: s,
            source_name: rec.source_name,
            source_path: rec.source_path,
            text: rec.text,
        };
    });
}

export function formatContextForPrompt(hits: RagHit[], budgetTokens = MAX_CONTEXT_TOKENS) {
    let used = 0;
    const picked: RagHit[] = [];
    for (const h of hits) {
        const t = roughTokenCount(h.text);
        if (used + t <= budgetTokens) {
            picked.push(h);
            used += t;
        } else {
            // desnoods hard truncaten aan het eind
            const allowed = Math.max(0, budgetTokens - used) * 4; // tokens→chars
            if (allowed > 200) {
                picked.push({ ...h, text: h.text.slice(0, allowed) });
            }
            break;
        }
    }

    const blocks = picked.map((p) => `[${p.source_name}]\n${p.text}`);
    return { context: blocks.join("\n\n---\n\n"), picked };
}

export async function answerWithContext(
    client: OpenAI,
    question: string,
    context: string
): Promise<string> {
    const system =
        "You are a careful assistant that answers ONLY using the provided context. " +
        "Cite sources by filename like [source_name]. If the answer is not in the context, say: 'Ik weet het niet op basis van de huidige context.' " +
        "Be concise and structured.";

    const user =
        `Answer the QUESTION using only the CONTEXT.\n\n` +
        `QUESTION:\n${question}\n\n` +
        `CONTEXT:\n${context}`;

    const resp = await client.chat.completions.create({
        model: CHAT_MODEL,
        messages: [
            { role: "system", content: system },
            { role: "user", content: user },
        ],
    });

    return resp.choices[0]?.message?.content?.trim() ?? "";
}
