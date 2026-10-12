# Privacy and personal data

The wedding portal holds personal details about our guests. This page says what we keep, why, for how long, who can see it, and how to remove it.

## What we collect and why

| Data                                                                         | Where                  | Why                                                                 |
| ---------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------- |
| Names, household, side, group, age group (adult/child/infant), plus-one flag | `guests`, `households` | To know who's invited and plan numbers                              |
| Email, phone                                                                 | `guests`, `households` | To send invitations and updates, and contact people if plans change |
| Postal address                                                               | `households`           | For paper invitations                                               |
| RSVP per event, when and how it was given                                    | `guest_events`         | To plan the day                                                     |
| Dietary and accessibility needs, notes, custom fields                        | `guests`               | Catering and making the day work for everyone                       |
| Online RSVP submissions (answers, optional message, optional email)          | `rsvp_submissions`     | A record of exactly what each household told us                     |
| Configurable RSVP answers and the question wording/version used              | `rsvp_answers`         | Preserve and report answers even when a question is edited later    |
| Who was sent which message                                                   | `message_recipients`   | Delivery history and to avoid double-sending                        |
| Portal users' emails, roles, last-seen time                                  | `portal_users`         | Access control                                                      |
| Change history (who did what, when)                                          | `audit_log`            | Accountability between the two of us and anyone we add              |
| Hashed client identifiers with counters                                      | `rate_limits`          | Stopping RSVP-code guessing. No IP addresses are stored.            |

Cloudflare hosts the application data in D1 and photos in R2. If Cloudflare Email Service is approved and switched on later, it receives each recipient's name, address and rendered message. Email delivery is currently disabled and no provider binding is configured.

## Who can see it

- **Cloudflare Access** decides who can sign in; the **role** decides what they can do (see [PORTAL.md](PORTAL.md#roles)).
- Viewers and editors can see guests (including dietary notes). Only owners and admins can export, see the budget, or change settings. Only owners can erase.
- The public website never shows guest details. The RSVP form shows a household only its own members after a valid signed invitation is presented (or an enabled legacy code is entered). Unknown, expired and revoked invitations are deliberately indistinguishable.

## How the audit log treats personal data

The audit log records **that** a sensitive field changed and **who** changed it, but not the old or new value. Sensitive fields: email, phone, dietary, accessibility, notes, custom fields, address lines, contact names. Their values live only in the record itself. Online RSVP entries in the log keep who answered what, but not dietary notes.

Deleting a record keeps no copy of its personal details in the log, only its name until it's erased.

Who-did-what-when can't be rewritten: a database trigger refuses any change to an entry's time, actor or action.

## Deleting and erasing

There are two steps, on purpose.

1. **Delete** (anyone who can edit guests). The guest or household disappears from lists, counts, exports, messages and the RSVP form; a deleted household's RSVP code stops working. It's kept in **Portal settings → Privacy → Deleted records** and can be restored.
2. **Erase** (owners only, from the same list). Removes the record for good, and scrubs it from:
    - **message history**: the recipient row stays (so counts still add up) but becomes "[erased]" with no email;
    - **stored RSVP submissions and custom answers**: the guest's part of each submission and their answer rows are removed (a household's submissions and answer rows are removed with the household);
    - **the audit log**: entries about the record lose their details, and its name, email, phone and RSVP code are replaced with "[erased]" wherever they appear.

    You must type the record's name to confirm. The audit log keeps a line saying an owner erased a record, and when, but not whose.

Erasing a household keeps its guests (unlinked from the household). Erase the guests separately if needed.

## Retention

Portal settings → Privacy → Retention (owners):

| Setting                     | Default  | Effect when retention is applied                                                                         |
| --------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| Keep audit entries for      | 730 days | Older entries are removed. Records of erasures and retention runs are always kept. `0` keeps everything. |
| Erase deleted records after | 90 days  | Deleted guests and households older than this are erased, as above.                                      |

**Nothing is removed automatically.** An owner presses "Apply retention", sees how many entries and records it will affect, and types `APPLY RETENTION` to confirm. A sensible rhythm: apply it a few months after the wedding, once thank-you notes are done, and decide then whether to erase the whole guest list.

## Places the portal can't reach

Erasing in the portal can't remove copies that already exist elsewhere:

- **Downloaded CSV files** (exports, mail-merge files). Every export is recorded in the audit log with who took it. Delete the files when you're done with them.
- **Downloaded full JSON exports**. These contain the portal's database records (but not R2 photo binaries) and are audited like CSV exports.
- **Database backups** made with `npm run db:backup` (in `backups/`, git-ignored). Delete old backup files once they're no longer needed; don't keep them longer than the retention period.
- **D1 Time Travel**: Cloudflare can restore the database to any point in the last 30 days. Erased data therefore remains recoverable by the account owner for up to 30 days, then is gone.
- **Worker logs** (Workers Logs) record request paths and error messages, not guest details.
- **Email providers**, once delivery is enabled, keep their own sending logs per their retention policy.

## A request to see or remove someone's details

1. Find them in Guests (search by name or email).
2. **To see** what we hold: open their record (all tabs), or export guests and send them their row.
3. **To remove**: delete them, then erase them from Portal settings → Privacy. Delete any exported files or backups that contain them, or note that backups expire.
