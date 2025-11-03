import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

type RunResult =
    | { ok: true; stdout: string }
    | { ok: false; error: string; code?: number };

function norm(p?: string) {
    if (!p) return undefined;
    // Windows backslashes → forward slashes, en normaliseren
    return path.win32.normalize(p).replace(/\\/g, "/");
}
function toExitCode(c: number | null): number | undefined {
    return typeof c === "number" ? c : undefined;
}
function clean(v?: string) {
    if (!v) return v;
    // trim + strip eventuele quotes
    return v.trim().replace(/^["']|["']$/g, "");
}

export async function runPythonAsk(question: string): Promise<RunResult> {
    const python = norm(process.env.RAG_PYTHON) || "python";
    const script = norm(process.env.RAG_SCRIPT);
    const indexDir = norm(process.env.RAG_INDEX_DIR);
    const key = clean(process.env.OPENAI_API_KEY);
    const proj = clean(process.env.OPENAI_PROJECT);
    const debug = (process.env.RAG_DEBUG || "").toLowerCase() === "true";

    // Basischecks
    if (!script || !indexDir) return { ok: false, error: "RAG_SCRIPT of RAG_INDEX_DIR ontbreekt in env." };
    if (!fs.existsSync(python)) return { ok: false, error: `python niet gevonden: ${python}` };
    if (!fs.existsSync(script)) return { ok: false, error: `script niet gevonden: ${script}` };
    if (!fs.existsSync(indexDir)) return { ok: false, error: `indexmap niet gevonden: ${indexDir}` };
    if (!key) return { ok: false, error: "OPENAI_API_KEY ontbreekt (zet in .env.local)" };

    // Strikte check: sk-proj- vereist project-id met 'proj_' prefix
    if (key.startsWith("sk-proj-")) {
        if (!proj) {
            return {
                ok: false,
                error: "OPENAI_PROJECT ontbreekt (vereist bij sk-proj- keys). Zet OPENAI_PROJECT=proj_… in .env.local.",
            };
        }
        if (!/^proj_[A-Za-z0-9]+$/.test(proj)) {
            return { ok: false, error: `OPENAI_PROJECT ongeldig (${proj}). Verwacht vorm 'proj_xxx'.` };
        }
    }

    // Env voor child-proces: sleutel + (optioneel) project doorgeven,
    // en stoorzenders expliciet neutraliseren
    const baseEnv: NodeJS.ProcessEnv = {
        ...process.env,
        OPENAI_API_KEY: key,
        OPENAI_PROJECT: proj,

        // OpenAI base-url varianten leegmaken (SDK gebruikt dan default https://api.openai.com)
        OPENAI_BASE_URL: "",
        OPENAI_API_BASE: "",
        OPENAI_API_HOST: "",

        // Proxies (upper/lower) leegmaken om 'missing protocol' te voorkomen
        HTTP_PROXY: "",
        HTTPS_PROXY: "",
        ALL_PROXY: "",
        NO_PROXY: "",
        http_proxy: "",
        https_proxy: "",
        all_proxy: "",
        no_proxy: "",
    };

    const cwd = path.dirname(script);

    if (debug) {
        console.log("[RAG] NEXT→PY python :", python);
        console.log("[RAG] NEXT→PY script :", script);
        console.log("[RAG] NEXT→PY index  :", indexDir);
        console.log("[RAG] NEXT→PY key head:", key.slice(0, 7));
        console.log("[RAG] NEXT→PY project :", proj || "<none>");
    }

    // Eén uitvoer-run met nette timeout en stderr-capturing
    const tryRun = (args: string[], label: string, timeoutMs = 120_000) =>
        new Promise<RunResult>((resolve) => {
            const child = spawn(python, args, { shell: false, env: baseEnv, cwd });

            let out = "";
            let err = "";
            const killTimer = setTimeout(() => {
                child.kill();
                resolve({ ok: false, error: `${label}: timeout na ${timeoutMs / 1000}s` });
            }, timeoutMs);

            child.stdout.on("data", (d: Buffer) => (out += d.toString()));
            child.stderr.on("data", (d: Buffer) => (err += d.toString()));
            child.on("error", (e: Error) => {
                clearTimeout(killTimer);
                resolve({ ok: false, error: `${label}: ${e.message}` });
            });
            child.on("close", (code) => {
                clearTimeout(killTimer);
                if (code === 0) {
                    resolve({ ok: true, stdout: out.trim() });
                } else {
                    resolve({
                        ok: false,
                        error: `${label}: exit ${code}\n${(err || out).trim()}`,
                        code: toExitCode(code),
                    });
                }
            });
        });

    // 1) Probeer JSON-output
    const jsonArgs = [script, "ask", "--index", indexDir, "--question", question, "--json"];
    const r1 = await tryRun(jsonArgs, "ask --json");
    if (r1.ok) return r1;

    // 2) Fallback: plain text
    const plainArgs = [script, "ask", "--index", indexDir, "--question", question];
    const r2 = await tryRun(plainArgs, "ask (plain)");
    if (r2.ok) return r2;

    // Gecombineerde foutmelding voor UI
    return { ok: false, error: [r1.error, r2.error].filter(Boolean).join("\n---\n") };
}
