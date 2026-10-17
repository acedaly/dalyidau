// How an invitation is addressed. One set of rules for printed invitations, Studio previews, email
// invitations, Communications merge fields and the RSVP page, so a household reads the same way
// everywhere: "Fred & Ann Daly", "Fred Daly & Kate Smith", or a name the couple chose.

export interface InvitationPerson {
    firstName: string;
    lastName: string;
}

export interface InvitationAddressingOptions {
    /** The household's own invitation name, e.g. "The Daly Family". Blank uses the invited guests' names. */
    invitationName?: string | null;
    /** With an invitation name, also list the invited people beneath it. */
    listNames?: boolean;
}

export interface InvitationAddressing {
    /** The single line the invitation is addressed to. */
    recipientLine: string;
    /** The invited people, listed beneath a custom invitation name when asked for; otherwise null. */
    namesLine: string | null;
    /** Names for a salutation such as "Dear Fred & Ann". */
    greetingNames: string;
}

const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

/** "Fred", "Fred & Ann", "Fred, Ann & Tom". */
export const joinNames = (names: string[], conjunction = "&") =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ${conjunction} ${names[names.length - 1]}`;

/**
 * People who share a surname are written together, in the order they first appear:
 * "Fred & Ann Daly", "Fred, Ann & Tom Daly", "Fred Daly & Kate Smith",
 * "Fred & Ann Daly and Kate Smith". Surnames are compared without regard to case.
 */
export function formatInvitees(people: InvitationPerson[]): string {
    const groups: { key: string; surname: string; firstNames: string[] }[] = [];
    for (const person of people) {
        const first = clean(person.firstName);
        const last = clean(person.lastName);
        if (!first && !last) continue;
        const key = last.toLocaleLowerCase("en-AU");
        const group = groups.find((item) => item.key === key);
        // A person with only a surname is written in full on their own.
        if (!first) groups.push({ key: `${key}\u0000${groups.length}`, surname: last, firstNames: [] });
        else if (group) {
            group.firstNames.push(first);
            // "Oak leaf" and "Pip Leaf" are one family: prefer the capitalised spelling.
            if (/^\p{Ll}/u.test(group.surname) && /^\p{Lu}/u.test(last)) group.surname = last;
        } else groups.push({ key, surname: last, firstNames: [first] });
    }
    const parts = groups.map((group) => [joinNames(group.firstNames), group.surname].filter(Boolean).join(" "));
    // "&" joins names inside a group, so when any group already has one, groups are joined with "and"
    // to keep "Fred & Ann Daly and Kate Smith" unambiguous.
    const nested = groups.some((group) => group.firstNames.length > 1);
    return joinNames(parts, nested ? "and" : "&");
}

/**
 * First names for a salutation: "Fred & Ann", "Fred, Ann & Tom". People who share a first name are
 * greeted by full name so nobody reads as a repeat ("Sam Lee & Sam Smith"), and someone with only a
 * surname is greeted by it.
 */
export const formatGreetingNames = (people: InvitationPerson[]) => {
    const named = people.map((person) => ({ first: clean(person.firstName), last: clean(person.lastName) })).filter((person) => person.first || person.last);
    const count = (first: string) => named.filter((person) => person.first.toLocaleLowerCase("en-AU") === first.toLocaleLowerCase("en-AU")).length;
    return joinNames(
        named.map((person) => (!person.first ? person.last : count(person.first) > 1 ? [person.first, person.last].filter(Boolean).join(" ") : person.first)),
    );
};

/**
 * Addresses one invitation to the given people (the invited members of a household, or one person
 * for an individual invitation). A custom invitation name replaces the recipient line; the people
 * are then listed beneath it only when `listNames` is set.
 */
export function invitationAddressing(people: InvitationPerson[], options: InvitationAddressingOptions = {}, fallback = ""): InvitationAddressing {
    const custom = clean(options.invitationName);
    const names = formatInvitees(people);
    if (custom)
        return {
            recipientLine: custom,
            namesLine: options.listNames && names ? names : null,
            // The card is addressed to "The Daly Family", but the greeting is to the people invited,
            // by first name: "Dear Fred, Ann & Tom" reads warmly where "Dear the Daly Family" doesn't.
            // With nobody named, the invitation name stands in ("Dear the Daly Family").
            greetingNames: formatGreetingNames(people) || custom.replace(/^The\s/, "the "),
        };
    return { recipientLine: names || clean(fallback), namesLine: null, greetingNames: formatGreetingNames(people) || clean(fallback) };
}

/** "Dear Fred & Ann". An empty prefix leaves just the names. */
export const salutation = (prefix: string, greetingNames: string) => [clean(prefix), greetingNames].filter(Boolean).join(" ");
