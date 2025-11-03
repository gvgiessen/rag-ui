// app/chat/Chat.tsx
"use client";

import React, { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { toast } from "sonner";
import { Loader2, SendHorizontal, FileText, Bot, User } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

/* ---------- Types ---------- */
type Source = { source_name: string; score?: number; preview?: string };

type ApiOkShapeA = { ok: true; answer?: string; hits?: unknown; model?: string };
type ApiOkShapeB = {
    ok: true;
    mode?: string;
    data?: { answer?: unknown; hits?: unknown } | unknown;
    answer?: unknown;
    model?: string;
};
type ApiErr = { ok: false; error: string; code?: string | number };

type AskApiResponse = ApiOkShapeA | ApiOkShapeB | ApiErr;

type Message = {
    id: string;
    role: "user" | "assistant";
    content: string;
    sources?: Source[];
    model?: string;
};

/* ---------- Helpers ---------- */
const DEBUG = (process.env.NEXT_PUBLIC_DEBUG || "").toLowerCase() === "true";

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === "object" && v !== null;
}

function isSource(v: unknown): v is Source {
    if (!isRecord(v)) return false;
    const name = "source_name" in v ? v.source_name : undefined;
    const score = "score" in v ? v.score : undefined;
    const preview = "preview" in v ? v.preview : undefined;

    return (
        typeof name === "string" &&
        (score === undefined || typeof score === "number") &&
        (preview === undefined || typeof preview === "string")
    );
}

function toSources(maybe: unknown): Source[] | undefined {
    if (!Array.isArray(maybe)) return undefined;
    const mapped: Source[] = [];

    for (const item of maybe) {
        if (isSource(item)) {
            mapped.push(item);
            continue;
        }
        if (isRecord(item) && "source_name" in item && typeof item.source_name === "string") {
            const score = "score" in item && typeof item.score === "number" ? (item.score as number) : undefined;
            const preview =
                "preview" in item && typeof item.preview === "string"
                    ? (item.preview as string)
                    : "text" in item && typeof item.text === "string"
                        ? (item.text as string)
                        : undefined;

            mapped.push({ source_name: String(item.source_name), score, preview });
        }
    }
    return mapped;
}

function extractAnswerField(p: Record<string, unknown>): string | undefined {
    if ("answer" in p && typeof p.answer === "string") return p.answer;

    if ("data" in p) {
        const d = p.data;
        if (typeof d === "string") return d;
        if (isRecord(d) && "answer" in d && typeof d.answer === "string") return d.answer;
    }
    return undefined;
}

function extractHitsField(p: Record<string, unknown>): Source[] | undefined {
    const topHitsCandidate = "hits" in p ? p.hits : undefined;
    const topHits = toSources(topHitsCandidate);
    if (topHits?.length) return topHits;

    if ("data" in p) {
        const d = p.data;
        if (isRecord(d)) {
            const dh = "hits" in d ? d.hits : undefined;
            const dataHits = toSources(dh);
            if (dataHits?.length) return dataHits;
        }
    }
    return undefined;
}

function coerceAnswer(payload: AskApiResponse): {
    ok: boolean;
    answer: string;
    sources?: Source[];
    model?: string;
    error?: string;
} {
    if (!isRecord(payload)) return { ok: false, answer: "", error: "Lege of ongeldige serverrespons." };

    if ("ok" in payload && payload.ok === false) {
        const err = "error" in payload && typeof payload.error === "string" ? payload.error : "Serverfout.";
        return { ok: false, answer: "", error: err };
    }

    const p = payload as Record<string, unknown>;
    const answer = extractAnswerField(p);
    const hits = extractHitsField(p);
    const model = "model" in p && typeof p.model === "string" ? (p.model as string) : undefined;

    const finalAnswer =
        answer && answer.trim()
            ? answer
            : hits?.length
                ? "Ik vond relevante passages, maar er kwam geen tekstueel antwoord terug."
                : "Er is geen antwoord ontvangen.";

    return { ok: true, answer: finalAnswer, sources: hits, model };
}

/** Inline bronverwijzingen: [Bestandsnaam.pdf|.docx|.pptx|.txt|.md|.csv] */
const INLINE_SRC_RE = /\[([^\]\n]+?\.(?:pdf|docx|pptx|txt|md|csv))\]/gi;

