import Chat from "@/components/Chat";
import { Toaster } from "sonner";

export default function Page() {
    return (
        <main className="min-h-screen">
            <Chat />
            <Toaster richColors />
        </main>
    );
}
