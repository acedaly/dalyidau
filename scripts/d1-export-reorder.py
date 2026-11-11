#!/usr/bin/env python3
"""Reorders a `wrangler d1 export` file so it restores cleanly: every CREATE TABLE first, then the rows,
then indexes, triggers and anything else, each group in its original order.

D1 exports tables alphabetically with each table's rows right after it, so a child table's rows (for example
homepage_about_paragraphs) can come before the parent table they reference, and D1 refuses them on import
whatever the foreign-key pragmas say. Nothing is added, dropped or changed: only the order.

    python3 -I scripts/d1-export-reorder.py backups/payload-production-….sql > /tmp/restore.sql
"""
import sqlite3
import sys

statements, buffer = [], ""
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        buffer += line
        if sqlite3.complete_statement(buffer):
            statements.append(buffer)
            buffer = ""
if buffer.strip():
    statements.append(buffer)

def kind(s: str) -> int:
    head = s.lstrip().upper()
    if head.startswith("PRAGMA"):
        return 0
    if head.startswith("CREATE TABLE"):
        return 1
    if head.startswith("INSERT"):
        return 2
    return 3

ordered = sorted(statements, key=kind)  # sorted() is stable: original order kept within each group
sys.stdout.write("".join(ordered))
print(f"-- reordered {len(statements)} statements", file=sys.stderr)
