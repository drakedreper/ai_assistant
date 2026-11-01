using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Mira.Stage.Tests
{
    public class CommandTests
    {
        [Fact]
        public void EveryGoldenCommandIsUnderstood_AndKeepsItsTypeAndId()
        {
            var files = TestPaths.GoldenFiles("commands");
            Assert.Equal(19, files.Length);
            foreach (var file in files)
            {
                var text = File.ReadAllText(file);
                var json = JObject.Parse(text);
                var parsed = StageCommandParser.Parse(text);
                Assert.True(parsed.Ok, Path.GetFileName(file) + ": " + parsed.Error);
                Assert.Equal(json.Value<string>("type"), parsed.Command.Type);
                Assert.Equal(json.Value<string>("id"), parsed.Command.Id);
            }
        }

        [Fact]
        public void TheCommandsThisStageDoesNotImplementArriveAsKnownUnsupported_AndAFutureOneAsUnknown()
        {
            foreach (var type in new[] { "scene.object", "scene.construct", "scene.data", "construct.terminal.write", "perform.interact" })
            {
                var parsed = StageCommandParser.Parse(TestPaths.ReadGolden("commands/" + type + ".json"));
                var u = Assert.IsType<UnsupportedCommand>(parsed.Command);
                Assert.True(u.Known, type);
                Assert.Equal(type, u.Type);
                Assert.NotNull(u.Raw);
            }
            var future = StageCommandParser.Parse("{\"id\":\"c1\",\"type\":\"perform.dance\",\"style\":\"salsa\"}");
            var f = Assert.IsType<UnsupportedCommand>(future.Command);
            Assert.False(f.Known);
            Assert.Equal("perform.dance", f.Type);
        }

        [Fact]
        public void CharacterLoad_CarriesWhatAStageNeeds()
        {
            var c = Assert.IsType<CharacterLoad>(StageCommandParser.Parse(TestPaths.ReadGolden("commands/character.load.json")).Command);
            Assert.Equal("char.assistant", c.Character.Id);
            Assert.Equal("assistant", c.Character.Role);
            Assert.Equal("vrm1", c.Character.RigFamily);
            Assert.Equal("asset.base.vrm", c.Character.BaseAssetId);
            Assert.Equal(StageProtocol.WardrobeSlots.Length, c.Character.Equipped.Count);
            Assert.Equal("asset.top.blazer", c.Character.Equipped["top"]);
            Assert.Null(c.Character.Equipped["bottom"]);
            Assert.Equal(1.72, c.Character.Params["height"].Value<double>(), 3);
            Assert.Equal("#d9b08c", c.Character.Params["skin.tone"].Value<string>());
            Assert.Equal("af_heart", c.Character.Voice.VoiceId);
            Assert.Equal(0.7, c.Character.Presence.Baseline.Dominance, 3);
            Assert.Equal(2, c.Assets.Count);
            Assert.Equal("vrm:Characters/base.vrm", c.Assets[0].Locator);
            Assert.Equal("character_base", c.Assets[0].Kind);
            Assert.Equal(false, c.Assets[0].License.AdultExpression);
            Assert.False(c.Assets[0].License.CommercialUse);
            Assert.Equal("height", c.Assets[0].Params[0].Id);
            Assert.Equal(new[] { "torso", "arms" }, c.Assets[1].Hides.ToArray());
            Assert.Equal(new[] { "top" }, c.Assets[1].Slots.ToArray());
        }

        [Fact]
        public void SceneLoad_CarriesTheVoidTheCamerasAndTheLighting()
        {
            var s = Assert.IsType<SceneLoad>(StageCommandParser.Parse(TestPaths.ReadGolden("commands/scene.load.json")).Command);
            Assert.Equal("asset.env.void", s.Scene.EnvironmentAssetId);
            Assert.Equal(new[] { "wide", "closeup" }, s.Scene.Cameras.Select(c => c.Id).ToArray());
            Assert.Equal("wide", s.Scene.ActiveCameraId);
            Assert.Equal("face", s.Scene.Cameras[1].Follow);
            Assert.Equal(new[] { 0.0, 1.6, 1.0 }, s.Scene.Cameras[1].Transform.Position);
            Assert.Equal(new[] { 0.0, 0.0, 0.0, 1.0 }, s.Scene.Cameras[1].Transform.Rotation);
            Assert.Equal("void", s.Scene.Lighting.Look);
            Assert.Equal(0.55, s.Scene.Lighting.Atmosphere.FogDensity, 3);
            Assert.Equal(2.2, s.Scene.Lighting.Atmosphere.FloorPool.Radius, 3);
            Assert.Equal("builtin:void", s.Assets[0].Locator);
            Assert.Empty(s.Scene.Constructs);
        }

        [Fact]
        public void PerformSpeak_CarriesTheUtteranceTheEmotionAndTheAudioSpec()
        {
            var sp = Assert.IsType<PerformSpeak>(StageCommandParser.Parse(TestPaths.ReadGolden("commands/perform.speak.json")).Command);
            Assert.Equal("utt-0001", sp.UtteranceId);
            Assert.Equal("Good morning.", sp.Text);
            Assert.Equal("happy", sp.Emotion);
            Assert.Equal(2, sp.EmotionTimeline.Count);
            Assert.Equal(600, sp.EmotionTimeline[1].TMs);
            Assert.Equal("pcm_s16le", sp.Audio.Format);
            Assert.Equal(24000, sp.Audio.SampleRate);
            Assert.Equal(1200, sp.Audio.TotalMs);
            Assert.Equal("backend", sp.FaceSource);
            Assert.Equal(5000, sp.AtMs);
        }

        [Fact]
        public void TheOtherSupportedCommandsCarryTheirFields()
        {
            Assert.Equal(300, Assert.IsType<CharacterParams>(Parse("character.params")).BlendMs);
            var equip = Assert.IsType<CharacterEquip>(Parse("character.equip"));
            Assert.Equal("top", equip.Slot);
            Assert.Equal("asset.top.blazer", equip.AssetId);
            Assert.Equal("vrm:Outfits/blazer.vrm", equip.Asset.Locator);
            var outfit = Assert.IsType<CharacterOutfit>(Parse("character.outfit"));
            Assert.Equal("preset.work", outfit.Preset.Id);
            Assert.Equal("#202020", outfit.Preset.Tweaks["asset.top.blazer"]["color"].Value<string>());
            Assert.Equal("closeup", Assert.IsType<SceneCamera>(Parse("scene.camera")).CameraId);
            Assert.Equal("night", Assert.IsType<SceneLighting>(Parse("scene.lighting")).Lighting.Look);
            Assert.Equal(120, Assert.IsType<PerformCancel>(Parse("perform.cancel")).FadeMs);
            var affect = Assert.IsType<PerformAffect>(Parse("perform.affect"));
            Assert.Equal("neutral", affect.Affect.Label);
            Assert.Equal(400, affect.BlendMs);
            Assert.Equal("nod", Assert.IsType<PerformGesture>(Parse("perform.gesture")).Clip);
            var gaze = Assert.IsType<PerformGaze>(Parse("perform.gaze"));
            Assert.Equal("point", gaze.Target.Kind);
            Assert.Equal(new[] { 0.5, 1.6, 2.0 }, gaze.Target.Position);
            var posture = Assert.IsType<PerformPosture>(Parse("perform.posture"));
            Assert.Equal("sit", posture.Posture);
            Assert.Equal("obj.chair", posture.AnchorObjectId);
            Assert.Equal("attentive", Assert.IsType<PerformIdle>(Parse("perform.idle")).Profile);
        }

        [Fact]
        public void DictionaryKeysAreDataAndAreNeverRenamed()
        {
            var parsed = StageCommandParser.Parse("{\"id\":\"c1\",\"type\":\"character.params\",\"characterId\":\"char.assistant\",\"params\":{\"Height\":1.7,\"Face.Width\":0.4}}");
            var p = Assert.IsType<CharacterParams>(parsed.Command);
            Assert.Contains("Height", p.Params.Keys);
            Assert.Contains("Face.Width", p.Params.Keys);
        }

        [Fact]
        public void EveryCommandRecordedFromTheRealDaemonParses_AndIsOneTheStageImplements()
        {
            var files = TestPaths.GoldenFiles("recorded").Where(f => System.Text.RegularExpressions.Regex.IsMatch(Path.GetFileName(f), @"^\d+-.*\.json$")).ToArray();
            Assert.True(files.Length >= 10, "recorded traffic is missing: run scripts/record-stage-golden.ts");
            var types = new HashSet<string>();
            foreach (var f in files)
            {
                var parsed = StageCommandParser.Parse(File.ReadAllText(f));
                Assert.True(parsed.Ok, Path.GetFileName(f) + ": " + parsed.Error);
                Assert.IsNotType<UnsupportedCommand>(parsed.Command);
                types.Add(parsed.Command.Type);
            }
            Assert.Contains("character.load", types);
            Assert.Contains("scene.load", types);
            Assert.Contains("perform.speak", types);
        }

        [Fact]
        public void TheRealCharacterLoad_HasBothCharactersAsVrmWithRelativeLocators()
        {
            var loads = TestPaths.GoldenFiles("recorded", "*-character.load.json").Select(f => (CharacterLoad)StageCommandParser.Parse(File.ReadAllText(f)).Command).ToArray();
            Assert.Equal(new[] { "assistant", "user" }, loads.Select(l => l.Character.Role).OrderBy(r => r, StringComparer.Ordinal).ToArray());
            foreach (var l in loads)
            {
                Assert.Equal("vrm1", l.Character.RigFamily);
                Assert.All(l.Assets, a =>
                {
                    Assert.False(Path.IsPathRooted(a.Locator), a.Locator);
                    Assert.DoesNotContain("..", a.Locator);
                    Assert.DoesNotContain("://", a.Locator);
                });
            }
        }

        [Theory]
        [InlineData("not json at all", null, "invalid JSON")]
        [InlineData("[1,2]", null, "not an object")]
        [InlineData("{\"id\":\"c1\"}", "c1", "type is missing")]
        [InlineData("{\"type\":\"scene.camera\"}", null, "id is missing")]
        [InlineData("{\"id\":\"c2\",\"type\":\"perform.speak\",\"utteranceId\":\"u\"}", "c2", "audio is missing")]
        [InlineData("{\"id\":\"c3\",\"type\":\"scene.camera\",\"blendMs\":\"slow\"}", "c3", "invalid command")]
        [InlineData("{\"id\":\"c5\",\"type\":\"scene.camera\"}", "c5", "cameraId is missing")]
        [InlineData("{\"id\":\"c4\",\"type\":\"character.load\",\"character\":{\"id\":\"x\",\"equipped\":5}}", "c4", "invalid command")]
        public void BadFramesAreRefusedWithTheIdWhenThereIsOne(string json, string expectedId, string expectedError)
        {
            var parsed = StageCommandParser.Parse(json);
            Assert.False(parsed.Ok);
            Assert.Equal(expectedId, parsed.Id);
            Assert.Contains(expectedError, parsed.Error);
        }

        private static StageCommand Parse(string type) => StageCommandParser.Parse(TestPaths.ReadGolden("commands/" + type + ".json")).Command;
    }

    internal static class Json
    {
        /// <summary>Structural equality in which 42 and 42.0 are the same number (the wire does not tell them apart).</summary>
        public static bool Same(JToken a, JToken b)
        {
            if (a is JObject oa && b is JObject ob)
            {
                var na = oa.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
                var nb = ob.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();
                return na.SequenceEqual(nb) && na.All(n => Same(oa[n], ob[n]));
            }
            if (a is JArray aa && b is JArray ab) return aa.Count == ab.Count && aa.Zip(ab, Same).All(x => x);
            if (a is JValue va && b is JValue vb)
            {
                var numeric = new[] { JTokenType.Integer, JTokenType.Float };
                if (numeric.Contains(va.Type) && numeric.Contains(vb.Type)) return Math.Abs(va.Value<double>() - vb.Value<double>()) < 1e-9;
            }
            return JToken.DeepEquals(a, b);
        }
    }

    public class EventTests
    {
        private static readonly Dictionary<string, Func<StageEvent>> Built = new Dictionary<string, Func<StageEvent>>
        {
            ["hello"] = () => new HelloEvent
            {
                StageClockMs = 1234.5,
                Capabilities = new StageCapabilities
                {
                    EngineVersion = "6000.0.0f1",
                    RigFamilies = new List<string> { "vrm1" },
                    Face = new FaceCapabilities { Arkit52 = true, Visemes = false, AudioToFaceOnStage = false },
                    Render = new RenderCapabilities { StrandHair = false, ClothSim = false, RuntimeAssetLoading = true, EmbeddedStream = false },
                    Tracking = new TrackingCapabilities(),
                    Constructs = new List<string>(),
                    MaxCharacters = 2,
                },
            },
            ["asset.loaded"] = () => new AssetLoadedEvent { AssetId = "asset.base.vrm", Ms = 42 },
            ["asset.failed"] = () => new AssetFailedEvent { AssetId = "asset.base.vrm", Reason = "file not found" },
            ["speak.started"] = () => new SpeakStartedEvent { UtteranceId = "utt-0001", StageMs = 2000 },
            ["speak.ended"] = () => new SpeakEndedEvent { UtteranceId = "utt-0001", StageMs = 3200, Interrupted = false },
            ["command.done"] = () => new CommandDoneEvent { Id = "cmd-001" },
            ["command.failed"] = () => new CommandFailedEvent { Id = "cmd-001", Reason = "rig family custom is not supported" },
            ["user.presence"] = () => new UserPresenceEvent { Present = true, LookingAtScreen = true, Distance = "near" },
            ["user.presence.minimal"] = () => new UserPresenceEvent { Present = false },
            ["object.clicked"] = () => new ObjectClickedEvent { ObjectId = "obj.chair", Button = "primary" },
            ["character.interact"] = () => new CharacterInteractEvent { CharacterId = "char.assistant", Region = "hand", Kind = "click" },
            ["construct.clicked"] = () => new ConstructClickedEvent { ConstructId = "construct.brain", ItemId = "n1" },
            ["construct.terminal.input"] = () => new ConstructTerminalInputEvent { ConstructId = "construct.term", Data = "ls\r" },
            ["construct.terminal.resize"] = () => new ConstructTerminalResizeEvent { ConstructId = "construct.term", Cols = 120, Rows = 32 },
            ["perf"] = () => new PerfEvent { Fps = 142.5, GpuMs = 3.2, VramMb = 2100 },
            ["error"] = () => new ErrorEvent { Message = "loader crashed", Fatal = false },
        };

        [Fact]
        public void EveryGoldenEventIsExactlyWhatTheClientWrites_KeyForKey()
        {
            var files = TestPaths.GoldenFiles("events");
            Assert.Equal(Built.Count, files.Length);
            foreach (var file in files)
            {
                var name = Path.GetFileNameWithoutExtension(file);
                Assert.True(Built.ContainsKey(name), "no C# event is built for " + name);
                var golden = JToken.Parse(File.ReadAllText(file));
                var written = JToken.Parse(StageJson.Serialize(Built[name]()));
                Assert.True(Json.Same(golden, written), name + "\n golden : " + golden.ToString(Newtonsoft.Json.Formatting.None) + "\n written: " + written.ToString(Newtonsoft.Json.Formatting.None));
            }
        }

        [Fact]
        public void OptionalFieldsAreLeftOutRatherThanWrittenAsNull()
        {
            var j = JObject.Parse(StageJson.Serialize(new UserPresenceEvent { Present = false }));
            Assert.Equal(new[] { "type", "present" }, j.Properties().Select(p => p.Name).ToArray());
        }
    }
}
