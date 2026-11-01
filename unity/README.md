# unity/

The Unity side of the stage ([docs/UNITY.md](../docs/UNITY.md) says what it is, what is tested and what is not).

- `Packages/com.mira.stage/`: the UPM package. `Runtime/*.cs` is an engine-free C# client for the `mira-stage/1` protocol (no UnityEngine, C# 9, .NET Standard 2.1) with its tests and fixtures in `Tests~/`. The Unity layer (`Runtime/Unity`, `Editor`) does not exist yet: it is built on the Windows PC from [spikes/unity/KICKOFF-PROMPT.md](../spikes/unity/KICKOFF-PROMPT.md).
- `MiraStage/` (does not exist yet): the Unity 6 project, created there by `unity projects create`. It references the package with `"com.mira.stage": "file:../../Packages/com.mira.stage"` in its `Packages/manifest.json`.
- No binary model, texture or audio file is ever committed here (`.gitignore`). Models live in the content folder (`MIRA_CONTENT_DIR`, default `%USERPROFILE%\Mira\content`).

Check the C# side (needs the .NET 8 SDK; the live tests also need node and `pnpm install` at the repository root, because they start the real daemon):

```bash
dotnet test unity/Packages/com.mira.stage/Tests~/Tests/Mira.Stage.Tests.csproj
```