/* ---------- UI: Pill (zonder score/preview) ---------- */
function SourcePill({ label }: { label: string }) {
    return (
        <HoverCard openDelay={120} closeDelay={80}>
            <HoverCardTrigger asChild>
        <span className="inline-flex align-baseline">
          <Badge
              variant="secondary"
              className="rounded-full cursor-default select-none inline-flex align-baseline mx-1"
              title={label}
          >
            Bron
          </Badge>
        </span>
            </HoverCardTrigger>
            <HoverCardContent className="w-80" align="start" side="top">
                <div className="flex items-start gap-2">
                    <FileText className="h-4 w-4 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <div className="text-sm font-medium break-words">{label}</div>
                    </div>
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}

/* ---------- Rendering met “zoals vermeld in” + inline markers ---------- */
function pickPrimarySource(sources?: Source[]): Source | undefined {
    if (!sources?.length) return undefined;

    const withScore = sources.filter((s): s is Source & { score: number } => typeof s.score === "number");
    if (withScore.length) return [...withScore].sort((a, b) => b.score - a.score)[0];

    return sources[0];
}

function renderSmartContent(text: string, sources?: Source[]) {
    if (!text) return null;

    // 1) inline markers → pill op die plek
    const nodes: ReactNode[] = [];
    let lastIndex = 0;
    let m: RegExpExecArray | null;

    while ((m = INLINE_SRC_RE.exec(text)) !== null) {
        const matchStart = m.index;
        const matchEnd = INLINE_SRC_RE.lastIndex;
        const fileName = m[1];

        const before = text.slice(lastIndex, matchStart);
        if (before) nodes.push(<span key={`t-${lastIndex}`}>{before}</span>);

        const src = sources?.find((s) => s.source_name?.toLowerCase() === fileName.toLowerCase());
        nodes.push(<SourcePill key={`pill-${matchStart}`} label={src?.source_name ?? fileName} />);

        lastIndex = matchEnd;
    }
    const tail = text.slice(lastIndex);
    if (tail) nodes.push(<span key={`tail-${lastIndex}`}>{tail}</span>);

    if (nodes.length > 1) {
        return <span className="inline whitespace-pre-wrap leading-relaxed">{nodes}</span>;
    }

    // 2) “zoals vermeld in …” vervangen
    const primary = pickPrimarySource(sources);
    if (primary?.source_name) {
        const PHRASE_RE = /\bzoals vermeld in\b([\s\S]*?)([.!?]|\n|$)/i;
        const match = text.match(PHRASE_RE);

        if (match && typeof match.index === "number") {
            const phraseStart = match.index;
            const RAW_PHRASE_RE = /\bzoals vermeld in\b/i;
            const sliced = text.slice(phraseStart);
            const phraseOnly = RAW_PHRASE_RE.exec(sliced);

            if (phraseOnly && typeof phraseOnly.index === "number") {
                const phraseOnlyStart = phraseStart + phraseOnly.index;
                const phraseOnlyEnd = phraseOnlyStart + phraseOnly[0].length;

                const consumedLen = match[0].length;
                const consumedEnd = phraseStart + consumedLen;

                const before = text.slice(0, phraseOnlyEnd);
                const trailingPunc = match[2];
                const punctuationToKeep = /[.!?]/.test(trailingPunc) ? trailingPunc : "";

                const replaced = before.trimEnd() + " " + primary.source_name + punctuationToKeep + text.slice(consumedEnd);

                return <span className="inline whitespace-pre-wrap leading-relaxed">{replaced}</span>;
            }
        }
    }

    // 3) geen frase → 1 pill achter de zin
    if (primary?.source_name) {
        return (
            <span className="inline whitespace-pre-wrap leading-relaxed">
        {text} <SourcePill label={primary.source_name} />
      </span>
        );
    }

    return <span className="inline whitespace-pre-wrap leading-relaxed">{text}</span>;
}

/* ---------- Welkomstprompts: deterministische SSR + client-only random ---------- */
const WELCOME_PROMPTS = [
    "Waar denk je vandaag aan?",
    "Wat staat er op de planning?",
    "Waar kan ik je vandaag mee helpen?",
    "Hoe gaat het?",
    "Wat kan ik voor je doen?",
    "Welke taak wil je nu oppakken?",
    "Wat is je belangrijkste vraag van vandaag?",
] as const;
const DEFAULT_WELCOME = WELCOME_PROMPTS[4]; // "Wat kan ik voor je doen?"

/* ---------- Component ---------- */
export default function Chat() {
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState("");
    const [loading, setLoading] = useState(false);

    // vaste onderbalk → padding berekenen
    const [barH, setBarH] = useState(0);
    const inputRef = useRef<HTMLTextAreaElement | null>(null);
    const barRef = useRef<HTMLDivElement | null>(null);
    const composingRef = useRef(false);

    // dynamisch gemeten 1-regel-hoogte + UX-constants
    const singleLineHRef = useRef<number>(58); // fallback tot we gemeten hebben
    const MAX_H = 240; // max textarea hoogte
    const MIN_TOUCH_H = 44; // minimale totale balkhoogte
    const WRAPPER_VERTICAL_PADDING = 16; // py-2 => 8 + 8
    const [expanded, setExpanded] = useState(false);

    // Welkomsttekst: SSR-vast, na mount willekeurig
    const [welcomeText, setWelcomeText] = useState<string>(DEFAULT_WELCOME);
    useEffect(() => {
        const next = WELCOME_PROMPTS[Math.floor(Math.random() * WELCOME_PROMPTS.length)];
        setWelcomeText(next);
    }, []);

    const hasAsked = messages.length > 0;

    function createMessage(
        role: Message["role"],
        content: string,
        extras?: Partial<Pick<Message, "sources" | "model">>
    ): Message {
        return {
            id: crypto.randomUUID(),
            role,
            content,
            ...(extras?.sources ? { sources: extras.sources } : {}),
            ...(extras?.model ? { model: extras.model } : {}),
        };
    }

    function scrollToBottom() {
        if (typeof window === "undefined") return;
        const el = document.scrollingElement || document.documentElement;
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                window.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
            });
        });
    }

    useEffect(() => {
        if (!barRef.current) return;
        const el = barRef.current;
        const measure = () => setBarH(el.offsetHeight);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    useEffect(() => {
        scrollToBottom();
    }, [messages, loading]);

    /* ----- meten: exacte 1-regel-hoogte ----- */
    const measureSingleLine = () => {
        const el = inputRef.current;
        if (!el) return;

        const prevVal = el.value;
        const prevHeight = el.style.height;
        const prevOverflow = el.style.overflow;

        el.value = "x";
        el.style.height = "auto";
        el.style.overflow = "hidden";

        const h = el.scrollHeight;

        el.value = prevVal;
        el.style.height = prevHeight;
        el.style.overflow = prevOverflow;

        if (h > 0) singleLineHRef.current = h;
    };

    /* ----- auto-grow textarea ----- */
    const autoGrow = () => {
        const el = inputRef.current;
        if (!el) return;

        if (!singleLineHRef.current || singleLineHRef.current <= 0) {
            measureSingleLine();
        }

        el.style.height = "auto";
        const needed = Math.min(el.scrollHeight, MAX_H);

        // minimaal tekstgebied zodat wrapper >= MIN_TOUCH_H uitkomt (i.c.m. py-2)
        const minTextareaH = Math.max(singleLineHRef.current, MIN_TOUCH_H - WRAPPER_VERTICAL_PADDING);

        el.style.height = `${Math.max(needed, minTextareaH)}px`;

        // expanded wanneer er meer dan 1 regel nodig is
        setExpanded(needed > singleLineHRef.current + 1);
    };

    // init & updates
    useEffect(() => {
        measureSingleLine();
        autoGrow();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);
    useEffect(() => {
        autoGrow();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [input]);

    // bij venster-resize (mobile keyboard / DPI) opnieuw meten
    useEffect(() => {
        const onResize = () => {
            measureSingleLine();
            autoGrow();
        };
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const canSend = useMemo(() => input.trim().length > 0 && !loading, [input, loading]);

    async function send() {
        const question = input.trim();
        if (!question || composingRef.current) return;

        setMessages((prev) => {
            const next = [...prev, createMessage("user", question)];
            setTimeout(() => scrollToBottom(), 10);
            return next;
        });

        setInput("");
        setLoading(true);

        try {
            const res = await fetch("/api/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question }),
            });

            let payload: unknown;
            try {
                payload = await res.json();
            } catch {
                payload = undefined;
            }

            if (DEBUG) {
                console.log("[/api/ask] http", res.status);
                console.log("[/api/ask] payload:", payload);
            }

            if (!res.ok || !payload) {
                const msg =
                    isRecord(payload) && "error" in payload && typeof (payload as any).error === "string"
                        ? ((payload as any).error as string)
                        : `HTTP ${res.status}`;
                toast.error(msg);
                setMessages((prev) => {
                    const next = [...prev, createMessage("assistant", `Serverfout:\n\n${msg}`)];
                    setTimeout(() => scrollToBottom(), 50);
                    return next;
                });
                return;
            }

            const coerced = coerceAnswer(payload as AskApiResponse);
            if (!coerced.ok) {
                toast.error(coerced.error || "Vraag mislukt");
                setMessages((prev) => {
                    const next = [...prev, createMessage("assistant", `Serverfout:\n\n${coerced.error ?? "Onbekend"}`)];
                    setTimeout(() => scrollToBottom(), 50);
                    return next;
                });
                return;
            }

            setMessages((prev) => {
                const next = [
                    ...prev,
                    createMessage("assistant", coerced.answer, { sources: coerced.sources, model: coerced.model }),
                ];
                setTimeout(() => scrollToBottom(), 50);
                return next;
            });
        } catch (e) {
            const message = e instanceof Error ? e.message : "Onbekende fout in fetch.";
            toast.error(message);
            setMessages((prev) => {
                const next = [
                    ...prev,
                    createMessage(
                        "assistant",
                        "Er trad een netwerk- of serverfout op bij het opvragen van het antwoord. Probeer opnieuw."
                    ),
                ];
                setTimeout(() => scrollToBottom(), 50);
                return next;
            });
        } finally {
            setLoading(false);
            inputRef.current?.focus();
        }
    }

    /* ---------- Animatievarianten voor de vraagbalk ---------- */
    const barVariants = {
        center: {
            top: "50%",
            bottom: "auto",
            y: "-50%",
            transition: { type: "spring", stiffness: 420, damping: 36 },
        },
        docked: {
            top: "auto",
            bottom: "1rem",
            y: 0,
            transition: { type: "spring", stiffness: 420, damping: 36 },
        },
    } as const;

    return (
        <div className="mx-auto max-w-3xl px-4 md:px-6 min-h-dvh relative">
            {/* Berichtenlijst */}
            <div
                className="pt-6"
                style={{
                    paddingBottom: hasAsked ? `calc(${Math.max(barH, 80)}px + env(safe-area-inset-bottom))` : 0,
                }}
            >
                {messages.map((m) => (
                    <MessageBubble key={m.id} role={m.role} content={m.content} sources={m.sources} model={m.model} />
                ))}

                {loading && <TypingBubble />}
            </div>

            {/* Welkomstprompt zolang er nog geen vraag is */}
            <AnimatePresence>
                {!hasAsked && (
                    <motion.div
                        key="welcome-title"
                        className="pointer-events-none text-center absolute left-0 right-0"
                        initial={{ opacity: 0, y: -10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -10 }}
                        transition={{ duration: 0.25 }}
                        style={{ top: "35%" }}
                    >
                        <div className="mx-auto max-w-xl">
                            <h2 className="text-balance text-2xl md:text-3xl font-semibold text-foreground">{welcomeText}</h2>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Invoerbalk (midden → onder) */}
            <motion.div
                ref={barRef}
                className="fixed left-0 right-0 z-50 bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60 mx-auto max-w-3xl px-4 md:px-6"
                style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
                variants={barVariants}
                initial="center"
                animate={hasAsked ? "docked" : "center"}
                aria-label="Vraagbalk"
            >
                <div
                    className={[
                        "border shadow-sm flex items-center gap-3 transition-all duration-200 px-4",
                        "py-2", // altijd padding voor comfortabele touch-hoogte
                        "focus-within:outline-none focus-within:ring-0 focus-within:ring-offset-0",
                        expanded ? "rounded-2xl" : "rounded-full",
                    ].join(" ")}
                    style={{
                        // minimaal: 1 regel + padding, maar nooit onder MIN_TOUCH_H
                        minHeight: `${Math.max(singleLineHRef.current + WRAPPER_VERTICAL_PADDING, MIN_TOUCH_H)}px`,
                    }}
                >
                    <div className="flex-1 flex items-center h-full">
            <textarea
                ref={inputRef}
                value={input}
                rows={1}
                onChange={(e) => {
                    setInput(e.target.value);
                    autoGrow();
                }}
                onInput={autoGrow}
                placeholder="Schrijf je vraag…"
                className={[
                    "w-full bg-transparent resize-none",
                    "overflow-hidden", // wil je scrollen bij MAX_H? vervang door "overflow-y-auto"
                    "text-[16px] placeholder:text-muted-foreground",
                    "min-h-0 [field-sizing:auto] p-0 m-0",
                    "outline-none border-0 ring-0 appearance-none",
                ].join(" ")}
                style={{
                    padding: 0,
                    margin: 0,
                    height: "auto", // autoGrow zet de echte hoogte
                    maxHeight: `${MAX_H}px`,
                }}
                onCompositionStart={() => (composingRef.current = true)}
                onCompositionEnd={() => (composingRef.current = false)}
                onKeyDown={(e) => {
                    // Enter = verzenden; Shift+Enter = nieuwe regel
                    if (e.key === "Enter" && !e.shiftKey && !composingRef.current) {
                        e.preventDefault();
                        if (canSend) void send();
                    }
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !composingRef.current) {
                        e.preventDefault();
                        if (canSend) void send();
                    }
                }}
                aria-label="Bericht invoeren"
            />
                    </div>

                    <Button
                        onClick={send}
                        disabled={!canSend}
                        size="icon"
                        className="rounded-full shrink-0"
                        aria-label={loading ? "Bezig met verzenden" : "Verstuur bericht"}
                    >
                        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <SendHorizontal className="h-4 w-4" />}
                    </Button>
                </div>
            </motion.div>
        </div>
    );
}

/* ---------- Bubble ---------- */
function MessageBubble({
                           role,
                           content,
                           sources,
                           model: _model, // niet gebruikt
                       }: {
    role: "user" | "assistant";
    content: string;
    sources?: Source[];
    model?: string;
}) {
    const isUser = role === "user";

    return (
        <div className="w-full mb-6">
            <div className={`flex items-start gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
                {!isUser && (
                    <div className="mt-1 shrink-0 rounded-full border p-2">
                        <Bot className="h-4 w-4" />
                    </div>
                )}

                <div
                    className={[
                        "max-w-[85%] rounded-2xl border px-4 py-3",
                        isUser ? "bg-primary text-primary-foreground ml-10" : "bg-card mr-10",
                    ].join(" ")}
                >
                    <div className="prose prose-sm max-w-none dark:prose-invert [&_p]:inline [&_p]:m-0">
                        {content?.trim()?.length ? renderSmartContent(content, sources) : <em>(Geen antwoord)</em>}
                    </div>
                </div>

                {isUser && (
                    <div className="mt-1 shrink-0 rounded-full border p-2">
                        <User className="h-4 w-4" />
                    </div>
                )}
            </div>
        </div>
    );
}

/* ---------- Typing indicator bubble ---------- */
function TypingBubble() {
    return (
        <div className="w-full mb-6" aria-live="polite" aria-label="Assistant is typing">
            <div className="flex items-start gap-3 justify-start">
                <div className="mt-1 shrink-0 rounded-full border p-2">
                    <Bot className="h-4 w-4" />
                </div>

                <div className="max-w-[85%] rounded-2xl border px-4 py-3 bg-card mr-10">
                    <div className="flex items-center gap-1 h-5">
                        <span className="w-2 h-2 rounded-full bg-muted-foreground/70 animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-2 h-2 rounded-full bg-muted-foreground/70 animate-bounce" style={{ animationDelay: "150ms" }} />
                        <span className="w-2 h-2 rounded-full bg-muted-foreground/70 animate-bounce" style={{ animationDelay: "300ms" }} />
                    </div>
                </div>
            </div>
        </div>
    );
}
