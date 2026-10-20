# Logical project foundation

The root catalog owns project display metadata and conversation membership. A ProjectId is not an execution Scope. Renaming a project changes only its catalog name; physical Workspace.name, directory identity, conversation titles, grants and consent remain unchanged. Folder access remains the existing workspace-scoped capability. This foundation does not expose Move/Remove, instructions, or source-set context application.

## Identity and migration

Protocol 9 adds project methods without changing legacy method schemas. Catalog migration is explicit 9→10→11 or 10→11. The one-time migration maps existing ready workspace IDs to equal legacy ProjectIds, preserving unloaded renderer ordering IDs. New projects reserve independent project/workspace IDs. Subsequent physical workspace registration adds legacy metadata through the existing ready seam, excluding reserved incomplete logical creation.

No display name establishes a default chat workspace. Ready with a null default is valid, including populated project-only stores. The renderer may supply a verified store-scoped v1 role marker to adoptLegacyDefaultWorkspace; absent evidence does not classify old history. Unverified/conflicting renderer evidence must gate projectless creation until its legacy recovery is resolved. Explicit createProjectConversation with projectId:null creates a new default only when none exists. Merely loading the application creates nothing.

## Commands and recovery

createProject, createProjectConversation, renameProject, setProjectPinned, reorderPinnedProject and adoptLegacyDefaultWorkspace have exact requestId/normalized-parameter receipts. Pending creation reserves identities before physical work. Physical operations use the existing workspace owner; no catalog transaction spans a physical await. Retries reconcile those same reserved IDs and physical creation receipt before committing membership. A completed logical conversation receipt is the creation provenance: clients must not fabricate a legacy physical createConversation command.

getProjectCommandResult is read-only and distinguishes absent, pending and completed. Completed results remain historical even after a later rename. A pending default-creation journal reserves that role across clients and restart: another new projectless create or adoption must recover the original command rather than reserve a second default.

Adoption advances supervised batches of at most128 metadata candidates, using existing directory preparation. It retains checkpoints after failure. Client cancelWait only abandons waiting; it does not cancel work. Shutdown separately stops after a bounded safe batch and preserves the pending receipt for exact retry. No input submission scheduler or execution owner is added.

## Navigation

project_recent is global logical Recent: it contains eligible unpinned conversations in projectless scope and ordinary unpinned projects, excluding individually pinned conversations and pinned-project members. Existing recent/workspace views retain physical semantics. Logical pages require ready classification and carry independent membership and project-order generations; changing project pin eligibility invalidates continuation even without a membership change. While adoption is incomplete, physical navigation preserves access to legacy history; catalog project metadata remains readable.

listProjects seeks the project pin index and then the project primary key. A request examines bounded candidates, not an unlimited number of excluded rows. Empty pages with a continuation are not terminal empty. Metadata/order changes invalidate the cursor. getProjectPresentation reads one ready project's current pin revision without scanning project pages.

getProjectConversationSummary requires an explicit active/archived/all filter and counts pinned members too. It examines at most128 membership candidates plus one lookahead, joining the existing published navigation snapshot. It returns matchedAtLeast, complete, publication generation/completedAt and membership generation, not a fabricated global total. Complete requires exhausted membership candidates, verified metadata and ready publication. Missing metadata or a building/refreshing publication remains partial; malformed canonical metadata fails closed. This synchronous metadata read neither hydrates PI nor adds an activity scanner. Its exactness is relative to the named publication and last verified traversal, not a claim of live cross-database atomicity.

## Mixed Pinned ordering

Schema12 adds one authoritative typed mixed pin order and revision. Its explicit11→12 migration preserves complete conversation-pin and project-pin subsequences, initially placing conversations before projects. Older9/10 migrations still pass through11. listSidebarPins returns project and canonical conversation rows in this order, with a verified nextPinKey exactly when nextCursor exists. Each request seeks at most51 candidates and hydrates at most51 identities, including the unloaded successor. Invalid/missing metadata is an error, not silently skipped. An order change during awaited hydration rejects the whole page as stale.

reorderSidebarPin supports arbitrary project/conversation placement and records one immutable atomic receipt. Existing set-pin, legacy reorder, archive cleanup and default adoption update mixed order within their existing catalog transaction. Legacy per-kind ordinal columns are compatibility projections; they reuse their own ordinal slots and never become a second ordering authority. Every mixed change advances both legacy order fences. Pure reorder changes neither membership nor individual pin revision. Old receipts and method schemas remain unchanged, including exact recovered v8 commands. New mixed reorder commands require their own tagged current-protocol local journal decoder.

## Maintenance and limits

Schema11 backups preserve logical metadata, memberships, role provenance, pending journals and immutable receipts; schema12 additionally preserves mixed order and receipts. Archive restore remains a read-only schema4 history archive, not an active runtime or permission restore. Membership records survive projection rebuilds, including archived/unloaded conversations and explicit null assignments. Invalid authoritative relationships or missing authoritative tables fail closed rather than being silently reconstructed from physical names.

Tests cover real production wiring, exact crash retries, default reservation races, adoption shutdown versus cancelWait, migration rollback, backup verification, unchanged physical identities, indexed sparse paging and independent navigation fences. Mixed pin tests cover interleaving, legacy CAS/replay compatibility, receipt-write rollback, unloaded anchors and hydration races. This is not a claim that context transfer, bidirectional viewport paging, complete membership counts or external-provider execution has been accepted.
