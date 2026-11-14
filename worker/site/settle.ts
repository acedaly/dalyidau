// The two small loops every copy from Payload to the site goes through (poc/payload/src/site/publishing.ts).
// They live here, free of Payload, so they can be tested on their own (test/site-settle.test.ts).

/** A document that changed under every attempt to make the site match it. */
export class Unsettled extends Error {
    constructor() {
        super("The document kept changing while the website was being updated.");
    }
}

/**
 * Makes the site match a document, and makes sure it still does when it's done. Two syncs of one document
 * can overlap (a save and Republish, or two saves): each reads the document, then writes what it read, and
 * the one that read the older version can be the one that writes last. So after writing, the document is
 * read again; if it changed meanwhile (a newer save, an unpublish, a move to Trash) the sync runs again from
 * what it is now. Whoever wrote something stale is therefore the one who puts it right, and a sync can never
 * leave the site on an older version than Payload, or put back something that was unpublished meanwhile.
 * `read(true)` is the read made to check; a document that never holds still is reported (Unsettled), never
 * passed over.
 */
export async function settle<D>(
    read: (verifying: boolean) => Promise<D>,
    apply: (doc: D) => Promise<void>,
    same: (a: D, b: D) => boolean,
    rounds = 4,
): Promise<void> {
    let doc = await read(false);
    for (let round = 0; round < rounds; round++) {
        await apply(doc);
        const now = await read(true);
        if (same(doc, now)) return;
        doc = now;
    }
    throw new Unsettled();
}

/** Every attempt failed. `cause` is the last failure. */
export class GaveUp extends Error {
    constructor(public readonly last: unknown) {
        super(String((last as Error)?.message ?? last));
    }
}

/**
 * Runs `work` up to `attempts` times. A failure `isFinal` says is the caller's to see (a refusal) is thrown
 * at once, as it is. After any other failure `onRetry` is told: the attempt may still have been written (the
 * answer was lost, not the write), so a caller that acts on "did this change anything?" must assume it did.
 */
export async function retried<T>(
    work: () => Promise<T>,
    options: { attempts?: number; isFinal?: (error: unknown) => boolean; onRetry?: () => void; wait?: (attempt: number) => Promise<void> } = {},
): Promise<T> {
    const attempts = options.attempts ?? 3;
    const wait = options.wait ?? ((attempt: number) => new Promise<void>((resolve) => setTimeout(resolve, 150 * 4 ** attempt)));
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await work();
        } catch (error) {
            if (options.isFinal?.(error)) throw error;
            last = error;
            options.onRetry?.();
            if (attempt < attempts - 1) await wait(attempt);
        }
    }
    throw new GaveUp(last);
}
