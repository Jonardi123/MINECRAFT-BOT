# Minecraft AI Teammate Bot

A beginner-friendly Mineflayer teammate bot for a private Minecraft Java server. It follows allowed players, deposits items, mines, farms mobs, checks supplies, protects nearby friends, and remembers important places in `memory.json`.

This project is intentionally normal-client only. It does not use hacks, cheats, xray, dupes, exploits, or server bypasses.

## Requirements

- Minecraft Java Edition server you own or have permission to use
- Node.js 22 or newer
- A server that allows the bot account to join

## Install

Open CMD in this folder:

```cmd
cd /d C:\Users\jonar\Documents\Codex\2026-05-25\create-a-complete-minecraft-ai-teammate
npm install
npm run check
```

If your files are on the Desktop, use:

```cmd
cd /d C:\Users\jonar\Desktop\mc-ai-bot
npm install
npm run check
```

## Configure

Edit `config.json`.

Set your server. `version` should be a Java version that Mineflayer supports, such as `1.21.11`. Use `false` or `"auto"` only when your server reports a normal supported Java version.

```json
"server": {
  "host": "YOUR_SERVER_IP_OR_DOMAIN",
  "port": 25565,
  "version": "1.21.11"
}
```

If you see `No data available for version 26.1.2`, your server or proxy is reporting a newer Java version than Mineflayer supports. Keep `"version": "1.21.11"` and try again. If the server rejects the bot, the server must allow older Java clients or be switched to a Mineflayer-supported Java version.

If you see `Outdated client! Please use 26.1.2`, the server does not allow the older client version. That cannot be solved in bot code until Mineflayer publishes protocol/data support for `26.1.2`. Use a server/proxy setting that permits older Java clients, or run the server on a supported version such as `1.21.11`.

Set the bot name:

```json
"bot": {
  "username": "TeammateBot",
  "auth": "offline",
  "reconnect": true,
  "reconnectDelayMs": 10000
}
```

For most private offline/LAN servers, keep `"auth": "offline"`. If your server requires a Microsoft account, change it to `"microsoft"` and use a bot account you own.

Add every player allowed to command the bot:

```json
"allowedPlayers": [
  "YourMinecraftName",
  "FriendName"
]
```

Set an approximate home/base position, or use `!setHome` after the bot joins:

```json
"positions": {
  "home": { "x": 100, "y": 64, "z": -30 },
  "miningArea": null,
  "chests": {
    "storage": null,
    "farm": null
  }
}
```

## Start

```cmd
npm start
```

Stop it with `Ctrl+C`.

On Windows, you can also double-click `start-bot.cmd` or run:

```cmd
start-bot.cmd
```

## First Safe Test

1. Start your Minecraft server.
2. Start the bot with `npm start`.
3. Join the server yourself.
4. Stand at your base and type:

```text
!setHome
!status
!come
```

5. Place a chest near the bot, look at it with the bot or stand the bot beside it, then type:

```text
!setChest storage
!checkSupplies
```

6. Place another chest for animal drops:

```text
!setChest farm
```

7. Try small tasks first:

```text
!explore 12
!goMine coal_ore 4
!prospect diamond 1 128
!stripMine 12
!bootstrap
!farm pigs 2
!deposit
```

Use `!stop` any time you want the bot to cancel the active task.

## Commands

