// src/lib/rag/retrieval.ts
import OpenAI from "openai";

export type VectorIndex = {
    model: string;
    dim: number;
    chunks: { id: string; source_name: string; source_path: string; section?: string; text: string; order: number }[];
    vectors: number[][]; // L2 genormaliseerd opslaan is handig
};

// simpele IDF
function makeIdf(docs: string[]): Map<string, number> {
    const df = new Map<string, number>();
    const N = docs.length;
    for (const d of docs) {
        const seen = new Set<string>();
        for (const t of d.toLowerCase().split(/[^a-z0-9\u00C0-\u024F]+/)) {
            if (!t || seen.has(t)) continue;
            seen.add(t);
            df.set(t, (df.get(t) || 0) + 1);
        }
    }
    const idf = new Map<string, number>();
    df.forEach((v, k) => idf.set(k, Math.log((N + 1) / (v + 1)) + 1));
    return idf;
}

function kwScore(q: string, text: string, idf: Map<string, number>): number {
    const qt = q.toLowerCase().split(/[^a-z0-9\u00C0-\u024F]+/).filter(Boolean);
    const tt = text.toLowerCase();
    let s = 0;
    for (const t of qt) {
        if (tt.includes(t)) s += idf.get(t) || 0.5;
    }
    return s;
}

function dot(a: number[], b: number[]) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
}

// Maximal Marginal Relevance (diversificatie)
function mmr(
    items: { idx: number; score: number }[],
    vectors: number[][],
    K: number,
    lambda = 0.6
) {
    const selected: number[] = [];
    const candidates = new Set(items.map((it) => it.idx));
    while (selected.length < K && candidates.size) {
        let best = -Infinity;
        let bestIdx = -1;
        for (const i of candidates) {
            const rel = items.find((it) => it.idx === i)!.score;
            let div = 0;
            for (const j of selected) {
                div = Math.max(div, dot(vectors[i], vectors[j]));
            }
            const mmrScore = lambda * rel - (1 - lambda) * div;
            if (mmrScore > best) {
                best = mmrScore;
                bestIdx = i;
            }
        }
        if (bestIdx === -1) break;
        selected.push(bestIdx);
        candidates.delete(bestIdx);
    }
    return selected;
}

export async function retrieve(
    client: OpenAI,
    index: VectorIndex,
    question: string,
    topK = 8,
    neighborWindow = 1,           // voeg ±1 buur-chunk toe
    alpha = 0.7                    // weging semantic vs keywords
) {
    // 1) query-embedding
    const { data } = await client.embeddings.create({
        model: index.model,
        input: question,
    });
    const qv = data[0].embedding;

    // 2) pre-compute keyword idf (eenmalig in memory; bijv. cache in module)
    const idf = makeIdf(index.chunks.map((c) => c.text));

    // 3) scores
    const scored: { idx: number; score: number }[] = [];
    for (let i = 0; i < index.chunks.length; i++) {
        const sem = dot(qv, index.vectors[i]);              // aanname: vectors L2-normed
        const kw = kwScore(question, index.chunks[i].text, idf);
        // schaal keyword grofweg naar [0..1] met log
        const kwNorm = Math.tanh(0.5 * kw);
        const fused = alpha * sem + (1 - alpha) * kwNorm;
        scored.push({ idx: i, score: fused });
    }

    // 4) sorteer + MMR
    scored.sort((a, b) => b.score - a.score);
    const picked = mmr(scored.slice(0, 40), index.vectors, topK, 0.6);

    // 5) neighbor-expand
    const withNeighbors = new Set<number>();
    for (const i of picked) {
        withNeighbors.add(i);
        for (let w = 1; w <= neighborWindow; w++) {
            const left = i - w, right = i + w;
            if (left >= 0 && index.chunks[left].source_path === index.chunks[i].source_path) withNeighbors.add(left);
            if (right < index.chunks.length && index.chunks[right].source_path === index.chunks[i].source_path) withNeighbors.add(right);
        }
    }

    const finalIdx = Array.from(withNeighbors.values())
        .map(i => ({ i, s: scored.find(x => x.idx === i)!.score }))
        .sort((a, b) => b.s - a.s)
        .slice(0, topK + 2) // net iets ruimer
        .map(x => x.i);

    return finalIdx.map(i => ({
        rank: 0, // kun je later invullen
        score: scored.find(x => x.idx === i)!.score,
        ...index.chunks[i],
    }));
}
