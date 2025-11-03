// app/api/index/route.ts
import { NextRequest, NextResponse } from "next/server";
import { buildIndexWeb } from "@/lib/rag/indexer";

export async function POST(_req: NextRequest) {
    try {
        const docsDir = process.env.RAG_DOCS_DIR;
        const outFile = process.env.RAG_INDEX_FILE;
        if (!docsDir || !outFile) {
            return NextResponse.json({ ok: false, error: "RAG_DOCS_DIR of RAG_INDEX_FILE ontbreekt" }, { status: 400 });
        }
        const res = await buildIndexWeb(docsDir, outFile);
        return NextResponse.json({ ok: true, ...res });
    } catch (e: any) {
        return NextResponse.json({ ok: false, error: e?.message || String(e) }, { status: 500 });
    }
}
