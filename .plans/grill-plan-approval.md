# Grill Plan Approval Controls

Status: approved for implementation

Base: `pingdotgg/t3code` tag `v0.0.29-nightly.20260720.859` (`5d34f9ff`)

Delivery: bookmark `grill-plan-approval`, pushed only to `michft/t3code`

## Goal

Make structured grilling questions faster to answer while preserving the completed plan actions.

## Resolved behavior

- Numbered option buttons remain the direct way to choose options.
- Thumbs up accepts the first, recommended option for the current question.
- Thumbs down rejects all offered options and asks the agent to retry the question with new options.
- Plus asks the agent to repeat the question with more detail; minus asks for less detail.
- Typed text remains a different custom answer.
- At **Plan Ready**, thumbs up approves the proposed plan and uses the existing same-thread
  implementation flow.
- At **Plan Ready**, thumbs down sends a concise continuation prompt so grilling continues.
- Typed feedback keeps the existing **Refine** submission behavior.
- The existing **Implement in a new thread** menu action remains available.
- Controls use visible icons plus accessible labels; disabled/busy behavior matches existing plan
  actions.
- Question quick controls submit through the existing structured user-input contract.

## Implementation

- Add a shared plan-refinement continuation prompt next to existing plan implementation prompt.
- Wire a dedicated refinement callback through ChatView and ChatComposer.
- Add thumbs-down refinement action and thumbs-up affordance to Plan Ready primary actions.
- Add thumbs-up, thumbs-down, plus, and minus controls to structured questions.
- Cover prompt semantics and action presentation with focused tests.

## Validation

- Run focused proposed-plan and composer-action tests.
- Run `vp check`, `vp run typecheck`, and repository build in parallel.
- Verify JJ ancestry, bookmark target, clean status, and fork-only push destination.
