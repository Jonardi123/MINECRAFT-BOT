# Mining Methods

The bot does not use xray. It only mines blocks the normal client can know about and checks blocks exposed by its own tunnels.

## Quick Nearby Mining

```text
!goMine <block> <amount>
```

Best for blocks already nearby or exposed, like coal in a cave wall.

Examples:

```text
!goMine coal 8
!goMine iron 6
```

This can stop quickly if the requested block is not exposed or reachable near the bot.

## Prospect Mining

```text
!prospect <block> <amount> [steps]
```

Best for rare ores. The bot digs a controlled two-block-high tunnel and checks newly exposed blocks while it goes. It keeps going until it mines the requested amount, hits the step limit, gets full inventory, sees danger, gets low health, or you use `!stop`.

Examples:

```text
!prospect diamond 3 250
!prospect iron 16 160
!mineUntil diamond 1 128
```

This is still useful, but `!smartMine diamond` and `!diamondMine` now do better diamond-specific branch mining.

## Smart Resource Mining

```text
!smartMine <block> <amount>
```

The bot chooses a better method for the resource. For diamonds it tries to work toward Y -58 and branch mine. For common ores it prospects while checking exposed blocks.

Examples:

```text
!smartMine diamond 3
!smartMine iron 16
```

## Simple Tunnel

```text
!stripMine <length>
```

Digs straight forward from the bot's current position.

## Torch Tunnel

```text
!torchMine <length>
```

Like strip mining, but places torches every few blocks if the bot has torches.

## Branch Mine

```text
!branchMine <branches> <length>
```

Digs a main tunnel and short side branches.

## Diamond Mine

```text
!diamondMine <amount>
```

Uses the diamond branch mining path. It favors Y -58, places torches when it can, avoids lava/water exposure, avoids gravel/sand cave-ins, remembers the tunnel position, and checks visible exposed ore as it mines.

## Staircase Mine

```text
!staircaseMine <targetY>
```

Builds a descending staircase instead of dropping straight down. Useful for getting from surface/base height toward a safer mining level.

## Safe Cave Explore

```text
!caveExplore <steps>
```

Moves cautiously through nearby cave spaces, prioritizes exposed ores, places torches, and avoids unsafe blocks.

## Area Mine

```text
!mineArea <width> <height> <depth>
```

Mines a rectangular area in front of the bot.

## Exposed Block Check

```text
!findExposed <block>
```

Reports nearby exposed blocks without mining a tunnel.

## Ore Aliases

These short names work:

- `diamond` -> `diamond_ore` and `deepslate_diamond_ore`
- `iron` -> `iron_ore` and `deepslate_iron_ore`
- `coal` -> `coal_ore` and `deepslate_coal_ore`
- `gold` -> `gold_ore`, `deepslate_gold_ore`, and `nether_gold_ore`
- `copper` -> `copper_ore` and `deepslate_copper_ore`
- `redstone` -> `redstone_ore` and `deepslate_redstone_ore`
- `lapis` -> `lapis_ore` and `deepslate_lapis_ore`
- `emerald` -> `emerald_ore` and `deepslate_emerald_ore`

## Best Diamond Test

Stand the bot in a safe mine at diamond level, face the direction you want it to tunnel, then run:

```text
!diamondMine 3
```

Use `!stop` if it starts digging somewhere you do not like.
