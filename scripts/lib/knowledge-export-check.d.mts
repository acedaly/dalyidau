// Types for knowledge-export-check.mjs, which the tests import.
import type { KnowledgeExport } from "../../src/shared/knowledge/export";

export interface ZipEntryRead {
    name: string;
    data: Uint8Array;
    text(): string;
}
export const EXPORT_FORMAT: string;
export function isSafeEntryName(name: string): boolean;
export function readZip(bytes: Uint8Array | ArrayBuffer): ZipEntryRead[];
export function checkManifest(manifest: unknown): string[];
export function checkZip(bytes: Uint8Array | ArrayBuffer): { problems: string[]; manifest: KnowledgeExport | null; entries: ZipEntryRead[] };
export function summarise(manifest: KnowledgeExport): Record<string, string | number | undefined>;
