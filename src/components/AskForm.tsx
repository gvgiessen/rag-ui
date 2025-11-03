"use client";

import { useState, useRef, Fragment } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { Loader2, SendHorizonal, FileText } from "lucide-react";
import { toast } from "sonner";
import ReactMarkdown from "react-markdown";

type Source = { source_name: string; score?: number; preview?: string };

type Msg = {
    id: string;
    question: string;
    answer: string;
    sources?: Source[];
};

/** Regex die inline verwijzingen vangt zoals [Bestandsnaam.pdf] of [.docx/.pptx/.txt/.md/.csv] */
const INLINE_SRC_RE = /\[([^\]\n]+?\.(?:pdf|docx|pptx|txt|md|csv))\]/gi;

/** Kleine pil met HoverCard die de bron toont */
function SourcePill({ label, score, preview }: { label: string; score?: number; preview?: string }) {
    return (
        <HoverCard openDelay={120} closeDelay={80}>
            <HoverCardTrigger asChild>
                <Badge variant="secondary" className="rounded-full cursor-default select-none align-baseline mx-1">
                    Bron
                </Badge>
            </HoverCardTrigger>
            <HoverCardContent className="w-80" align="start" side="top">
                <div className="space-y-2">
                    <div className="flex items-start gap-2">
                        <FileText className="h-4 w-4 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <div className="text-sm font-medium break-words">{label}</div>
                            {typeof score === "number" && (
                                <div className="text-xs text-muted-foreground">score: {score.toFixed(3)}</div>
                            )}
                        </div>
                    </div>
                    {!!preview?.trim() && (
                        <div className="text-sm text-muted-foreground max-h-40 overflow-y-auto whitespace-pre-wrap">
                            {preview}
                        </div>
                    )}
                </div>
            </HoverCardContent>
        </HoverCard>
    );
}

/**
 * Rendert markdown met inline Bron-pillen op elke [Bestandsnaam.ext].
 * We matchen een bron object uit `sources` op exacte naam (case-insensitive),
 * vallen anders terug op alleen de bestandsnaam.
 */
function renderWithInlineSources(md: string, sources?: Source[]) {
    if (!md) return null;

    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    const text = String(md);

    while ((match = INLINE_SRC_RE.exec(text)) !== null) {
        const matchStart = match.index;
        const matchEnd = INLINE_SRC_RE.lastIndex;
        const fileName = match[1]; // binnen de brackets

        // 1) voeg tekst vóór de match toe (als markdown)
        const before = text.slice(lastIndex, matchStart);
        if (before) {
            parts.push(
                <ReactMarkdown key={`md-${lastIndex}-${matchStart}`}>{before}</ReactMarkdown>
            );
        }

        // 2) zoek bijpassende bron (case-insensitive exact)
        const src =
            sources?.find(
                (s) => s.source_name?.toLowerCase() === fileName.toLowerCase()
            ) ?? undefined;

        // 3) voeg inline pil toe
        parts.push(
            <SourcePill
                key={`pill-${matchStart}-${matchEnd}`}
                label={src?.source_name ?? fileName}
                score={src?.score}
                preview={src?.preview}
            />
        );

        lastIndex = matchEnd;
    }

    // 4) resterende tekst na laatste match
    const tail = text.slice(lastIndex);
    if (tail) {
        parts.push(<ReactMarkdown key={`md-tail-${lastIndex}`}>{tail}</ReactMarkdown>);
    }

    // ReactMarkdown maakt blokken; we wikkelen in Fragment om inline/flow netjes te houden
    return <Fragment>{parts}</Fragment>;
}

export default function AskForm() {
    const [q, setQ] = useState("");
    const [loading, setLoading] = useState(false);
    const [msgs, setMsgs] = useState<Msg[]>([]);
    const taRef = useRef<HTMLTextAreaElement | null>(null);

    async function ask() {
        const question = q.trim();
        if (!question) return;

        setLoading(true);
        try {
            const res = await fetch("/api/ask", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ question }),
            });

            const json = await res.json();
            if (!json.ok) {
                toast.error(json.error ?? "Vraag mislukt");
                return;
            }

            let answer = "";
            let sources: Msg["sources"] | undefined;

            if (json.mode === "json" && json.data) {
                // verwacht: { answer: string, hits: [{ source_name, score, text|preview }, ...] }
                answer = typeof json.data.answer === "string" ? json.data.answer : JSON.stringify(json.data, null, 2);

                if (Array.isArray(json.data.hits)) {
                    sources = json.data.hits.map((h: any) => ({
                        source_name: h.source_name,
                        score: typeof h.score === "number" ? h.score : undefined,
                        preview:
                            typeof h.preview === "string"
                                ? h.preview
                                : typeof h.text === "string"
                                    ? h.text
                                    : undefined,
                    }));
                }
            } else {
                // plain text
                answer = typeof json.data === "string" ? json.data : String(json.data);
            }

            setMsgs((prev) => [
                { id: crypto.randomUUID(), question, answer, sources },
                ...prev,
            ]);

            setQ("");
            taRef.current?.focus();
        } catch (e: any) {
            toast.error(e?.message ?? "Onbekende fout");
        } finally {
            setLoading(false);
        }
    }

    return (
        <div className="max-w-3xl mx-auto space-y-6">
            <Card className="border rounded-2xl">
                <CardHeader>
                    <CardTitle>Ask your documents</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                    <Textarea
                        ref={taRef}
                        value={q}
                        onChange={(e) => setQ(e.target.value)}
                        placeholder="Stel je vraag…"
                        className="min-h-[100px] resize-y"
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                                e.preventDefault();
                                ask();
                            }
                        }}
                    />
                    <div className="flex items-center gap-2">
                        <Button onClick={ask} disabled={loading || !q.trim()} className="rounded-2xl px-4">
                            {loading ? <Loader2 className="animate-spin mr-2 h-4 w-4" /> : <SendHorizonal className="mr-2 h-4 w-4" />}
                            Ask
                        </Button>
                        <span className="text-xs text-muted-foreground">Tip: Ctrl/Cmd+Enter to submit</span>
                    </div>
                </CardContent>
            </Card>

            {msgs.map((m) => (
                <Card key={m.id} className="border rounded-2xl">
                    <CardHeader>
                        <CardTitle className="text-base">Vraag</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        <div className="whitespace-pre-wrap">{m.question}</div>
                        <Separator />

                        {/* INLINE bronpillen op de plekken van [Bestandsnaam.ext] */}
                        <div className="prose prose-sm max-w-none dark:prose-invert">
                            {renderWithInlineSources(m.answer, m.sources)}
                        </div>

                        {/* Optioneel: extra totaaloverzicht van bronnen onderaan (laat staan of verwijder naar smaak) */}
                        {m.sources && m.sources.length > 0 && (
                            <>
                                <Separator />
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-sm text-muted-foreground">Alle bronnen:</span>
                                    {m.sources.map((s, i) => (
                                        <Badge key={`${s.source_name}-${i}`} variant="outline" className="rounded-full">
                                            {s.source_name}
                                        </Badge>
                                    ))}
                                </div>
                            </>
                        )}
                    </CardContent>
                </Card>
            ))}
        </div>
    );
}
