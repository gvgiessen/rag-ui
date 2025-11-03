// src/lib/rag/prompt.ts
export function buildContext(passages: { source_name: string; section?: string; text: string }[], maxChars = 6000) {
    const blocks = [];
    let used = 0;
    for (const p of passages) {
        const head = `[${p.source_name}${p.section ? " > " + p.section : ""}]`;
        const block = `${head}\n${p.text.trim()}`;
        if (used + block.length + 4 > maxChars) break;
        blocks.push(block);
        used += block.length + 4;
    }
    return blocks.join("\n\n---\n\n");
}

export const SYSTEM = `You are a careful assistant that answers ONLY from the given CONTEXT.
- If the answer is not present, say "I don't know based on the current context."
- Always cite like [filename > path] after each claim. Do NOT fabricate.`;
