# reMarkable: changelog

Newest first. With every change, raise the version and add an entry here.

## 1.4.0 — 25 November 2026
- **The folders Articles and Books on the reMarkable are left out of every sync**, as Zotero is. Zotero reMarkable (1.3.0) sends papers there, by tag, and brings their annotations back into Zotero, so they shouldn't come into the vault as PDFs. Zotero stays on the list for as long as the folder has that name. PDFs earlier syncs made from these folders are removed from the vault, as for Zotero (none have been made from Articles or Books so far).

## 1.3.1 — 24 November 2026
- **Zotero papers already in the vault are removed.** 1.3.0 only stopped new ones from coming in; PDFs that earlier syncs made from the reMarkable folder Zotero stayed in the vault under `reMarkable/Zotero`. Each sync now removes them, and the folders that leaves empty, and the sync log lists what it removed. This includes papers since moved into Zotero or deleted on the reMarkable. Only PDFs the plugin made are removed; anything else in those folders is kept.

## 1.3.0 — 23 November 2026
- **The folder Zotero on the reMarkable is left out of every sync**, with its subfolders. Zotero reMarkable (1.2.0) sends papers there and brings their annotations back into Zotero, so they no longer come into the vault as PDFs as well. The settings say so under “Excluded folders”; other folders to skip are still added there.
