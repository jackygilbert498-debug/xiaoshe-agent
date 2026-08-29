# Agent Note: Projectless conversations and later project assignment

Status: implemented

## Problem

Requiring a Workspace before every conversation makes quick, miscellaneous work feel heavier than necessary. A user should be able to start talking immediately, create a project deliberately when one is needed, and organize an existing conversation into that project later. The storage model must still give every Session a concrete cwd and must not rewrite durable conversation history during organization.

## Decision

`session.create` accepts an explicit `loose: true` target in addition to Workspace and cwd targets. The Host owns a configurable loose-conversation root and creates one child directory named after the Session id for every projectless Session. Consequently every agent still receives a concrete, isolated cwd, while the Workspace registry remains free of synthetic catch-all projects.

The global New Session action creates a loose Session directly. A separate compact New Project action beside it invokes the composed directory picker, registers the selected directory as a real Workspace, and starts a Session there.

An ungrouped Session row exposes Move to project. A blank source is recreated directly in the selected Workspace. A non-blank source is forked into the selected Workspace so its durable history is preserved; after the target is visible, the source is archived and the target is opened. The original log is never edited in place.

## Alternatives considered

**Always reuse the most recent Workspace** — rejected because it silently assigns unrelated conversation history to whichever project happened to be active last.

**Register one synthetic Miscellaneous Workspace** — rejected because it would appear as a normal user project, mix system storage with intentional project directories, and make later organization ambiguous.

**Change a Session's cwd and Workspace membership in place** — rejected because cwd is part of the Session's execution identity and rewriting it would make earlier tool activity appear to have happened in a different project.

## Consequences

Conversation can start before project selection, and every projectless Session has its own directory under the Host-owned root. Users can still follow the project-first path through the adjacent New Project action. Moving a non-empty conversation creates a new Session id and archives the source; lineage preserves the relationship, while archived-session storage remains the recovery boundary.

## Verification

Host API tests cover creation of a loose Session and its per-Session directory. Runtime tests cover loose startup and Workspace-targeted fork behavior. Sidebar tests cover the distinct New Session and New Project actions. Workspace browser tests cover moving an ungrouped conversation into a selected Workspace.
