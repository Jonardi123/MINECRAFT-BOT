# TeammateBot Architecture Roadmap

## Current Shape

TeammateBot is already strongest in PvP. Combat, crystal logic, shield timing, totems, mace/elytra ideas, strafing, target tracking, bow logic, and arena problem solving live mostly in `lib/combat.js`, with orchestration in `lib/pvp.js` and telemetry in `lib/pvpTraining.js`.

Survival and autonomy exist, but the decision layer is split across `lib/survivalDirector.js`, `lib/survivalDispatcher.js`, `lib/autopilot.js`, `lib/aiController.js`, and command handlers in `index.js`. Mining, building, inventory, chest, food, and navigation systems are usable, but they are still mostly command-driven.

The dashboard already has a useful API and UI base. It can become the command center for goals, resources, current task state, combat stats, inventory, and training logs.

## Redundant Or Overlapping Areas

- `survivalDirector`, `survivalDispatcher`, `autopilot`, and `aiController` all contain pieces of "what should I do next?"
- Combat styles exist as behavior inside the combat loop, but they are not yet extracted into named strategy modules.
- Supplies can be checked through chests, but there is no persistent stockpile model that turns low resources into goals.
- Building has blueprints, but does not yet have a project planner that gathers materials and resumes long builds.

## Target Modules

- Combat Module: PvP styles, tactics, telemetry, target selection, safety.
- Mining Module: pattern mining, ore priorities, tool/fuel/safety management.
- Builder Module: blueprint loading, material math, construction order, verification.
- Resource Module: stockpile targets, deficits, resource acquisition plans.
- Food Module: hunger, farming, hunting, cooking, storage.
- Inventory Module: loadout protection, chest IO, junk deposit, kit readiness.
- Navigation Module: pathing, stuck recovery, terrain hazards, movement policies.
- Memory Module: allies, enemies, locations, outcomes, failed/successful plans.
- Task Planner: goal hierarchy, subtask generation, conflict prevention, timeouts.
- Dashboard Module: status, resources, goals, events, training, controls.
- Training Module: PvP/farming/mining/building eval logs and tuning metrics.

## Ranked Roadmap

1. Goal Planner + Stockpile Snapshot
   - Impact: Very high
   - Difficulty: Medium
   - Builds the central "why" layer without replacing existing systems.

2. Dashboard Command Center Upgrade
   - Impact: High
   - Difficulty: Low to medium
   - Makes current goal, next task, stockpiles, combat style, and training visible.

3. Combat Style Extraction
   - Impact: High
   - Difficulty: Medium
   - Converts implicit PvP behavior into named strategies like Crystal Specialist, Duelist, Mace, Defensive, and Survival.

4. Resource/Food Autonomous Loops
   - Impact: High
   - Difficulty: Medium
   - Turns stockpile deficits into safe acquisition tasks.

5. Builder Project Planner
   - Impact: High
   - Difficulty: Medium to high
   - Loads blueprints, calculates materials, gathers missing resources, builds, verifies, and resumes.

6. Memory Schema Upgrade
   - Impact: Medium
   - Difficulty: Medium
   - Stores enemies, allies, locations, stockpile snapshots, fight outcomes, and failed plans.

7. Mining Goal Integration
   - Impact: Medium
   - Difficulty: Medium
   - Connects mining methods to stockpile goals and return-home/storage logic.

8. Personality Layer
   - Impact: Medium
   - Difficulty: Low
   - Adds categorized non-spammy messages for progress, wins, rare events, and creator-specific moments.

## First Implementation Slice

Add a non-invasive goal planner that:

- Reads inventory, cached memory counts, and configured stockpile targets.
- Calculates stockpile gaps.
- Checks prerequisites like inventory space, food, torches, and pickaxe readiness.
- Produces a current goal and next recommended task.
- Publishes planner status to chat and dashboard.

This keeps PvP untouched while creating the foundation for real autonomous goals.
