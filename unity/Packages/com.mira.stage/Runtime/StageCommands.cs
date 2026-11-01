// Commands: backend to stage (StageCommand in packages/shared/src/stage.ts). One class per command the Unity stage
// implements; everything else (furniture, data constructs, terminal panes, interaction) arrives as UnsupportedCommand and
// is answered with command.failed, exactly as the simulator stage answers what it cannot do.
using System;
using System.Collections.Generic;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Mira.Stage
{
    public abstract class StageCommand
    {
        public string Id { get; set; }
        public abstract string Type { get; }
        /// <summary>Stage-clock time the command should take effect; null means now.</summary>
        public double? AtMs { get; set; }
        /// <summary>Which character; null means the assistant character.</summary>
        public string CharacterId { get; set; }
    }

    public sealed class CharacterLoad : StageCommand
    {
        public override string Type => "character.load";
        public CharacterProfile Character { get; set; }
        public List<StageAsset> Assets { get; set; } = new List<StageAsset>();
    }

    public sealed class CharacterParams : StageCommand
    {
        public override string Type => "character.params";
        public Dictionary<string, JToken> Params { get; set; } = new Dictionary<string, JToken>();
        public double BlendMs { get; set; }
    }

    public sealed class CharacterEquip : StageCommand
    {
        public override string Type => "character.equip";
        public string Slot { get; set; }
        /// <summary>The asset to wear in the slot; null empties the slot.</summary>
        public string AssetId { get; set; }
        public StageAsset Asset { get; set; }
    }

    public sealed class CharacterOutfit : StageCommand
    {
        public override string Type => "character.outfit";
        public OutfitPreset Preset { get; set; }
        public List<StageAsset> Assets { get; set; } = new List<StageAsset>();
    }

    public sealed class SceneLoad : StageCommand
    {
        public override string Type => "scene.load";
        public StageScene Scene { get; set; }
        public List<StageAsset> Assets { get; set; } = new List<StageAsset>();
    }

    public sealed class SceneCamera : StageCommand
    {
        public override string Type => "scene.camera";
        public string CameraId { get; set; }
        public double BlendMs { get; set; } = 600;
    }

    public sealed class SceneLighting : StageCommand
    {
        public override string Type => "scene.lighting";
        public LightingPreset Lighting { get; set; }
    }

    /// <summary>Start an utterance. Its audio and face frames follow as binary frames tagged with the utterance id's hash.</summary>
    public sealed class PerformSpeak : StageCommand
    {
        public override string Type => "perform.speak";
        public string UtteranceId { get; set; }
        public string Text { get; set; }
        public string Emotion { get; set; }
        public List<EmotionPoint> EmotionTimeline { get; set; } = new List<EmotionPoint>();
        public AudioSpec Audio { get; set; }
        /// <summary>"stage" (compute the face from the audio) or "backend" (face frames arrive).</summary>
        public string FaceSource { get; set; }
    }

    public sealed class PerformCancel : StageCommand
    {
        public override string Type => "perform.cancel";
        public string UtteranceId { get; set; }
        public double FadeMs { get; set; } = 120;
    }

    public sealed class PerformAffect : StageCommand
    {
        public override string Type => "perform.affect";
        public Affect Affect { get; set; }
        public double BlendMs { get; set; } = 400;
    }

    public sealed class PerformGesture : StageCommand
    {
        public override string Type => "perform.gesture";
        public string Clip { get; set; }
        public double Intensity { get; set; } = 0.7;
        public string TargetObjectId { get; set; }
    }

    public sealed class PerformGaze : StageCommand
    {
        public override string Type => "perform.gaze";
        public GazeTarget Target { get; set; }
        public double Speed { get; set; } = 0.6;
        public bool Saccades { get; set; } = true;
    }

    public sealed class PerformPosture : StageCommand
    {
        public override string Type => "perform.posture";
        /// <summary>stand, sit, lean, lie, sleep or walk.</summary>
        public string Posture { get; set; }
        public string AnchorObjectId { get; set; }
        public string AnchorId { get; set; }
    }

    public sealed class PerformIdle : StageCommand
    {
        public override string Type => "perform.idle";
        /// <summary>attentive, relaxed, busy, sleepy or asleep.</summary>
        public string Profile { get; set; }
    }

    /// <summary>A command this stage does not implement, or one the contract added after this client was written.</summary>
    public sealed class UnsupportedCommand : StageCommand
    {
        private readonly string _type;
        public UnsupportedCommand(string type) { _type = type; }
        public override string Type => _type;
        /// <summary>Whether the contract knows the type at all (a known one is simply not implemented here).</summary>
        public bool Known { get; set; }
        public JObject Raw { get; set; }
    }

    /// <summary>The outcome of parsing one text frame.</summary>
    public sealed class ParsedCommand
    {
        public StageCommand Command { get; set; }
        /// <summary>The command id when the frame had one, even if the rest was unusable (so command.failed can name it).</summary>
        public string Id { get; set; }
        public string Error { get; set; }
        public bool Ok => Command != null;
    }

    public static class StageCommandParser
    {
        /// <summary>Command types of the contract that this stage does not implement.</summary>
        private static readonly HashSet<string> KnownUnsupported = new HashSet<string>
        {
            "scene.object", "scene.construct", "scene.data", "construct.terminal.write", "perform.interact",
        };

        public static ParsedCommand Parse(string json)
        {
            JObject jo;
            try
            {
                var token = JToken.Parse(json);
                jo = token as JObject;
                if (jo == null) return new ParsedCommand { Error = "invalid command: not an object" };
            }
            catch (JsonException)
            {
                return new ParsedCommand { Error = "invalid JSON" };
            }

            var id = jo.Value<string>("id");
            var type = jo.Value<string>("type");
            if (string.IsNullOrEmpty(type)) return new ParsedCommand { Id = id, Error = "invalid command: type is missing" };
            if (string.IsNullOrEmpty(id)) return new ParsedCommand { Error = "invalid command: id is missing" };

            try
            {
                StageCommand cmd = type switch
                {
                    "character.load" => jo.ToObject<CharacterLoad>(StageJson.Serializer),
                    "character.params" => jo.ToObject<CharacterParams>(StageJson.Serializer),
                    "character.equip" => jo.ToObject<CharacterEquip>(StageJson.Serializer),
                    "character.outfit" => jo.ToObject<CharacterOutfit>(StageJson.Serializer),
                    "scene.load" => jo.ToObject<SceneLoad>(StageJson.Serializer),
                    "scene.camera" => jo.ToObject<SceneCamera>(StageJson.Serializer),
                    "scene.lighting" => jo.ToObject<SceneLighting>(StageJson.Serializer),
                    "perform.speak" => jo.ToObject<PerformSpeak>(StageJson.Serializer),
                    "perform.cancel" => jo.ToObject<PerformCancel>(StageJson.Serializer),
                    "perform.affect" => jo.ToObject<PerformAffect>(StageJson.Serializer),
                    "perform.gesture" => jo.ToObject<PerformGesture>(StageJson.Serializer),
                    "perform.gaze" => jo.ToObject<PerformGaze>(StageJson.Serializer),
                    "perform.posture" => jo.ToObject<PerformPosture>(StageJson.Serializer),
                    "perform.idle" => jo.ToObject<PerformIdle>(StageJson.Serializer),
                    _ => new UnsupportedCommand(type) { Known = KnownUnsupported.Contains(type), Raw = jo },
                };
                if (cmd == null) return new ParsedCommand { Id = id, Error = "invalid command: empty" };
                cmd.Id = id;
                var problem = Validate(cmd);
                return problem == null ? new ParsedCommand { Command = cmd, Id = id } : new ParsedCommand { Id = id, Error = "invalid command: " + problem };
            }
            catch (Exception e) when (e is JsonException || e is InvalidCastException || e is FormatException)
            {
                var why = e.Message.Length > 120 ? e.Message.Substring(0, 120) : e.Message;
                return new ParsedCommand { Id = id, Error = "invalid command: " + why };
            }
        }

        /// <summary>The fields the client itself relies on. The daemon validates the rest before it sends.</summary>
        private static string Validate(StageCommand c)
        {
            switch (c)
            {
                case CharacterLoad l:
                    if (l.Character == null || string.IsNullOrEmpty(l.Character.Id)) return "character is missing";
                    return null;
                case CharacterParams p:
                    if (string.IsNullOrEmpty(p.CharacterId)) return "characterId is missing";
                    return null;
                case CharacterEquip e:
                    if (string.IsNullOrEmpty(e.CharacterId) || string.IsNullOrEmpty(e.Slot)) return "characterId or slot is missing";
                    return null;
                case CharacterOutfit o:
                    if (o.Preset == null) return "preset is missing";
                    return null;
                case SceneLoad s:
                    if (s.Scene == null) return "scene is missing";
                    return null;
                case SceneCamera cam:
                    if (string.IsNullOrEmpty(cam.CameraId)) return "cameraId is missing";
                    return null;
                case SceneLighting lt:
                    if (lt.Lighting == null) return "lighting is missing";
                    return null;
                case PerformSpeak sp:
                    if (string.IsNullOrEmpty(sp.UtteranceId)) return "utteranceId is missing";
                    if (sp.Audio == null) return "audio is missing";
                    return null;
                case PerformCancel pc:
                    if (string.IsNullOrEmpty(pc.UtteranceId)) return "utteranceId is missing";
                    return null;
                case PerformAffect af:
                    if (af.Affect == null) return "affect is missing";
                    return null;
                case PerformGaze g:
                    if (g.Target == null || string.IsNullOrEmpty(g.Target.Kind)) return "target is missing";
                    return null;
                default:
                    return null;
            }
        }
    }
}
