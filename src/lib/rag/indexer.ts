// lib/rag/indexer.ts
import fs from "node:fs/promises";
import path from "node:path";
import { smartChunk, cosineSim, sha1 } from "./chunk";
import { listFiles, readTextGeneric } from "./loaders";
import OpenAI from "openai";

type IndexItem = {
    id: string;
    source_path: string;
    source_name: string;
    chunk_index: number;
    text: string;
    embedding: number[];
};

export type RagIndex = {
    dim: number;
    items: IndexItem[];
    created_at: string;
    docs_dir: string;
};

function getClient() {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY ontbreekt");
    const project = process.env.OPENAI_PROJECT;
    // Let op: de officiële Node SDK pakt zelf de juiste base URL (we laten proxies/base-url achterwege).
    return new OpenAI({ apiKey, project });
}

export async function buildIndexWeb(docsDir: string, outFile: string) {
    const files = await listFiles(docsDir);
    if (!files.length) throw new Error("Geen indexeerbare bestanden gevonden.");

    const client = getClient();
    const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "text-embedding-3-large";
    const TARGET = Number(process.env.RAG_CHUNK_TARGET || 1800);
    const OVERLAP = Number(process.env.RAG_CHUNK_OVERLAP || 200);
    const BATCH = Number(process.env.RAG_EMBED_BATCH || 64);

    const items: IndexItem[] = [];
    for (const f of files) {
        const txt = (await readTextGeneric(f))?.trim();
        if (!txt) continue;
        const chunks = smartChunk(txt, TARGET, OVERLAP);
        const name = path.basename(f);

        // embed per batch
        for (let i = 0; i < chunks.length; i += BATCH) {
            const slice = chunks.slice(i, i + BATCH);
            const resp = await client.embeddings.create({
                model: EMBED_MODEL,
                input: slice,
            });
            resp.data.forEach((d, j) => {
                const text = slice[j];
                items.push({
                    id: sha1(`${f}#${i + j}`),
                    source_path: f,
                    source_name: name,
                    chunk_index: i + j,
                    text,
                    embedding: d.embedding as unknown as number[],
                });
            });
        }
    }

    if (!items.length) throw new Error("Geen tekstuele chunks gevonden.");
    const dim = items[0].embedding.length;
    const index: RagIndex = {
        dim,
        items,
        created_at: new Date().toISOString(),
        docs_dir: docsDir,
    };

    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, JSON.stringify(index), "utf8");
    return { files: files.length, chunks: items.length, outFile };
}

export async function askIndexWeb(indexFile: string, question: string, topK = 8) {
    const raw = await fs.readFile(indexFile, "utf8");
    const index = JSON.parse(raw) as RagIndex;
    const client = getClient();
    const EMBED_MODEL = process.env.RAG_EMBED_MODEL || "text-embedding-3-large";

    // 1) vraag-embedding
    const qEmb = (await client.embeddings.create({ model: EMBED_MODEL, input: question }))
        .data[0].embedding as unknown as number[];

    // 2) brute-force cosine
    const scored = index.items.map((it) => ({
        it,
        score: cosineSim(qEmb, it.embedding),
    }));
    scored.sort((a, b) => b.score - a.score);
    const hits = scored.slice(0, topK).map((s, i) => ({
        rank: i + 1,
        score: s.score,
        source_name: s.it.source_name,
        source_path: s.it.source_path,
        text: s.it.text,
    }));

    // 3) context trimmen (ruim budget voor GPT-5; laat hier simpel)
    const MAX_TOKENS = Number(process.env.RAG_MAX_CONTEXT_TOKENS || 3500);
    const trimmed = trimToRoughChars(hits, MAX_TOKENS * 4); // ~ruw chars→tokens

    // 4) call GPT-5 zonder temperature
    const ctx = formatContext(trimmed);
    const sys = "You are a careful assistant that answers ONLY using the provided context. Cite sources by filename like [source_name], and say 'I don't know' if the answer isn't in the context. Do NOT invent content.";
    const user = `Answer the QUESTION using only the CONTEXT.

QUESTION:
${question}

CONTEXT:
${ctx}`;

    const chat = await client.chat.completions.create({
        model: process.env.RAG_CHAT_MODEL || "gpt-5",
        messages: [
            { role: "system", content: sys },
            { role: "user", content: user },
        ],
        // geen temperature meegeven i.v.m. GPT-5 beperking
    });

    const answer = chat.choices[0]?.message?.content?.trim() || "";
    return { answer, hits };
}

// helpers
function formatContext(passages: { source_name: string; text: string }[]) {
    return passages.map(p => `[${p.source_name}]\n${p.text}`).join("\n\n---\n\n");
}
function trimToRoughChars<T extends { text: string }>(arr: T[], charBudget: number): T[] {
    const out: T[] = [];
    let used = 0;
    for (const p of arr) {
        if (used + p.text.length <= charBudget) {
            out.push(p);
            used += p.text.length;
        } else {
            if (charBudget - used > 200) {
                out.push({ ...p, text: p.text.slice(0, charBudget - used) } as T);
            }
            break;
        }
    }
    return out;
}
