import OpenAI from "openai";

// Robuust: verwijder storende variabelen en weiger sk-proj- keys
export function getOpenAI(): OpenAI {
    // Verwijder mogelijke stoorzenders die eerdere pogingen hebben gezet
    delete process.env.OPENAI_PROJECT;
    delete process.env.OPENAI_ORG;
    delete process.env.OPENAI_ORGANIZATION;
    delete process.env.OPENAI_BASE_URL;

    const key = (process.env.OPENAI_API_KEY || "").trim();

    if (!key) {
        throw new Error("OPENAI_API_KEY ontbreekt (zet hem in .env.local als een 'sk-' secret key).");
    }
    if (key.startsWith("sk-proj-")) {
        throw new Error(
            "Je gebruikt een project key (sk-proj-…). Die werkt niet rechtstreeks tegen api.openai.com. " +
            "Gebruik een gewone secret key (begint met 'sk-')."
        );
    }
    return new OpenAI({ apiKey: key });
}

// Optioneel debuggen zonder je key te lekken
export function logKeyHead(tag: string = "openai") {
    const head = (process.env.OPENAI_API_KEY || "").slice(0, 7);
    console.log(`[${tag}] keyHead=${head}`);
}
