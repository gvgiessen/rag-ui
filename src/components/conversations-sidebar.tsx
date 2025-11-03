// components/conversations-sidebar.tsx
"use client";

import * as React from "react";
import {
    Sidebar,
    SidebarContent,
    SidebarHeader,
    SidebarFooter,
    SidebarGroup,
    SidebarGroupLabel,
    SidebarGroupContent,
    SidebarMenu,
    SidebarMenuItem,
    SidebarMenuButton,
    SidebarRail,
    SidebarTrigger,
} from "@/components/ui/sidebar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
    MoreVertical,
    Plus,
    Search,
    Pencil,
    Trash2,
    Check,
    X,
    MessageSquareText,
} from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type Conversation = {
    id: string;
    title: string;
    updatedAt: number; // epoch ms
};

type Props = {
    activeId: string | null;
    onSelect: (id: string) => void;
};

const STORAGE_KEY = "ragui.conversations.v1";

function loadConversations(): Conversation[] {
    if (typeof window === "undefined") return [];
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return seed();
        const parsed = JSON.parse(raw) as Conversation[];
        return Array.isArray(parsed) ? parsed : seed();
    } catch {
        return seed();
    }
}

function saveConversations(list: Conversation[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
    } catch {
        // ignore
    }
}

// eerste seed zodat het er niet “leeg” uitziet
function seed(): Conversation[] {
    const now = Date.now();
    const seeded = [
        { id: crypto.randomUUID(), title: "Afstudeer-oe-codes", updatedAt: now - 1000 * 60 * 60 * 26 },
        { id: crypto.randomUUID(), title: "DNS www fix", updatedAt: now - 1000 * 60 * 60 * 5 },
        { id: crypto.randomUUID(), title: "Next.js + UI", updatedAt: now - 1000 * 60 * 40 },
    ];
    saveConversations(seeded);
    return seeded;
}

