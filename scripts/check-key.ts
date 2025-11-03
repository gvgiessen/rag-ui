// scripts/check-key.ts
import fs from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import * as dotenv from "dotenv";

// 1) Eerst ALLE mogelijke oude env-keys in dit proces opschonen
delete process.env.OPENAI_API_KEY;
delete process.env.OPENAI_PROJECT;
delete process.env.OPENAI_ORG;
delete process.env.OPENAI_ORGANIZATION;
delete process.env.OPENAI_BASE_URL;

// 2) .env.local hard laden met override
const envPath = path.resolve(process.cwd(), ".env.local");
dotenv.config({ path: envPath, override: true });

// 3) Extra robuust: rechtstreeks uit het bestand parsen (als hij bestaat)
let fileKey: string | undefined;
if (fs.existsSync(envPath)) {
    const parsed = dotenv.parse(fs.readFileSync(envPath));
    fileKey = parsed.OPENAI_API_KEY?.trim();
}

// 4) Kies key: eerst .env.local (geparsed), anders env
const apiKey = (fileKey || process.env.OPENAI_API_KEY || "").trim();
if (!apiKey) {
    console.error("❌ OPENAI_API_KEY ontbreekt (.env.local)");
    process.exit(1);
}

// 5) Veiligheidscheck: gebruik GEEN project key
if (apiKey.startsWith("sk-proj-")) {
    console.error("❌ Je gebruikt een project key (sk-proj-…). Gebruik een secret key die begint met 'sk-'.");
    process.exit(1);
}

console.log(`[preflight] keyHead=${apiKey.slice(0, 7)} len=${apiKey.length}`);

const client = new OpenAI({ apiKey });

(async () => {
    try {
        await client.models.list(); // lichte ping
        console.log("✅ key OK");
    } catch (e) {
        console.error("❌ preflight FAILED:", e);
        process.exit(1);
    }
})();
