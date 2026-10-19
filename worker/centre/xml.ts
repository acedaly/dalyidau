// A small, safe XML reader for public feeds (RSS, GeoRSS, EDXL/CAP, BoM product XML).
//
// It refuses what makes XML dangerous rather than trying to handle it: any DOCTYPE or ENTITY
// declaration is rejected outright (no external entities, no entity expansion, no "billion
// laughs"); only the five predefined entities and numeric character references are decoded; depth,
// element count and size are bounded; processing instructions and comments are skipped. Nothing in
// a feed is ever executed or rendered as markup: text comes out as plain strings.

export interface XmlElement {
    /** Local name, without any namespace prefix. */
    name: string;
    /** Name as written, with prefix. */
    qname: string;
    attrs: Record<string, string>;
    children: XmlElement[];
    text: string;
}

export class XmlError extends Error {}

export interface XmlLimits {
    maxBytes: number;
    maxDepth: number;
    maxElements: number;
}

const DEFAULT_LIMITS: XmlLimits = { maxBytes: 4_000_000, maxDepth: 40, maxElements: 200_000 };
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, ref: string) => {
        if (ref[0] === "#") {
            const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
            if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "";
            return String.fromCodePoint(code);
        }
        return ENTITIES[ref] ?? whole;
    });
}

const localName = (qname: string) => qname.slice(qname.indexOf(":") + 1);

export function parseXml(input: string, limits: Partial<XmlLimits> = {}): XmlElement {
    const { maxBytes, maxDepth, maxElements } = { ...DEFAULT_LIMITS, ...limits };
    if (input.length > maxBytes) throw new XmlError("The document is too large");
    if (/<!DOCTYPE|<!ENTITY/i.test(input)) throw new XmlError("Documents with DOCTYPE or ENTITY declarations are refused");
    const root: XmlElement = { name: "#document", qname: "#document", attrs: {}, children: [], text: "" };
    const stack: XmlElement[] = [root];
    let count = 0;
    let i = 0;
    const n = input.length;
    while (i < n) {
        const lt = input.indexOf("<", i);
        const textEnd = lt < 0 ? n : lt;
        if (textEnd > i) {
            const raw = input.slice(i, textEnd);
            if (raw.trim()) stack[stack.length - 1].text += decodeEntities(raw);
        }
        if (lt < 0) break;
        if (input.startsWith("<!--", lt)) {
            const end = input.indexOf("-->", lt + 4);
            if (end < 0) throw new XmlError("Unterminated comment");
            i = end + 3;
            continue;
        }
        if (input.startsWith("<![CDATA[", lt)) {
            const end = input.indexOf("]]>", lt + 9);
            if (end < 0) throw new XmlError("Unterminated CDATA");
            stack[stack.length - 1].text += input.slice(lt + 9, end);
            i = end + 3;
            continue;
        }
        if (input.startsWith("<?", lt)) {
            const end = input.indexOf("?>", lt + 2);
            if (end < 0) throw new XmlError("Unterminated processing instruction");
            i = end + 2;
            continue;
        }
        if (input.startsWith("<!", lt)) throw new XmlError("Declarations are refused");
        const gt = findTagEnd(input, lt + 1);
        if (gt < 0) throw new XmlError("Unterminated tag");
        const body = input.slice(lt + 1, gt);
        i = gt + 1;
        if (body[0] === "/") {
            const qname = body.slice(1).trim();
            const open = stack.pop();
            if (!open || open === root || open.qname !== qname) throw new XmlError(`Mismatched closing tag </${qname.slice(0, 40)}>`);
            open.text = open.text.trim();
            continue;
        }
        const selfClosing = body.endsWith("/");
        const content = selfClosing ? body.slice(0, -1) : body;
        const nameMatch = /^([A-Za-z_][\w.:-]*)/.exec(content);
        if (!nameMatch) throw new XmlError("Malformed tag");
        if (++count > maxElements) throw new XmlError("Too many elements");
        const element: XmlElement = {
            name: localName(nameMatch[1]),
            qname: nameMatch[1],
            attrs: parseAttributes(content.slice(nameMatch[1].length)),
            children: [],
            text: "",
        };
        stack[stack.length - 1].children.push(element);
        if (!selfClosing) {
            stack.push(element);
            if (stack.length > maxDepth) throw new XmlError("The document is nested too deeply");
        }
    }
    if (stack.length !== 1) throw new XmlError("Unclosed elements");
    if (root.children.length !== 1) throw new XmlError("Expected one root element");
    return root.children[0];
}

/** The ">" ending a tag, skipping any inside quoted attribute values. */
function findTagEnd(input: string, from: number): number {
    let quote: string | null = null;
    for (let j = from; j < input.length; j++) {
        const c = input[j];
        if (quote) {
            if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === ">") return j;
        else if (c === "<") return -1;
    }
    return -1;
}

function parseAttributes(text: string): Record<string, string> {
    const attrs: Record<string, string> = {};
    const re = /([A-Za-z_][\w.:-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(text))) {
        if (++seen > 64) throw new XmlError("Too many attributes");
        attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? "");
    }
    return attrs;
}

// --- Navigation helpers ----------------------------------------------------------------------------

export const child = (el: XmlElement | undefined, name: string) => el?.children.find((c) => c.name === name);
export const children = (el: XmlElement | undefined, name: string) => el?.children.filter((c) => c.name === name) ?? [];
export const textOf = (el: XmlElement | undefined, name: string): string | null => {
    const found = child(el, name);
    const value = found?.text.trim();
    return value ? value : null;
};
/** Every descendant with this name, depth first. */
export function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
    for (const c of el.children) {
        if (c.name === name) out.push(c);
        descendants(c, name, out);
    }
    return out;
}

/** Strips any markup from feed text (e.g. "<br />" in RFS descriptions) and normalises whitespace. Never rendered as HTML. */
export const plainText = (value: string | null | undefined, max = 8000): string | null => {
    if (!value) return null;
    const text = decodeEntities(value.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n")
        .trim();
    return text ? text.slice(0, max) : null;
};
