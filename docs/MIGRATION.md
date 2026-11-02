# Moving to one common folder (VS Code + Unity)

Status: written 2026-11-02. How to put the whole project in one folder on the Windows PC, open it as one VS Code workspace, and connect the Unity work you already did. `scripts/migrate.ps1` does the work; it is tested on throwaway clones (`scripts/test-migrate.ps1`, 38 checks) with PowerShell 7 in the Linux sandbox and with Windows PowerShell 5.1 and PowerShell 7 on a GitHub Windows runner (see "What is verified" at the end). It has not run on the owner's PC.

## The latest build

Branch **`claude/funny-allen-fpoupb`**. It continues `claude/determined-pasteur-klc0fw` (last commit `2d7d549`, 2026-11-01) and adds this migration kit, the VS Code workspace, and fixes that bring every unit suite to green on a Windows runner (the daemon's went from 506 failures to 0; all were test-side, plus one config inconsistency). `main` holds only the first placeholder commit until this branch is merged. The branch `cursor/ai-cv-assistant-e49f` is a separate, older project (a CV assistant) and is not part of Mira.

What it contains: the daemon (loopback server, SQLite, Claude lanes, hook monitor, embedded terminal), the web app, the stage backend with its simulator, Docker mode, and the engine-free C# Unity package `unity/Packages/com.mira.stage` with 165 tests. The Unity project itself (`unity/MiraStage`: the room, the VRM, the Unity layer) is built on the PC; it is the "Unity work already done" this page connects.

## The layout

```
%USERPROFILE%\Mira\                   the common folder
  ai_assistant\                       the repository (git)
    Mira.code-workspace               open this in VS Code: one window for everything below
    unity\Packages\com.mira.stage\    the C# stage client (Unity package); the Unity layer goes in Runtime\Unity
    unity\MiraStage\                  the Unity 6 project; it uses the package through "file:../../Packages/com.mira.stage"
  content\                            the models (VRM) and other binaries, never in git
  migration-report.txt                written by the script
```

`%USERPROFILE%\Mira\content` is where the Unity stage looks for models by default, so this layout needs no environment variable. Any other folder works too; the script then tells you to set `MIRA_CONTENT_DIR` (or sets it with `-SetContentEnv`). Keep it out of OneDrive.

## Three steps

You need Git and VS Code; Node.js 22.14 or newer for the backend; Unity Hub with Unity 6 for the Unity project.

**1. Clone the latest build into the common folder** (PowerShell):

```powershell
git clone --branch claude/funny-allen-fpoupb https://github.com/drakedreper/ai_assistant.git $env:USERPROFILE\Mira\ai_assistant
```

**2. Run the migration**, pointing it at your existing Unity work. Double-click `migrate.cmd` in the new folder and paste the folder when it asks, or pass it:

```powershell
cd $env:USERPROFILE\Mira\ai_assistant
.\migrate.cmd -OldClone C:\dev\ai_assistant
```

Which one is yours:

| Your Unity work is... | Pass | What happens |
|---|---|---|
| in an older clone of this repository (the kickoff prompt cloned to `C:\dev\ai_assistant` and worked on the branch `unity-stage-pc`, project in `unity\MiraStage`) | `-OldClone <that clone>` | Its local branches are fetched into this clone as `pc/<branch>`, and the Unity branch is merged into a new local branch `unity-stage` on top of the latest build. The Unity layer, the `.meta` files and the project come with your commits. Uncommitted work makes it stop and say how to commit it (or pass `-CommitUncommitted`). |
| a Unity project folder somewhere else | `-UnityProject <project folder>` | The project is copied to `unity\MiraStage` without `Library`, `Temp`, `Logs`, `obj`, `Build`, `UserSettings` and the generated `.sln`/`.csproj`; its `Packages\manifest.json` is pointed at the package here. If the project carried its own copy of `com.mira.stage`, files only that copy has (your `Runtime\Unity`, `Editor`, `.meta` files) are added to the package, and package files you edited are listed and backed up to `migration-backup\`, never overwritten. The copy is left uncommitted on `unity-stage` for you to review. |
| nothing yet | nothing | It sets up the folder and the workspace; build the Unity project afterwards with [spikes/unity/KICKOFF-PROMPT.md](../spikes/unity/KICKOFF-PROMPT.md). |

Not sure? Give it the folder anyway: it works out whether it is a clone or a Unity project (or a folder with one project in it). `.\migrate.cmd -DryRun -OldClone ...` shows what it would do and changes nothing.

**3. Open and run.**

- VS Code opens `Mira.code-workspace` (or File, Open Workspace from File). Accept the recommended extensions (Unity, C# Dev Kit, Vitest, Tailwind, Docker, Claude Code). Terminal, Run Task lists the project's tasks (start, Docker, typecheck, tests, C# tests, verify, migration check); Run and Debug has "Attach to Unity" and "Daemon (fake Claude)".
- Unity Hub: Add, Add project from disk, `...\ai_assistant\unity\MiraStage`. The first open rebuilds `Library` (copy it with `-CopyLibrary` to skip that). In Unity: Edit, Preferences, External Tools, External Script Editor = Visual Studio Code, then Regenerate project files.
- Backend: `start.cmd` (native) or `start-docker.cmd` (Docker). The stage token reaches Unity through `MIRA_STAGE_TOKEN` or, with the native daemon, from its own `secrets.json`; it is never written into the project ([UNITY.md](UNITY.md), "Connecting").

Nothing is pushed. When you are happy with `unity-stage`, push it yourself (`git push -u origin unity-stage`), or bring it back to a Claude Code session to merge.

## What the script does and does not do

| It does | It never does |
|---|---|
| report git, node, pnpm, dotnet, Docker, Unity editors, VS Code | push, or change any remote |
| create `content\` with a README of what goes where, and say which of the two seeded models (`bases\vrm1\composed.vrm`, `presence-form.vrm`) are missing | delete or edit your old clone or old project (the only exception is the commit you ask for with `-CommitUncommitted`) |
| fetch, branch and merge in the new clone (a conflicting merge is undone and explained, exit code 2) | overwrite a package file you edited |
| copy a standalone project and fix its package reference | commit a copied project for you, or commit any binary |
| report textures and other binaries that git would take (models and audio are git-ignored already) | read, print or store the stage token |
| install the JavaScript dependencies and check the database library (`-SkipInstall` skips) | |
| open the workspace in VS Code (`-NoOpen` skips), save `migration-report.txt` | |

All options: `-OldClone`, `-UnityProject`, `-UnityBranch <name>` (when several old branches have new commits), `-WorkBranch <name>` (default `unity-stage`), `-ContentDir <folder>`, `-SetContentEnv`, `-CommitUncommitted`, `-CopyLibrary`, `-SkipInstall`, `-NoOpen`, `-DryRun`, `-NonInteractive`. `Get-Help .\scripts\migrate.ps1 -Detailed` prints them.

## If the merge has conflicts

The script undoes the merge and names the files. Your old branch stays available as `pc/<branch>`:

```powershell
git switch unity-stage
git merge pc/unity-stage-pc
```

Resolve the named files in VS Code (Source Control shows them), then `git commit`. The kickoff prompt told the PC session not to edit the docs or the contract, so conflicts should be rare; the likeliest are small compile fixes in `unity/Packages/com.mira.stage/Runtime/*.cs`. After resolving, run the C# tests (Run Task, "Mira: C# stage client tests") to check the client still speaks the protocol.

## Without GitHub (the packed copy)

A git bundle of the repository (every branch, full history) can stand in for the clone in step 1:

```powershell
git clone --branch claude/funny-allen-fpoupb mira.bundle $env:USERPROFILE\Mira\ai_assistant
git -C $env:USERPROFILE\Mira\ai_assistant remote set-url origin https://github.com/drakedreper/ai_assistant.git
```

## What is verified

| | how | result |
|---|---|---|
| The script's routes: dry run, old clone, uncommitted work, standalone project with an edited embedded package, merge conflict, rerun | `scripts/test-migrate.ps1` on throwaway clones, PowerShell 7.4 on Linux (the `Copy-Item` path) | 38 of 38; three deliberate breaks (no merge abort, overwriting an edited file, not excluding the embedded package) each failed a check |
| The same on Windows, with Windows PowerShell 5.1 and robocopy | the "Migration script" step of `.github/workflows/windows.yml` on a GitHub Windows runner | 38 of 38 in Windows PowerShell 5.1 and 38 of 38 in PowerShell 7 ([run](https://github.com/drakedreper/ai_assistant/actions/runs/41521369152)) |
| The rest of the build on Windows | the same run | `start.cmd` end to end, typecheck, every unit suite green (daemon 952, stage-core 1,405, agent-core 464, shared 9), C# 165, smoke 26, e2e-daemon 37, e2e-stage 38; e2e-terminal 32 passed, 4 failed (they need a shell started in a PTY, which the runner may not give; [PC-BRINGUP.md](PC-BRINGUP.md)) |
| The VS Code workspace | parsed as JSON; folder paths and tasks written to the documented layout | not opened in VS Code; the Unity debugger and C# Dev Kit not tried |

Not verified: the owner's PC, the real old clone or Unity project, Unity opening the moved project, and VS Code with the Unity extension. The script reports what it found and what is left at every step; the report file is what to bring back if something looks wrong.
