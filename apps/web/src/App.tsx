import { useEffect, useRef, useState } from 'react';
import { PromptInput, PromptInputTextarea } from '@/components/ui/prompt-input';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const API_BASE = 'http://localhost:3001';

type Message = {
    id: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    agentId?: string;
};

export default function App() {
    const [agents, setAgents] = useState<any[]>([]);
    const [selectedAgent, setSelectedAgent] = useState<string>('orchestrator');
    const [messages, setMessages] = useState<Message[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);

    // Fetch agents on mount
    useEffect(() => {
        fetch(`${API_BASE}/agents`)
            .then(res => res.json())
            .then(data => setAgents(data))
            .catch(console.error);
    }, []);

    // Fetch thread history when selectedAgent changes
    useEffect(() => {
        // Construct the threadId expected by backend: "default::selectedAgent<->user"
        // Note: from backend `createThreadId` sort order: [a, b].sort().join("<->")
        const idParts = ['user', selectedAgent].sort();
        const threadId = `default::${idParts.join('<->')}`;

        fetch(`${API_BASE}/thread?id=${encodeURIComponent(threadId)}`)
            .then(res => {
                if (!res.ok) throw new Error("Thread not found or error");
                return res.json();
            })
            .then(data => {
                if (Array.isArray(data)) {
                    const loadedMessages: Message[] = data.map(env => {
                        let text = '';
                        if (Array.isArray(env.message.content)) {
                            text = env.message.content
                                .filter((c: any) => c.type === 'text')
                                .map((c: any) => c.text)
                                .join('');
                        } else if (typeof env.message.content === 'string') {
                            text = env.message.content;
                        }

                        return {
                            id: env.envelopeId,
                            role: env.message.role,
                            content: text,
                            agentId: env.fromAgentId
                        };
                    });
                    setMessages(loadedMessages);
                } else {
                    setMessages([]);
                }
            })
            .catch(err => {
                console.error("Error fetching thread history", err);
                setMessages([]);
            });
    }, [selectedAgent]);

    // Set up SSE
    useEffect(() => {
        const eventSource = new EventSource(`${API_BASE}/events`);

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);

                // Only process messages relevant to the current agent thread
                // We check if the target agent matches our selectedAgent (from/to)
                const isRelevantThread = data.toAgentId === selectedAgent ||
                                         (data.fromAgentId === selectedAgent && data.toAgentId === 'user') ||
                                         (data.toAgentId === selectedAgent && data.fromAgentId === 'user') ||
                                         // Or orchestrator system messages about jobs related to this agent
                                         (data.fromAgentId === 'orchestrator' && data.toAgentId === selectedAgent);

                if (!isRelevantThread) return;

                // Simple parsing of envelope
                if (data.message && data.message.content) {
                    let text = '';
                    if (Array.isArray(data.message.content)) {
                        text = data.message.content
                            .filter((c: any) => c.type === 'text')
                            .map((c: any) => c.text)
                            .join('');
                    } else if (typeof data.message.content === 'string') {
                        text = data.message.content;
                    }

                    if (text) {
                        setMessages(prev => {
                            // Deduplicate by envelopeId to be safe
                            if (prev.find(m => m.id === data.envelopeId)) return prev;
                            return [...prev, {
                                id: data.envelopeId,
                                role: data.message.role,
                                content: text,
                                agentId: data.fromAgentId
                            }];
                        });
                    }
                }
            } catch (err) {
                console.error("SSE parse error", err);
            }
        };

        return () => {
            eventSource.close();
        };
    }, [selectedAgent]);

    useEffect(() => {
        // Scroll to bottom on new message
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [messages]);

    const handleSendMessage = async () => {
        if (!inputValue.trim()) return;

        const content = inputValue;
        setInputValue('');
        setIsLoading(true);

        try {
            await fetch(`${API_BASE}/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    toAgentId: selectedAgent,
                    content,
                })
            });
        } catch (err) {
            console.error("Failed to send message", err);
        } finally {
            setIsLoading(false);
        }
    };

    return (
        <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950 p-4 font-sans">
            <div className="max-w-4xl w-full mx-auto flex flex-col h-full gap-4">

                <header className="flex justify-between items-center bg-white dark:bg-zinc-900 p-4 rounded-xl border border-zinc-200 dark:border-zinc-800 shadow-sm">
                    <h1 className="text-xl font-bold">PI Agent Orchestrator</h1>
                    <div className="flex items-center gap-2">
                        <span className="text-sm text-zinc-500">Target Agent:</span>
                            <Select value={selectedAgent} onValueChange={(val: any) => setSelectedAgent(val as string)}>
                            <SelectTrigger className="w-[180px]">
                                <SelectValue placeholder="Select Agent" />
                            </SelectTrigger>
                            <SelectContent>
                                {agents.map(agent => (
                                    <SelectItem key={agent.id} value={agent.id}>
                                        {agent.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                </header>

                <Card className="flex-1 flex flex-col overflow-hidden shadow-sm">
                    <CardHeader className="py-3 px-4 border-b bg-zinc-50 dark:bg-zinc-900/50">
                        <CardTitle className="text-sm font-medium flex items-center gap-2 text-zinc-500">
                            Conversation Thread
                        </CardTitle>
                    </CardHeader>
                    <ScrollArea className="flex-1 p-4" ref={scrollRef}>
                        <div className="flex flex-col gap-4 pb-4">
                            {messages.length === 0 && (
                                <div className="text-center text-zinc-500 mt-10">
                                    No messages yet. Send a message to start the conversation!
                                </div>
                            )}
                            {messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : ''}`}
                                >
                                    <Avatar className="w-8 h-8 border">
                                        <AvatarFallback className={msg.role === 'user' ? 'bg-blue-100 text-blue-700' : 'bg-green-100 text-green-700'}>
                                            {msg.role === 'user' ? 'U' : msg.agentId?.charAt(0).toUpperCase() || 'A'}
                                        </AvatarFallback>
                                    </Avatar>
                                    <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'} max-w-[80%]`}>
                                        <span className="text-xs text-zinc-500 mb-1 px-1">
                                            {msg.role === 'user' ? 'You' : msg.agentId}
                                        </span>
                                        <div className={`p-3 rounded-2xl ${
                                            msg.role === 'user'
                                                ? 'bg-blue-600 text-white rounded-tr-sm'
                                                : msg.role === 'system'
                                                    ? 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 text-sm border'
                                                    : 'bg-white dark:bg-zinc-900 border text-zinc-900 dark:text-zinc-100 rounded-tl-sm shadow-sm'
                                        }`}>
                                            <p className="whitespace-pre-wrap leading-relaxed text-sm">
                                                {msg.content}
                                            </p>
                                        </div>
                                    </div>
                                </div>
                            ))}
                            {isLoading && (
                                <div className="flex gap-3">
                                    <Avatar className="w-8 h-8 border">
                                        <AvatarFallback className="bg-zinc-100 animate-pulse">...</AvatarFallback>
                                    </Avatar>
                                    <div className="p-3 bg-zinc-100 dark:bg-zinc-900 border rounded-2xl rounded-tl-sm animate-pulse text-zinc-400 text-sm">
                                        Thinking...
                                    </div>
                                </div>
                            )}
                        </div>
                    </ScrollArea>
                    <div className="p-4 bg-white dark:bg-zinc-950 border-t">
                        <PromptInput
                            value={inputValue}
                            onValueChange={setInputValue}
                            onSubmit={handleSendMessage}
                            isLoading={isLoading}
                            className="flex flex-col gap-2"
                        >
                            <PromptInputTextarea placeholder={`Message ${agents.find(a => a.id === selectedAgent)?.name || selectedAgent}...`} />
                        </PromptInput>
                    </div>
                </Card>
            </div>
        </div>
    );
}