- `!come` - come to you.
- `!follow` - follow you until `!stop`.
- `!stop` - cancel the current task and turn protect mode off.
- `!setHome` - save the bot's current position as home.
- `!setChest storage` - save nearby/looked-at chest or barrel as storage.
- `!setChest farm` - save nearby/looked-at chest or barrel for farm drops.
- `!inventory` - show a short inventory summary.
- `!drop <item>` - drop an item to you.
- `!deposit` - deposit inventory into the storage chest.
- `!explore <radius>` - explore near home within the radius.
- `!bootstrap`, `!getBasics`, or `!startFromScratch` - claim a bot base, gather logs, craft starter items, place storage if possible, and collect starter stone.
- `!survive <minutes>` or `!autoSurvive <minutes>` - run the basic survival resource loop for a limited time.
- `!autoplay [minutes]` or `!selfPlay [minutes]` - run autonomous survival autopilot. Without minutes it keeps going until `!stop`.
- `!autoplayOff` - stop autonomous survival autopilot.
- `!autoplayStatus` - show current autopilot stage, skill, and recent failures.
- `!brainStatus` - show survival director/autoplay status.
- `!rewardStatus` - show compact reward-learning priorities.
- `!botStash` - show the bot's own base and stash chest coordinates.
- `!buildCamp` or `!camp` - make a small starter camp with crafting/storage when materials allow.
- `!buildBase`, `!buildBase small`, or `!buildBase fancy` - build a blueprint base near you with exact material checks. Fancy bases include two floors, windows, balcony, sloped roof details, lights, storage/crafting/smelting corners, an outside farm, path, fences, trapdoors, stairs, and slabs. Add `oak`, `spruce`, or `cherry` to prefer a palette.
- `!stopBuild` - cancel the current base build.
- `!buildShelter` or `!shelter` - build a quick block shelter around the bot when it has blocks.
- `!cookFood [amount]`, `!cook`, or `!smeltFood` - place/use a furnace and cook raw meat or potatoes when it has fuel.
- `!makeBed`, `!bed`, or `!setSpawn` - gather wool if possible, craft/place a bed, then sleep to set spawn if it is night.
- `!sleep` - sleep in a nearby bed and set spawn when sleeping is allowed.
- `!getWood <amount>` - directly gather nearby logs with the best axe/tool it has.
- `!getStone <amount>` or `!getCobble <amount>` - get starter cobblestone, crafting a wooden pickaxe first if needed.
- `!goMine <block> <amount>` - mine a block, such as `coal_ore` or `iron_ore`.
- `!smartMine <block> <amount>` - use smarter mining for that resource, including ore Y-levels and branch mining for diamonds.
- `!prospect <block> <amount> [steps]` or `!mineUntil <block> <amount> [steps]` - dig a tunnel until the target ore is found or the step limit is reached.
- `!stripMine <length>` - dig a simple forward tunnel from where the bot is standing.
- `!torchMine <length>` - strip mine and place torches if the bot has torches.
- `!branchMine <branches> <length>` - dig a small branch mine without xray or cheats.
- `!diamondMine <amount>` - staircase toward diamond level when needed, then branch mine safely for diamonds.
- `!diamondBeacon [minutes]`, `!beacon [minutes]`, or `!beaconObjective [minutes]` - long-term full diamond beacon objective. It verifies resources, mines diamonds in batches, crafts diamond blocks, tracks missing beacon materials, and only builds after `!setBeaconSite`.
- `!beaconStatus` - show verified diamond block, diamond, glass, obsidian, nether star, and build-site progress.
- `!setBeaconSite` - save the current bot position as the future beacon pyramid site.
- `!staircaseMine <targetY>` - dig a safe descending staircase toward a Y-level.
- `!caveExplore <steps>` - cautiously check nearby cave paths and exposed ores.
- `!mineArea <width> <height> <depth>` - mine a rectangular area in front of the bot.
- `!findExposed <block>` - report nearby exposed blocks the bot can see normally.
- `!returnHome` or `!home` - return to the saved home position.
- `!farm <target> <amount>` - farm mobs, such as `!farm pigs 20`.
- `!protect` - attack nearby hostile mobs close to players.
- `!protectOff` - disable protect mode.
- `!pvpOn` - turn on defensive PVP retaliation. If a nearby player hits the bot, it fights back.
- `!pvpOff` - turn off defensive PVP and stop any active PVP fight.
- `!mobDefenseOn` - arm automatic self-defense against hostile mobs that hurt the bot.
- `!mobDefenseOff` - disable automatic hostile mob self-defense.
- `!mobDefenseStatus` - show whether mob self-defense is armed or currently fighting.
- `!dispatcherStatus` - show the survival-first interrupt system's current or last action.
- `!dispatcherOff` / `!dispatcherOn` - disable or re-enable survival-first interrupts for testing.
- `!fight <player>` - manually start fighting a visible player, useful for testing on your own server.
- `!status` - show task, health, food, armor, tool, protect mode, and location.
- `!checkSupplies` - report low storage resources.
- `!chat <message>` - talk to the bot's teammate brain.
- `!remember <note>` - save a short note for the teammate brain.
- `!notes` - show the latest saved notes.
- `!aiOn` - resume LLM-driven autonomous control.
- `!aiOff` - pause LLM-driven autonomous control.
- `!objective <goal>` or `!goal <goal>` - give the LLM a long-term survival objective.
- `!clearObjective` - clear the saved long-term objective.
- `!aiStatus` - show whether autonomous AI is on and what goal it has.
- `!llmStatus` - check whether the bot can reach LM Studio and see a loaded model.

