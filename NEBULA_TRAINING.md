# Nebula Minecraft Training

This bot should only be trained on private Minecraft servers you own or have explicit permission to test.

## What Changed

Nebula now treats the bot like a small team of training agents:

- `SessionAgent` checks startup, preflight, and safe bounded sessions.
- `SelfModelAgent` tracks identity, body state, task, goal, risks, confidence, and next best action.
- `MovementAgent` watches pathfinding, stuck recovery, and route timing.
- `SurvivalAgent` watches food, tools, shelter, storage, and recovery.
- `MiningAgent` watches ore gathering, tool readiness, and hazards.
- `CombatAgent` watches controlled mob defense and retreat behavior.
- `ModdedThreatAgent` watches unknown mobs, gun-like names, projectiles, and fast damage.
- `InventoryAgent` watches missing ingredients and chest memory.
- `BuilderAgent` watches camp, shelter, and fancy starter-base construction.
- `DirectorAgent` watches autopilot objectives and blocked-step recovery.
- `MemoryAgent` watches reward history, lessons, and repeated failures.

## Safe Training Loop

1. Run `npm.cmd run check`.
2. Run `npm.cmd run training:report`.
3. Fix anything marked `needs attention`.
4. Start a private/permitted server session with `npm.cmd start`.
5. Train one scenario from `scripts/training-scenarios.json`.
6. Run `npm.cmd run training:report` again and compare the agent board.

## Marlow Drill

Use these private-server drills when you want the bot to act more like a competent survival player:

- `npm.cmd run test:bot -- bootstrap 180000` - fresh opening: base, wood, table, tools, storage, stone.
- `npm.cmd run test:bot -- ironkit 300000` - food, coal, iron, shield/bucket readiness.
- `npm.cmd run test:bot -- cavesafe 240000` - torch mining, cautious cave checks, exposed ore scan, risk report.
- `npm.cmd run test:bot -- marlow 420000` - combined high-signal progression drill.
- `npm.cmd run test:bot -- craftdrill 180000` - local command-capable crafting drill.
- `npm.cmd run test:bot -- fancybase 180000` - local command-capable `!buildBase fancy spruce` blueprint drill.
- `npm.cmd run test:bot -- duel 100000` - local defensive PvP drill against `CodexTester`.
- `npm.cmd run test:bot -- mobdrill 130000` - local zombie/skeleton mob-defense drill.
- `npm.cmd run test:bot -- realplayer 130000` - real-player autonomy smoke test.
- `npm.cmd run test:temp-server` - setup and run the local temp server drill suite.

After any drill, run `npm.cmd run training:report`. The report now includes `Next Weakness Drills`, which picks the next scenario from memory signals like stuck movement, repeated failed actions, poor food safety, mining failures, damage, and blocked director state.

## Real-Player Mode

Real-player mode makes the bot start bounded self-play when it is idle instead of waiting forever for commands. It arms mob defense and defensive PVP, sets a survival benchmark goal, then works through food, crafting, storage, mining, gear, and safety.

- `!realPlayer [minutes]` - turn it on and immediately start a bounded self-play run.
- `!realPlayerOff` - turn it off.
- `!realPlayerStatus` - show autostart, run length, and current benchmark goal.

## Self-Aware Behavior

Use these while the bot is online:

- `!self` for a compact self-model status.
- `!reflect` for a longer explanation of what it thinks is happening.
- `!risk` for the current risk list and safest next action.
- `!modstatus` for live and remembered modded threat signals.

The bot can also answer natural chat like `bot do you know you are playing Minecraft?` with its self-model context.

## Modded Servers

The bot treats unknown mobs as suspicious by default. Names containing gun-like or military words such as `ak`, `rifle`, `bullet`, `grenade`, `turret`, `soldier`, or `bandit` are ranked as ranged/modded threats. During mining and autopilot, these threats should make the bot pause, shield, evade, or take cover instead of blindly fighting.

## Boundary

This setup intentionally avoids public-server botting, account/proxy scaling, stealth behavior, unauthorized stress testing, and offensive automation outside controlled private worlds.
