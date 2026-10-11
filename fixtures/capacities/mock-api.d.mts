export declare const createMockApi: (options: { baseUrl: string; token?: string; readFile: (name: string) => Promise<Uint8Array | null> }) => {
    handle: (request: Request) => Promise<Response>;
    control: {
        state: { requests: string[]; objects: Map<string, any>; fail: Set<string> };
        reset(): void;
        setStatus(id: string, name: string | null): void;
        setTitle(id: string, title: string): void;
        setSlug(id: string, slug: string): void;
        appendParagraph(id: string, text: string): void;
        remove(id: string): void;
        fail(mode: string): void;
        recover(): void;
        structureId: string;
    };
};