You can also mention `TeammateBot` or `bot` in normal chat and it will answer if you are in `allowedPlayers`.

Natural chat works too:

```text
yo bot what r u doing
bot where are you
bot are you busy
bot what can you do
bot get 8 stacks of diamonds and 6 stacks of iron
```

Status/location questions are answered directly from the bot's real state, even when local AI is enabled.

Natural objective requests like `bot get more food and iron` are saved as LLM goals. Use `!stop` to cancel and pause the AI loop instantly, then `!aiOn` or `!objective ...` to resume.

Natural self-play requests like `bot survive by yourself`, `bot play on your own`, or `bot act like a normal player` start `!autoplay`.

## Survival Autopilot

`!autoplay` is the most reliable way to make the bot act on its own. It does not ask the LLM for every tiny movement. Instead, an agent core chooses curriculum objectives, a skill registry runs known deterministic skills, a critic checks whether the skill actually worked, and the survival director handles the low-level progression: gather logs, craft a table, craft tools, make storage, mine stone, gather food, mine coal/iron, prepare diamond mining, and deposit supplies.

The autopilot tracks the active skill, curriculum objective, director stage, last position, progress, failed skills, and stuck recoveries in `memory.json`. If it stops making progress, it jumps, clears movement, repositions, and retries from a different angle.

The survival-first dispatcher runs in the background. It can interrupt work for close hostile mobs, hunger, missing food, full inventory, or stuck movement, then resume autoplay when possible. Use `!dispatcherStatus` or `!status` to see what it last did.

Autopilot routine chat is muted by default so it does not spam messages like `Crafting starter kit` or `Repositioning`. Use `!autoplayStatus` to check what it is doing. The mute settings are in `config.json` under `chat`.

## LLM-Controlled Survival

The bot has an autonomous LLM controller that asks LM Studio for one strict JSON action every few seconds. The model can choose safe normal-player actions such as moving, looking, digging a visible block, placing a block, equipping items, eating food, crafting, depositing, withdrawing, exploring, returning home, gathering wood/food, mining resources, prospecting, fleeing, and chatting.

The model is never allowed to run JavaScript, edit files, run server commands, xray, dupe, exploit, or bypass rules. The code validates the JSON before doing anything. Invalid JSON is retried once, then ignored with a safe fallback.

Player commands override the LLM. `!stop` cancels movement, pathfinding, mining, combat, the current AI action, and pauses autonomous decisions.

## Minecraft Knowledge

The `knowledge` folder contains compact guides for survival, mining, combat, PvP, mobs, Nether prep, dragon prep, crafting, inventory, recovery, long-term objectives, exploration, enchanting, brewing, trading, base safety, redstone utility, speedrun basics, villages, and structures. The LLM does not receive every guide every time. The bot scores the relevant categories for the current situation, chat message, goal, danger state, or failure pattern, then uses Mineflayer skills to execute normal Minecraft actions.

Knowledge is for planning, chat answers, strategy choice, objective choice, and failure analysis. Movement, mining, crafting, fighting, pathfinding, depositing, eating, gathering, and returning home still run through hardcoded Mineflayer skills.

## Reward Learning

