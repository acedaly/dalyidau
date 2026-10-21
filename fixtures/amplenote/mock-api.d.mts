export declare const NOTE_IDS: { garden: string; draft: string; private: string; second: string };

export interface MockNote {
    uuid: string;
    name: string;
    tags: string[];
    public: boolean;
    deleted: boolean;
    token: string | null;
    created: string;
    updated: string;
    markdown: string;
}

export declare const fixtureNotes: (imageBase: string) => MockNote[];
export declare const secondNote: MockNote;

export interface MockApp {
    settings: Record<string, string>;
    alerts: string[];
    alert(message: string): Promise<void>;
    filterNotes(filter: { tag: string }): Promise<Record<string, unknown>[]>;
    getNotePublicURL(handle: { uuid: string }): Promise<string | null>;
    getNoteContent(handle: { uuid: string }): Promise<string>;
}

export declare function createAmplenoteMock(options?: { apiBase?: string; loginBase?: string; publicBase?: string; imageBase?: string }): {
    handle(request: Request): Promise<Response>;
    app(settings: Record<string, string>): MockApp;
    control: {
        reset(): void;
        note(uuid: string): MockNote | undefined;
        add(note: MockNote): void;
        edit(uuid: string, changes: Partial<MockNote>): void;
        unpublish(uuid: string): void;
        failListing(times?: number): void;
        failToken(times?: number): void;
        linksDown(down?: boolean): void;
        expireAccess(): void;
        revokeRefresh(): void;
        rotateRefresh(on?: boolean): void;
        refreshesUsed(): string[];
        calls(): string[];
    };
};
