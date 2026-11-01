// The constants of mira-stage/1. The contract lives in packages/shared/src/stage.ts (zod) and the reference binary codec
// in packages/stage-core/src/protocol/frames.ts; this file must say the same thing. Written for C# 9 and .NET Standard 2.1
// (Unity 6), with no reference to UnityEngine, so it compiles and is tested outside Unity.
namespace Mira.Stage
{
    public static class StageProtocol
    {
        public const string Version = "mira-stage/1";
        public const int DefaultPort = 7421;
        public const string WebSocketPath = "/ws/stage";

        /// <summary>A stage clock is milliseconds on the stage's own clock; above 2^50 it is a broken clock.</summary>
        public const double ClockMaxMs = 1125899906842624.0;

        /// <summary>[kind:u8][utteranceIdHash:u32][tStartMs:f64], little-endian.</summary>
        public const int FrameHeaderBytes = 13;
        public const int ArkitCount = 52;
        public const int FaceFrameBytes = ArkitCount * 4;
        public const double FaceFps = 30.0;
        public const int AudioSampleRate = 24000;
        public const int MaxFrameBytes = 1 << 20;
        public const int MaxAudioPayloadBytes = 96000;
        public const int MaxFaceFramesPerMessage = 300;

        /// <summary>The 52 ARKit blendshapes in the canonical order of a face frame (tongueOut is the 52nd).</summary>
        public static readonly string[] Arkit52 =
        {
            "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft", "browOuterUpRight",
            "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
            "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight", "eyeLookInLeft", "eyeLookInRight",
            "eyeLookOutLeft", "eyeLookOutRight", "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
            "eyeWideLeft", "eyeWideRight",
            "jawForward", "jawLeft", "jawOpen", "jawRight",
            "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft", "mouthFrownRight", "mouthFunnel",
            "mouthLeft", "mouthLowerDownLeft", "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker",
            "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower", "mouthShrugUpper",
            "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft", "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight",
            "noseSneerLeft", "noseSneerRight", "tongueOut",
        };

        /// <summary>The wardrobe slots, in the order of the contract.</summary>
        public static readonly string[] WardrobeSlots =
        {
            "hair", "hairAccessory", "headwear", "glasses", "earrings", "neck", "top", "bottom",
            "fullBody", "outerwear", "legwear", "footwear", "gloves", "wristwear", "back", "tail",
        };
    }
}
