// Events: stage to backend (StageEvent in packages/shared/src/stage.ts). Each class carries its own "type"; serialize with
// StageJson.Serialize. The golden examples under Tests~/golden/events pin the exact shape, key for key.
using Newtonsoft.Json;

namespace Mira.Stage
{
    public abstract class StageEvent
    {
        [JsonProperty("type", Order = -2)]
        public abstract string Type { get; }
    }

    public sealed class HelloEvent : StageEvent
    {
        public override string Type => "hello";
        public string Protocol { get; set; } = StageProtocol.Version;
        public StageCapabilities Capabilities { get; set; }
        public double StageClockMs { get; set; }
    }

    public sealed class AssetLoadedEvent : StageEvent
    {
        public override string Type => "asset.loaded";
        public string AssetId { get; set; }
        public double Ms { get; set; }
    }

    public sealed class AssetFailedEvent : StageEvent
    {
        public override string Type => "asset.failed";
        public string AssetId { get; set; }
        public string Reason { get; set; }
    }

    public sealed class SpeakStartedEvent : StageEvent
    {
        public override string Type => "speak.started";
        public string UtteranceId { get; set; }
        public double StageMs { get; set; }
    }

    public sealed class SpeakEndedEvent : StageEvent
    {
        public override string Type => "speak.ended";
        public string UtteranceId { get; set; }
        public double StageMs { get; set; }
        public bool Interrupted { get; set; }
    }

    public sealed class CommandDoneEvent : StageEvent
    {
        public override string Type => "command.done";
        public string Id { get; set; }
    }

    public sealed class CommandFailedEvent : StageEvent
    {
        public override string Type => "command.failed";
        public string Id { get; set; }
        public string Reason { get; set; }
    }

    /// <summary>Presence from the camera, computed on the stage. Never carries image data.</summary>
    public sealed class UserPresenceEvent : StageEvent
    {
        public override string Type => "user.presence";
        public bool Present { get; set; }
        public bool? LookingAtScreen { get; set; }
        /// <summary>near, mid or far.</summary>
        public string Distance { get; set; }
    }

    public sealed class ObjectClickedEvent : StageEvent
    {
        public override string Type => "object.clicked";
        public string ObjectId { get; set; }
        /// <summary>primary or secondary.</summary>
        public string Button { get; set; } = "primary";
    }

    /// <summary>The user touched the character: region level only, the backend applies her boundaries.</summary>
    public sealed class CharacterInteractEvent : StageEvent
    {
        public override string Type => "character.interact";
        public string CharacterId { get; set; }
        /// <summary>head, hand, shoulder or body.</summary>
        public string Region { get; set; }
        /// <summary>click, drag or wave.</summary>
        public string Kind { get; set; }
    }

    public sealed class ConstructClickedEvent : StageEvent
    {
        public override string Type => "construct.clicked";
        public string ConstructId { get; set; }
        public string ItemId { get; set; }
    }

    public sealed class ConstructTerminalInputEvent : StageEvent
    {
        public override string Type => "construct.terminal.input";
        public string ConstructId { get; set; }
        public string Data { get; set; }
    }

    public sealed class ConstructTerminalResizeEvent : StageEvent
    {
        public override string Type => "construct.terminal.resize";
        public string ConstructId { get; set; }
        public int Cols { get; set; }
        public int Rows { get; set; }
    }

    /// <summary>Report 0 for a figure the engine cannot measure.</summary>
    public sealed class PerfEvent : StageEvent
    {
        public override string Type => "perf";
        public double Fps { get; set; }
        public double GpuMs { get; set; }
        public double VramMb { get; set; }
    }

    public sealed class ErrorEvent : StageEvent
    {
        public override string Type => "error";
        public string Message { get; set; }
        public bool Fatal { get; set; }
    }
}
