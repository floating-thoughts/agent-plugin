## 7. The company brain and ledger (off by default)

This section of the data note (DATA.md, in the same plugin folder) is kept in its own file. Nothing in it happens
until your company set the brain and ledger up and you typed `/agent-services brain setup` on this computer; it stops
after `brain leave`, after `logout`, or when the service says the company has it switched off. Lessons, brain items
and ledger entries are encrypted on this computer before they are sent; the service stores them and never decrypts
them, and holds no key that could. Every request goes the sealed way described in DATA.md section 1.

### What is sent, and when

| When | What is sent |
|---|---|
| `brain setup` by a company admin | a request for the company id; then, after you confirm the recovery sheet, this device's enrollment record (account id, device id, public encryption and signing keys, time, its own signature), the company's first roster and the brain's encrypted key-wrap |
| `brain setup <organisation code>` by a member | a request for the company's rosters (checked here against the code), then this device's enrollment record |
| Session start | a request for roster changes since the one this computer holds; for a brain member, the list of the brain's objects, the newest brain version and its key-wrap (all encrypted) |
| `task_state` op `lesson` graded E2 or E3, or op `decide` marked `share` (the field exists only while the brain is on) | one encrypted inbox item per lesson or decision: the text after masking and the scrub below, its grade or kind, a keyed project hash, a random id and the time, all inside the encryption; at most 20 a day and 700 characters each. A text that still matches the scrub after cleaning is blocked here and never sent |
| A ledger checkpoint: the main agent's turn end, every 50 ledger entries, or 15 minutes with new entries | one encrypted batch of the new ledger entries and a checkpoint signed by this device: company, account and device ids, the segment id, the first and last entry numbers, the head hash, the batch hash and the time |
| An admin's `brain members`, `approve`, `remove`, `distill`, `publish`, `recover` and `ledger export` | the signed new roster and new key-wraps (approve, remove, recover), requests for the waiting enrollments and the inbox items (distill), one encrypted brain version (publish), requests for receipts, checkpoints, rosters and batches of a period (export) |

The scrub, before anything is sealed: the secret masking of DATA.md section 4, then secrets, emails, phone numbers,
long number ids, home folder paths, private web addresses and IP addresses are replaced by placeholders such as
`[email]`; a text with a private key block, or one that still matches after that, is blocked.

What the service sees of it: the company id; random vault and object ids; each object's kind (key-wrap, brain,
config, inbox, ledger), key epoch, version, padded size (sizes are rounded up to fixed steps) and upload time; which
account and device key uploaded it; the roster in signed plain text (account ids, roles, device ids, public keys, vault
ids; vault names only encrypted); checkpoint hashes and entry numbers; the receipts it signs; and your IP address as
for every request. Never the text of a lesson, a brain item or a ledger entry, and never a key that could decrypt them.

Own storage: when every member typed `/agent-services brain storage own <folder> <company id>`, the encrypted
objects, rosters, waiting enrollments and ledger batches are written to that folder (for example a shared drive)
instead of the service, in the same format; the admin's computer tells the service only the setting itself. The
ledger then gets no server checkpoint or receipt, and the folder's permissions are the access control. The plugin
cannot lock the folder, so two computers writing the same item at the same moment can overwrite each other.

### What the service keeps, and for how long

| What | Kept by the service | How long |
|---|---|---|
| Encrypted objects (brain versions, key-wraps, inbox items, ledger batches), signed rosters, ledger checkpoints, the receipts the service signed, waiting enrollments, daily counters | yes; it cannot read the encrypted objects, and cannot recover them if every admin key and the recovery sheet are lost | brain versions: the newest 10 per item; inbox items, ledger batches, checkpoints and their receipts: 395 days (company settings: 1 to 3650 days, 1 to 1000 versions); rosters, key-wraps and roster receipts: while the company uses it; waiting enrollments until approved; daily counters 7 days |
| A kit made for your company (only if your company bought one): the encrypted hand-off, its kit id, version, part number, the hash it carries, which brain it was accepted into, and when it was sent, accepted and exported | yes; it cannot read the hand-off or the accepted kit | the encrypted hand-off until a company admin accepts it, at most 30 days after it was sealed (then it is deleted unread); once accepted, the kit is an encrypted brain version like any other (rows above); the row while the company is a customer; after the company leaves, one record per kit version with ids, hashes and dates only |

### A kit made for your company

