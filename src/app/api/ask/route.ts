// app/api/ask/route.ts
import "server-only";
import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import fs from "node:fs/promises";
import path from "node:path";

const INDEX_FILE = process.env.RAG_INDEX_FILE ?? "D:/Documents/rag-local/index-web/index.json";
const EMBED_MODEL = "text-embedding-3-large";
const TOP_K = 12;

type Chunk = { id: string; source_name: string; source_path: string; text: string };
type IndexJson = { model: string; dim: number; chunks: Chunk[]; vectors: number[][] };

let cache: IndexJson | null = null;
async function getIndex(): Promise<IndexJson> {
    if (cache) return cache;
    const raw = await fs.readFile(INDEX_FILE, "utf8");
    cache = JSON.parse(raw);
    if (!cache?.chunks?.length || !cache?.vectors?.length)
        throw new Error("Indexbestand ongeldig of leeg.");
    return cache!;
}

function dot(a: number[], b: number[]) { let s = 0; for (let i=0;i<a.length;i++) s += a[i]*b[i]; return s; }
function norm(a: number[]) { return Math.sqrt(dot(a,a)) || 1; }
function normalize(a: number[]) { const n = norm(a); return a.map(x => x / n); }
function preview(s: string, n=280) { const t = s.replace(/\s+/g," ").trim(); return t.length>n ? t.slice(0,n-1)+"…" : t; }

export async function POST(req: NextRequest) {
    const startedAt = Date.now();
    try {
        const bodyText = await req.text(); // ← ruwe body voor debugging
        let body: any;
        try { body = JSON.parse(bodyText || "{}"); } catch { body = {}; }

        const question = (body?.question ?? "").toString().trim();
        console.log("[api/ask] bodyText.len", bodyText.length, "| question:", question.slice(0,120));

        if (!question) {
            return NextResponse.json({ ok:false, error:"Vraag ontbreekt.", code:"bad_request" }, { status: 400 });
        }

        const apiKey = (process.env.OPENAI_API_KEY || "").trim();
        if (!apiKey || apiKey.startsWith("sk-proj-")) {
            return NextResponse.json({
                ok:false,
                error:"OPENAI_API_KEY ontbreekt of is sk-proj-; gebruik een 'sk-' service/secret key.",
                code:"auth",
            }, { status: 500 });
        }

        const index = await getIndex();
        console.log("[api/ask] index loaded:", { file: path.normalize(INDEX_FILE), chunks: index.chunks.length, dim: index.dim });

        const openai = new OpenAI({ apiKey });

        // 1) Embedding
        const qe = await openai.embeddings.create({ model: EMBED_MODEL, input: question });
        const q = normalize(qe.data[0].embedding);

        // 2) Scoren (index-vectors zijn al genormaliseerd → dot == cosine)
        const scored = index.vectors.map((v,i) => ({ i, score: dot(q, v) }))
            .sort((a,b) => b.score - a.score)
            .slice(0, Math.min(TOP_K, index.vectors.length));

        const passages = scored.map(({i, score}) => {
            const c = index.chunks[i];
            return { source_name: c.source_name, source_path: c.source_path, text: c.text, score };
        });

        const ctx = passages.map((p,k) => `[[${k+1}]] ${p.source_name}\n${p.text}`).join("\n\n---\n\n");

        // 3) LLM-call
        const system = "Je bent een vriendelijke, behulpzame, maar vooral zorgvuldige slimme assistent. Gebruik alleen de context en verwijs naar [bestandsnaam], maar gebruik nooit een zin zoals: 'volgens document..' of 'zoals staat in' of 'zoals genoemd in' of 'in dit document:' of gewoon 'in'. Geef antwoord in hele zinnen.";
        const user = `VRAAG:\n${question}\n\nCONTEXT:\n${ctx || "(leeg)"}\n`;

        const chat = await openai.chat.completions.create({
            model: process.env.OPENAI_FALLBACK_MODEL || "gpt-5",
            messages: [{ role:"system", content: system }, { role:"user", content: user }],
        });

        let answer = (chat.choices?.[0]?.message?.content ?? "").trim();
        if (!answer) answer = "Ik kan het niet beantwoorden op basis van de huidige context.";

        const payload = {
            ok: true as const,
            mode: "json" as const,
            // ↓ compat: zet 'answer' zowel op root als in data.answer
            answer,
            data: {
                answer,
                hits: passages.map(p => ({ source_name: p.source_name, score: p.score, preview: preview(p.text) })),
            },
        };

        console.log("[api/ask] answer.len", answer.length, "hits", passages.length, "elapsed(ms)", Date.now()-startedAt);
        return NextResponse.json(payload);
    } catch (e: any) {
        console.error("[api/ask] error:", e);
        return NextResponse.json({ ok:false, error: e?.message || "Serverfout" }, { status: 500 });
    }
}