function formatRelative(ts: number) {
    const diff = Date.now() - ts;
    const m = Math.floor(diff / 60000);
    if (m < 1) return "zojuist";
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} u`;
    const d = Math.floor(h / 24);
    return `${d} d`;
}

export function ConversationsSidebar({ activeId, onSelect }: Props) {
    const [items, setItems] = React.useState<Conversation[]>([]);
    const [filter, setFilter] = React.useState("");
    const [editingId, setEditingId] = React.useState<string | null>(null);
    const [editingTitle, setEditingTitle] = React.useState("");

    React.useEffect(() => {
        setItems(loadConversations());
    }, []);

    React.useEffect(() => {
        saveConversations(items);
    }, [items]);

    const filtered = React.useMemo(() => {
        const q = filter.trim().toLowerCase();
        const list = q
            ? items.filter((it) => it.title.toLowerCase().includes(q))
            : items;
        // sort: recent eerst
        return [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    }, [items, filter]);

    function createNew() {
        const id = crypto.randomUUID();
        const newConv: Conversation = {
            id,
            title: "Nieuw gesprek",
            updatedAt: Date.now(),
        };
        setItems((prev) => [newConv, ...prev]);
        setEditingId(id);
        setEditingTitle(newConv.title);
        onSelect(id);
    }

    function startRename(id: string, current: string) {
        setEditingId(id);
        setEditingTitle(current);
    }

    function confirmRename() {
        if (!editingId) return;
        const title = editingTitle.trim() || "Naamloos";
        setItems((prev) => prev.map((it) => (it.id === editingId ? { ...it, title, updatedAt: Date.now() } : it)));
        setEditingId(null);
        setEditingTitle("");
    }

    function cancelRename() {
        setEditingId(null);
        setEditingTitle("");
    }

    function remove(id: string) {
        setItems((prev) => prev.filter((it) => it.id !== id));
        if (activeId === id) {
            // Kies volgende beste gesprek
            const next = filtered.find((it) => it.id !== id) ?? items.find((it) => it.id !== id) ?? null;
            onSelect(next ? next.id : "");
        }
    }

    function select(id: string) {
        // bump updatedAt zodat het naar boven schuift (optioneel)
        setItems((prev) => prev.map((it) => (it.id === id ? { ...it, updatedAt: Date.now() } : it)));
        onSelect(id);
    }

    return (
        <Sidebar collapsible="icon">
            <SidebarHeader className="px-3">
                <div className="flex items-center gap-2">
                    <SidebarTrigger className="md:hidden" />
                    <h1 className="text-base font-semibold">Gesprekken</h1>
                </div>
                <div className="mt-2 flex items-center gap-2">
                    <div className="relative flex-1">
                        <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                        <Input
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            placeholder="Zoeken…"
                            className="pl-8"
                        />
                    </div>
                    <Button variant="default" size="icon" onClick={createNew} title="Nieuw gesprek">
                        <Plus className="h-4 w-4" />
                    </Button>
                </div>
            </SidebarHeader>

            <SidebarContent>
                <SidebarGroup>
                    <SidebarGroupLabel>Recent</SidebarGroupLabel>
                    <SidebarGroupContent>
                        <ScrollArea className="h-[calc(100dvh-220px)] pr-2">
                            <SidebarMenu>
                                {filtered.map((c) => {
                                    const isActive = c.id === activeId;
                                    return (
                                        <SidebarMenuItem key={c.id}>
                                            <div
                                                className={[
                                                    "flex items-center gap-2 rounded-md px-2 py-2 border",
                                                    isActive ? "bg-accent" : "hover:bg-muted/50",
                                                ].join(" ")}
                                            >
                                                <MessageSquareText className="h-4 w-4 shrink-0" />
                                                {editingId === c.id ? (
                                                    <div className="flex items-center gap-2 w-full">
                                                        <Input
                                                            autoFocus
                                                            value={editingTitle}
                                                            onChange={(e) => setEditingTitle(e.target.value)}
                                                            onKeyDown={(e) => {
                                                                if (e.key === "Enter") confirmRename();
                                                                if (e.key === "Escape") cancelRename();
                                                            }}
                                                            className="h-8"
                                                        />
                                                        <Button size="icon" variant="ghost" onClick={confirmRename} title="Opslaan">
                                                            <Check className="h-4 w-4" />
                                                        </Button>
                                                        <Button size="icon" variant="ghost" onClick={cancelRename} title="Annuleren">
                                                            <X className="h-4 w-4" />
                                                        </Button>
                                                    </div>
                                                ) : (
                                                    <>
                                                        <SidebarMenuButton
                                                            isActive={isActive}
                                                            onClick={() => select(c.id)}
                                                            className="flex-1 justify-start"
                                                            tooltip={c.title}
                                                        >
                                                            <div className="truncate text-sm">{c.title}</div>
                                                        </SidebarMenuButton>
                                                        <div className="text-xs text-muted-foreground shrink-0">{formatRelative(c.updatedAt)}</div>
                                                        <DropdownMenu>
                                                            <DropdownMenuTrigger asChild>
                                                                <Button size="icon" variant="ghost">
                                                                    <MoreVertical className="h-4 w-4" />
                                                                </Button>
                                                            </DropdownMenuTrigger>
                                                            <DropdownMenuContent align="end" className="w-40">
                                                                <DropdownMenuItem onClick={() => startRename(c.id, c.title)}>
                                                                    <Pencil className="h-4 w-4 mr-2" /> Hernoemen
                                                                </DropdownMenuItem>
                                                                <DropdownMenuItem
                                                                    className="text-destructive focus:text-destructive"
                                                                    onClick={() => remove(c.id)}
                                                                >
                                                                    <Trash2 className="h-4 w-4 mr-2" /> Verwijderen
                                                                </DropdownMenuItem>
                                                            </DropdownMenuContent>
                                                        </DropdownMenu>
                                                    </>
                                                )}
                                            </div>
                                        </SidebarMenuItem>
                                    );
                                })}
                            </SidebarMenu>
                        </ScrollArea>
                    </SidebarGroupContent>
                </SidebarGroup>
            </SidebarContent>

            <SidebarFooter className="px-3">
                <Separator />
                <div className="text-xs text-muted-foreground py-2">
                    {filtered.length} gesprek{filtered.length === 1 ? "" : "ken"}
                </div>
            </SidebarFooter>
            <SidebarRail />
        </Sidebar>
    );
}