The bot also keeps a simple reward score in `memory.json`. This is not real neural-network training. It gives points for useful outcomes like eating, gathering food, mining useful resources, crafting needed tools, protecting players, and completing steps. It subtracts points for deaths, repeated failed actions, getting stuck, hunger damage, and idling too long during objectives.

The LLM only sees a short reward summary with current priorities and repeated failure patterns. If food becomes a repeated problem, the bot raises food priority and should eat or gather food before mining or combat. With keepInventory on, death is treated as feedback: the objective stays, the score changes, and the next attempt should use a better strategy.

## Agent Core

The bot now has a Voyager-style agent loop: observe state, choose a curriculum objective, select a registered skill, execute the hardcoded skill, run a critic check, then store success or failure. The LLM may advise strategy, but it never writes code, runs commands, or controls every movement tick.

Registered skills include `secure_food`, `gather_wood`, `craft_starter_tools`, `mine_stone`, `craft_stone_tools`, `make_storage`, `prepare_mining`, `mine_coal`, `mine_iron`, `craft_shield_bucket`, `armor_up`, `prepare_diamond_mining`, `mine_diamonds`, `prepare_nether`, `combat_prepare`, `return_home`, and `recover_from_stuck`.

Optional Mineflayer helper plugins are listed as optional dependencies. If installed, the bot tries to load them; if not, it safely falls back to its own code.

## Optional Local AI Chat

The bot can talk through a local AI server. It works without AI by using simple built-in replies.

For Ollama:

```json
"ai": {
  "enabled": true,
  "provider": "ollama",
  "endpoint": "http://127.0.0.1:11434/api/generate",
  "model": "llama3.2"
}
```

For LM Studio, start a local OpenAI-compatible server in LM Studio and use:

```json
"ai": {
  "enabled": true,
  "provider": "lmstudio",
  "endpoint": "http://127.0.0.1:1234/v1/chat/completions",
  "model": "tildeopen-30b-enlv-unsloth-instruct"
}
```

To load the smarter 30B model from CMD:

```cmd
cd /d C:\Users\jonar\Desktop\mc-ai-bot
npm run llm:smart
```

Keep replies short. Minecraft chat is tiny, so the bot trims long AI answers.

See `LOCAL_AI_SETUP.md` for the recommended installed model and setup steps.

## Farming Targets

Supported targets:

- `pigs`
- `cows`
- `sheep`
- `chickens`
- `zombies`
- `skeletons`
- `spiders`
- `creepers`

The bot avoids players, villagers, pets, and named mobs. It is cautious around hostile mobs and stops if health gets low.

## Defensive PVP

PVP retaliation is on by default. The bot only retaliates when a nearby player damages it. You can also turn it on manually:

```text
!pvpOn
```

When enabled, the bot watches for damage from nearby players, equips its best sword or axe, strafes, uses sprint hits, tries shield timing if it has a shield, and fights the attacker. It stops if it dies, the target disappears, or the target runs too far away. Use `!stop` to cancel the current fight. Use `!pvpOff` to fully disable retaliation.

## How Memory Works

`memory.json` stores:

- home
- mining area
- storage chest
- farm chest
- bot storage chest
- bot base
- recently seen allowed and non-allowed player names
- recent chat snippets for the optional AI teammate brain

You can delete `memory.json` to reset remembered positions, or use commands like `!setHome` and `!setChest storage` to update it.

## Notes and Limits

Mineflayer bots are not real humans. This teammate is careful and useful, but it can still get stuck, fail to path through complex builds, or stop when something looks unsafe.

Mining is intentionally conservative. The bot avoids nearby lava or water and will stop rather than dig into obvious danger. For best results, set home near a safe mine entrance and ask for modest amounts first.

For rare ores like diamonds, use `!prospect diamond 3 250` instead of `!goMine diamond 3`. `!goMine` checks reachable exposed blocks nearby; `!prospect` keeps tunneling and checking newly exposed blocks. See `MINING_METHODS.md` for the full mining command guide.

ALSO:
1. I have no idea why the folder is so small, i also removed some things cuz github wouln't let me publish it cuz the file is too large, hope u like it!!