Only if your company bought one. It is know-how written for your company alone. The service owner seals it on
the owner's own computer to your company admins' devices and your company's recovery key, and signs it; the service
stores it only in that sealed form and holds no key that opens it. At a company admin's session start (or when the
admin types the accept command) the admin's plugin fetches it, checks the signature, the company, the version and the
fields, opens it in memory and writes it into your company brain as a brain named `kit-<id>`, readable by every member
(an admin may narrow that like any brain); members' plugins then serve it like any company brain item. What is sent:
requests for the waiting kit parts, the encrypted kit part, and an acknowledgement with the kit id, version, part, the
brain's random id and a hash, never the kit's text. A device that cannot open it (a new admin, for example) answers
that it needs sealing again, and the owner seals it again to the newest roster. The service owner deletes the
owner's working copy once every part is accepted and keeps no copy afterwards.

When your company's license ends, members are no longer served. For 30 days after that, company admins can still read
the company brain and kits so that the export command writes them as plain files in a folder the admin chooses: per
kit or company brain a skill file (`SKILL.md`), the item file (`kit.json`) and one `MANIFEST.txt` with a hash per file.
Only your company's own kits and brain are in it, never the general or industry material the service provides; the
files are yours and stay readable without the plugin. The service is told only that a kit version was exported, with a
hash. After that (or after the 30 days without an export) the service owner deletes your company's encrypted brain,
ledger and kit rows, keeping only the record per kit version named in the table above.

When your account is erased, your inbox items and waiting enrollments go; what belongs to the company stays (brain
versions, key-wraps, ledger batches, rosters, checkpoints) with its uploader field set to `erased`, but a signed roster
or checkpoint still holds your random account id inside its signature (changing it would break the signature every
member checks). Deleting the company removes all of it. The database backups of DATA.md section 2 include these rows.

### What a company admin sees about you

**Admins and auditors (a role on the company's roster) can read your agents' ledger**: each refusal by the plugin's
rules (no command text), each side effect recorded with `task_state` (key, kind, state and the masked request), each
decision line and each delivery summary with its file list, all masked. Your own entries are also on your computer
(below). The admins and curators of a brain read the lessons you share before they review them; every member of a
brain reads what an admin published. A member who is removed keeps what they already saw; they cannot read what is
published after the removal.

### What stays on this computer

| Where | What |
|---|---|
| `~/.agent-services/sealed/identity.bin` (`identity-<company>.bin` for a second company) | only after `brain setup`: this device's key set for the company brain and ledger (encryption key, signing key, the key of the project hash), encrypted with a key that the system's key store protects for your user (Windows: DPAPI; macOS: the Keychain item `agent-services-sealed`, named in `<file>.who`); where neither works, that key is in the same file and the key set is in effect a plain file; an admin's setup says which one was used |
| Claude Code's plugin store | `sealed_state` (company, account, device, role, on or off, vault ids), `sealed_setup` (until setup is confirmed), the accepted roster and its pin (`sealed_roster`, `sealed_pin`), the newest brain version seen (`sealed_brain_pin`), `sealed_storage` (own folder), for a company admin the highest kit version accepted per kit part (so a replayed older one is refused), the ledger's last head and receipt (`ledger_head`, `ledger_receipt`), the day's count and ids of shared lessons (`brain_shared`), and `brain_round`, `brain_review` (a path) |
| `.agent/ledger/<segment>.jsonl` in a project (outside a project under `~/.agent-services/no-project/`) | the ledger entries of one session in plain text (the masked texts listed above), one file per session; only the copy sent at a checkpoint is encrypted |
| `~/.agent-services/brain-work/` | for an admin or curator: the decrypted inbox items of a `brain distill`, the draft Claude writes from them and the review file; plain text, written only by those commands and by you |
| `~/Documents/agent-services-recovery-<company>.txt` | the company's recovery key in plain text, written once by `brain setup`; print it or put it in a password manager, then delete the file. Anyone holding it can take over the company's brain and ledger |
| `~/Documents/agent-services-ledger-<from>-<to>.txt` and `.json` | a `ledger export`: the readable report and the bundle, decrypted |

The brain is decrypted in memory at session start and never written to disk or the request log in plain text. The
request log keeps the brain and ledger requests and answers as sent: encrypted objects, public keys, signed records and
receipts. The key store protection guards a copy of the disk, not a program running as you while you are signed in.
On macOS, creating the Keychain item puts its key on that one process's command line for a moment. A hard-coded rule,
always on (signed out too), refuses any tool call of Claude or its subagents that names the key folder, a recovery
sheet, the Keychain item or a DPAPI unprotect, and refuses an agent writing `decision: keep` into a brain review file
(only you set keep). Like the `no-tools` rule it guards against slips, not against a program that finds the files
another way. Your own typed `/agent-services brain` and `ledger` commands never pass through Claude.

### Turning it off

`/agent-services brain leave` stops sharing lessons, serving the brain and the ledger on this computer (your key
stays; your admin removes you from the roster). Back to the service from an own folder: `brain storage server`.
